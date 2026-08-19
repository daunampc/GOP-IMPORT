import { z } from "zod";

import { GopApiError } from "@/lib/gop-client";
import { ownerOf } from "@/lib/ownership";
import { getPreview, getPreviewProducts } from "@/lib/preview";
import { planUpdate } from "@/lib/product-update";
import { clientFor, getStore, storeLabel } from "@/lib/stores";
import { apiRequireView } from "@/lib/view";

/**
 * How many of this file's rows are ALREADY on the site — asked before the run.
 *
 * The gap this closes: `lib/preview.ts` has `findDuplicateSkus`, which finds SKUs
 * repeated INSIDE the file, and nothing anywhere asked the site whether those SKUs
 * already existed on it. So a file whose products were all already published
 * imported as a second set of products — a different idempotency key means a
 * different product — and the operator discovered it afterwards, by finding the
 * catalogue doubled.
 *
 * "A number that arrives after the run is not a preview." This route is what makes
 * the sentence "1,240 rows: 1,198 already on the site and would be updated, 42
 * new" appear BEFORE anything is pressed.
 *
 * Answered per SITE, because it is a question about a site: the same file against
 * two shops has two different answers, and a preview that averaged them would be
 * worse than no preview.
 */

const bodySchema = z.object({
  previewId: z.string().min(1, "Missing the preview id"),
  storeId: z.string().min(1, "Pick a site first"),
  /**
   * How many example rows to name. Only for the screen — the counts always cover
   * every row.
   */
  examples: z.coerce.number().int().min(0).max(50).default(20),
});

export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const { previewId, storeId, examples } = parsed.data;

  // The preview id arrives in the BODY, so it does not pass through the `[id]`
  // guard — checked here with the same rule and the same 404, exactly as
  // `POST /api/import` does. A staged preview is somebody's whole catalogue.
  const previewOwner = await ownerOf("preview", previewId);
  if (previewOwner !== null && previewOwner !== guard.ownerId) {
    return Response.json({ error: "No such preview" }, { status: 404 });
  }

  const preview = await getPreview(previewId);
  const products = await getPreviewProducts(previewId);

  if (preview === null || products === null) {
    return Response.json(
      {
        error:
          "This preview has expired (they are kept for an hour). Read the file again and preview it.",
      },
      { status: 409 },
    );
  }

  // Scoped: a site id belonging to another account must answer exactly as an id
  // that does not exist.
  const store = await getStore(storeId, guard.ownerId);
  if (store === null) {
    return Response.json({ error: "No such site. Reload the site list." }, { status: 404 });
  }

  /*
   * What a re-sync WOULD write, worked out from the staged products themselves.
   *
   * `planUpdate` is the same function the run will use, so the per-field counts on
   * screen are the fields that actually get written — not a separate description of
   * them that can drift. It is also where the rows with no SKU are counted: nothing
   * can match those, so no update can ever cover them.
   */
  const plan = planUpdate(products);
  const skus = plan.updates
    .map((update) => update.sku)
    .filter((sku): sku is string => sku !== undefined);

  if (skus.length === 0) {
    return Response.json({
      storeId: store.id,
      storeLabel: storeLabel(store),
      total: products.length,
      existing: 0,
      missing: products.length,
      withoutSku: plan.withoutSku,
      fields: plan.fields,
      examples: [],
      checkedAt: new Date().toISOString(),
    });
  }

  try {
    const client = await clientFor(store);
    const answer = await client.productsExist(skus);

    const bySku = new Map(answer.found.map((entry) => [entry.sku, entry]));

    /*
     * Example rows: the file's own value beside what is on the site right now.
     *
     * A count alone cannot catch the mistake that matters — the right NUMBER of
     * rows matching for the wrong reason. Seeing "AO-001 — 199,000 on the site,
     * 219,000 in the file" against a name you recognise is what confirms the file
     * is the price list you think it is.
     */
    const shown: Array<{
      sku: string;
      name: string;
      productId: number;
      isVariation: boolean;
      currentPrice: string;
      filePrice: string;
      status: string;
    }> = [];

    for (const update of plan.updates) {
      if (shown.length >= examples) {
        break;
      }

      const found = update.sku === undefined ? undefined : bySku.get(update.sku);

      if (found === undefined) {
        continue;
      }

      shown.push({
        sku: found.sku,
        name: found.name,
        productId: found.product_id,
        isVariation: found.is_variation,
        currentPrice: found.price,
        filePrice: String(update.sale_price ?? update.regular_price ?? update.price ?? ""),
        status: found.status,
      });
    }

    return Response.json({
      storeId: store.id,
      storeLabel: storeLabel(store),
      total: products.length,
      /** Rows the site already has, and which an update would therefore cover. */
      existing: answer.found.length,
      /**
       * Rows the site does NOT have. Counted from the file rather than from the
       * site's answer, so the rows with no SKU are inside it — they are new
       * whichever way you look at them, because nothing can match them.
       */
      missing: products.length - answer.found.length,
      withoutSku: plan.withoutSku,
      fields: plan.fields,
      examples: shown,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof GopApiError) {
      // `unknown_route` is the honest answer for a site still on an older plugin,
      // and the message has to say that rather than reading as a broken site.
      if (error.code === "unknown_route") {
        return Response.json(
          {
            error:
              `${storeLabel(store)} is running a plugin build without \`/products/exists\`. ` +
              `Update the plugin on that site to check what is already there before a run, ` +
              `and to use the create-or-update modes at all.`,
            code: "plugin_too_old",
          },
          { status: 502 },
        );
      }

      return Response.json({ error: error.message, code: error.code }, { status: 502 });
    }
    throw error;
  }
}
