import { z } from "zod";

import {
  EDIT_CONFIRM_PHRASE,
  PREVIEW_EXAMPLES,
  describeEdit,
  editOperationSchema,
  needsTypedConfirmation,
  resolveEdit,
  type EditItem,
  type EditOperation,
  type PricedProduct,
} from "@/lib/edit-options";
import { GopApiError, MAX_LOOKUP_PAGE, MAX_UPDATE_BATCH } from "@/lib/gop-client";
import { enqueueEdit, type JobState } from "@/lib/jobs";
import { checkProductEdit } from "@/lib/limits";
import { refuseUnsupportedPlugin } from "@/lib/plugin-support";
import { getSettings } from "@/lib/settings";
import { clientFor, getStore, storeLabel } from "@/lib/stores";
import { apiRequireView, refusePublishingAsAdmin } from "@/lib/view";

/**
 * A bulk edit: preview it, then run it.
 *
 * ONE route with two actions on purpose, because the two must not be able to
 * disagree. `preview` resolves the selection into a list of absolute values;
 * `run` takes that same list and stages it. Both go through `resolveEdit`, so the
 * number on the confirmation screen is arithmetically the number the worker sends —
 * not a second implementation of the same sum.
 *
 * The property everything else rests on, and it is the removal screen's property
 * applied here: **a filter is never what executes.** The filter produces a list of
 * ids, those ids are resolved into per-product values, the operator reads those
 * values, and the run is built from them. Two consequences that matter on a live
 * shop:
 *
 *  - a product somebody else reprices between looking and pressing is not swept
 *    along at a number nobody reviewed;
 *  - a product that joins the filter in that window is not taken along at all.
 *
 * `run` re-resolves from the ids rather than trusting a list of values posted by the
 * browser. A client-supplied "set this to 219000" would be an open invitation to
 * write any number to any product, and the confirmation the operator read would
 * prove nothing about what was sent.
 */

const selectionSchema = z.object({
  /** Explicit ids — what the operator ticked, or what a filter resolved to. */
  productIds: z.array(z.coerce.number().int().positive()).min(1, "Nothing selected"),
});

const bodySchema = z.object({
  action: z.enum(["preview", "run"]),
  storeId: z.string().min(1, "Pick a site first"),
  selection: selectionSchema,
  operation: editOperationSchema,
  /** Required by `run` when the change cannot be read row by row. See §2 of the design. */
  confirmPhrase: z.string().default(""),
  threads: z.coerce.number().int().min(1).max(32).default(4),
});

export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const refusal = refusePublishingAsAdmin(guard);
  if (refusal !== null) {
    return refusal;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const { action, storeId, selection, operation, confirmPhrase, threads } = parsed.data;
  const productIds = [...new Set(selection.productIds)];

  /*
   * Checked for BOTH actions, and the ceiling is checked on the preview too.
   *
   * Refusing at the run alone would let an operator read a confirmation for 5,000
   * products and be told only at the last press that their account allows 1,000 —
   * after they had done the work of reviewing it.
   */
  const allowed = await checkProductEdit(guard.ownerId, { count: productIds.length, threads });
  if (!allowed.ok) {
    return allowed.response;
  }

  const store = await getStore(storeId, guard.ownerId);
  if (store === null) {
    return Response.json({ error: "No such site. Reload the site list." }, { status: 404 });
  }

  const unsupported = refuseUnsupportedPlugin(store);
  if (unsupported !== null) {
    return unsupported;
  }

  let current: PricedProduct[];

  try {
    current = await readProducts(store, productIds);
  } catch (error) {
    if (error instanceof GopApiError) {
      return Response.json({ error: error.message, code: error.code }, { status: 502 });
    }
    throw error;
  }

  /*
   * Products that were selected and are no longer there.
   *
   * Said rather than quietly dropped. "3,340 products" on a confirmation and 3,338
   * in the results is the kind of small discrepancy that costs an hour to explain,
   * and somebody deleting a product between two screens is ordinary.
   */
  const found = new Set(current.map((product) => product.product_id));
  const vanished = productIds.filter((id) => !found.has(id));

  const resolved = current.map((product) => resolveEdit(product, operation));

  const items: EditItem[] = [];
  const refused: Array<{ productId: number; name: string; sku: string; reason: string }> = [];

  for (const outcome of resolved) {
    if (outcome.ok) {
      items.push(outcome.item);
    } else {
      refused.push({
        productId: outcome.product.product_id,
        name: outcome.product.name,
        sku: outcome.product.sku,
        reason: outcome.reason,
      });
    }
  }

  if (action === "preview") {
    return Response.json(previewBody(operation, items, refused, vanished, productIds.length));
  }

  /* -------------------------------------------------------------------- run */

  if (items.length === 0) {
    return Response.json(
      {
        error:
          "Nothing left to change: every selected product was refused. See the reasons in the " +
          "preview.",
      },
      { status: 400 },
    );
  }

  /*
   * The typed phrase, checked HERE as well as in the form.
   *
   * A confirmation that exists only in the browser protects against a slip of the
   * mouse and against nothing else. The rule is re-derived from the operation and
   * the real count, so a client that lies about either gets the stricter answer
   * rather than the one it asked for.
   */
  if (
    needsTypedConfirmation(operation, items.length) &&
    confirmPhrase.trim() !== EDIT_CONFIRM_PHRASE
  ) {
    return Response.json(
      {
        error:
          `Type ${EDIT_CONFIRM_PHRASE} to confirm a change of this kind. ` +
          `${items.length.toLocaleString("en-GB")} products would be changed.`,
        code: "confirmation_required",
      },
      { status: 400 },
    );
  }

  // The currency the operator was reading, copied onto the run. Display only — it
  // reaches no site — but it is what keeps a results table read next month labelled
  // the way it was labelled when somebody pressed the button.
  const settings = await getSettings(guard.ownerId);

  const job: JobState = await enqueueEdit({
    storeId: store.id,
    storeUrl: store.url,
    storeLabel: storeLabel(store),
    sourceLabel: describeEdit(operation),
    // The ACCOUNT ON SCREEN, not the signed-in user: an administrator working inside
    // a member's account has created the member's run.
    createdBy: guard.ownerId,
    options: {
      storeId: store.id,
      operation,
      threads,
      batchSize: MAX_UPDATE_BATCH,
      displayCurrency: settings.displayCurrency ?? "",
    },
    products: items,
  });

  return Response.json({ job, changing: items.length, refused: refused.length }, { status: 202 });
}

/**
 * Read the selected products' CURRENT state from the site.
 *
 * By id, in pages of the plugin's own ceiling. The ceiling is real and stays — what
 * changes is that this pages THROUGH it rather than quietly covering the first 500,
 * which is the bug the removal flow already had to fix once.
 */
async function readProducts(
  store: Awaited<ReturnType<typeof getStore>> & object,
  productIds: number[],
): Promise<PricedProduct[]> {
  const client = await clientFor(store);
  const out: PricedProduct[] = [];

  for (let offset = 0; offset < productIds.length; offset += MAX_LOOKUP_PAGE) {
    const chunk = productIds.slice(offset, offset + MAX_LOOKUP_PAGE);

    const page = await client.lookupProducts({
      product_ids: chunk,
      limit: MAX_LOOKUP_PAGE,
    });

    for (const product of page.products) {
      out.push({
        product_id: product.product_id,
        sku: product.sku,
        name: product.name,
        status: product.status,
        price: product.price,
        regular_price: product.regular_price,
        sale_price: product.sale_price,
        stock: product.stock,
      });
    }
  }

  return out;
}

/**
 * The preview body.
 *
 * The counts are computed over EVERY resolved row; only the examples are trimmed.
 * A figure computed over the twenty shown rows and presented as a summary of 3,340
 * would be a lie in the one place it matters most — see the `lowest`/`highest` pair,
 * whose whole purpose is to catch a percentage typed with the decimal point in the
 * wrong place.
 */
function previewBody(
  operation: EditOperation,
  items: EditItem[],
  refused: Array<{ productId: number; name: string; sku: string; reason: string }>,
  vanished: number[],
  selected: number,
) {
  const newPrices = items
    .map((item) => item.set.regular_price ?? item.set.sale_price)
    .filter((value): value is string => value !== undefined)
    .map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value));

  return {
    description: describeEdit(operation),
    selected,
    /** Rows that would actually be written. */
    changing: items.length,
    /** Rows refused, with the reason each — never silently dropped. */
    refused,
    /** Selected but no longer on the site. */
    vanished,
    /**
     * The extremes across the WHOLE selection.
     *
     * This pair is what catches `-90` typed for `-9`: the individual rows all look
     * plausible on their own, and only the lowest and highest numbers in the set
     * show what the operation really did.
     */
    lowest: newPrices.length > 0 ? Math.min(...newPrices) : null,
    highest: newPrices.length > 0 ? Math.max(...newPrices) : null,
    /**
     * Rows that would end with a sale price at or above the regular price.
     *
     * A warning, not a refusal: WooCommerce permits it, so it is pointless rather
     * than wrong, and refusing something legal would be this screen overreaching.
     */
    saleAboveRegular: items.filter((item) => {
      const sale = item.set.sale_price ?? item.was.sale_price;
      const regular = item.set.regular_price ?? item.was.regular_price;

      if (sale === "" || regular === "") {
        return false;
      }

      return Number.parseFloat(sale) >= Number.parseFloat(regular);
    }).length,
    needsConfirmation: needsTypedConfirmation(operation, items.length),
    confirmPhrase: EDIT_CONFIRM_PHRASE,
    /** The first rows in full, with the real numbers. Everything else is counted. */
    examples: items.slice(0, PREVIEW_EXAMPLES),
    exampleLimit: PREVIEW_EXAMPLES,
  };
}
