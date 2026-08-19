import { z } from "zod";

import { GopApiError, type ProductUpdate } from "@/lib/gop-client";
import { checkProductEdit } from "@/lib/limits";
import { refuseUnsupportedPlugin } from "@/lib/plugin-support";
import { clientFor, getStore } from "@/lib/stores";
import { apiRequireView, refusePublishingAsAdmin } from "@/lib/view";

/**
 * Change ONE product, now, without a run.
 *
 * Deliberately synchronous and deliberately not a run. A run exists to give
 * progress, a log, Cancel and Stop to work that takes minutes and must survive the
 * browser closing; one product takes one request. Wrapping it in the queue would be
 * ceremony rather than safety, and it would put a single price correction on the
 * Activity screen between two 14,000-product imports.
 *
 * A BULK edit is the opposite and goes through `POST /api/products/bulk`, which
 * creates a real run. The line between the two is exactly the line between "I can
 * see the whole change on screen" and "I cannot".
 *
 * Every field is optional and only what is PRESENT is written — the same contract
 * the plugin route makes. The screen sends only the fields the operator actually
 * touched, so opening a drawer and changing the price writes the price.
 */

const bodySchema = z.object({
  storeId: z.string().min(1, "Pick a site first"),
  /**
   * Addressed by id, which is the only key that always works: a product with no SKU
   * has nothing else, and two sharing a SKU are refused rather than guessed at.
   */
  productId: z.coerce.number().int().positive(),

  /*
   * `.optional()` throughout, and never `.default()`.
   *
   * This is the whole partial-update contract expressed in the schema: a default
   * would turn "the operator did not touch this field" into a value, and a default
   * of `""` would turn it into "clear it on purpose". A field the browser did not
   * send must not reach the plugin at all.
   */
  name: z.string().trim().min(1, "A product must have a name").optional(),
  status: z.enum(["publish", "draft", "pending", "private", "future"]).optional(),
  /** `""` clears the field on purpose. That is a real, reachable state. */
  regularPrice: z.union([z.coerce.number().min(0), z.literal("")]).optional(),
  salePrice: z.union([z.coerce.number().min(0), z.literal("")]).optional(),
  /** A quantity, or `""` to stop managing stock — not the same as a quantity of 0. */
  stock: z.union([z.coerce.number().int().min(0), z.literal("")]).optional(),
  categories: z.array(z.string().trim().min(1)).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
});

export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  // An administrator account does not publish products of its own — it operates the
  // service. Inside a customer's account it may, and the change belongs to them.
  // The navigation hides this screen; this line is what makes it true.
  const refusal = refusePublishingAsAdmin(guard);
  if (refusal !== null) {
    return refusal;
  }

  // Its own switch. A bulk edit that goes wrong reprices a catalogue and overwrites
  // the only copy of what the prices were, so an operator can withhold this while
  // still allowing imports.
  const allowed = await checkProductEdit(guard.ownerId, { count: 1, threads: 1 });
  if (!allowed.ok) {
    return allowed.response;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const body = parsed.data;

  const store = await getStore(body.storeId, guard.ownerId);
  if (store === null) {
    return Response.json({ error: "No such site. Reload the site list." }, { status: 404 });
  }

  const unsupported = refuseUnsupportedPlugin(store);
  if (unsupported !== null) {
    return unsupported;
  }

  /*
   * Built by PRESENCE, one key at a time.
   *
   * Not a spread of the parsed body: that would carry `undefined` values into the
   * JSON, and while `JSON.stringify` drops them, relying on that to hold the
   * partial-update contract is relying on a serialisation detail for the one
   * property the whole feature rests on. Written out, it is checkable by reading.
   */
  const update: ProductUpdate = { product_id: body.productId };

  if (body.name !== undefined) {
    update.name = body.name;
  }
  if (body.status !== undefined) {
    update.status = body.status;
  }
  if (body.regularPrice !== undefined) {
    update.regular_price = body.regularPrice === "" ? "" : String(body.regularPrice);
  }
  if (body.salePrice !== undefined) {
    update.sale_price = body.salePrice === "" ? "" : String(body.salePrice);
  }
  if (body.stock !== undefined) {
    update.stock = body.stock === "" ? "" : body.stock;
  }
  if (body.categories !== undefined) {
    update.categories = body.categories;
  }
  if (body.tags !== undefined) {
    update.tags = body.tags;
  }

  // Only the match key: nothing to write. Answering "nothing changed" is more useful
  // than inventing a failure, and the screen already disables Save in this state.
  if (Object.keys(update).length === 1) {
    return Response.json({ ok: true, changed: {}, productId: body.productId });
  }

  try {
    const client = await clientFor(store);
    const [result] = await client.updateProducts([update]);

    if (result === undefined) {
      return Response.json({ error: "The site answered with no result row." }, { status: 502 });
    }

    if (!result.ok) {
      /*
       * A per-row refusal is the operator's problem to act on, not a server fault, so
       * it answers 400 with the plugin's own code and message intact. `ambiguous_sku`,
       * `slug_taken`, `sku_taken` and `not_found` each need a different action, and
       * flattening them into "could not save" would remove the only part worth
       * reading.
       */
      return Response.json(
        { error: result.error?.message ?? "The site refused the change.", code: result.error?.code },
        { status: 400 },
      );
    }

    return Response.json({
      ok: true,
      productId: result.product_id ?? body.productId,
      sku: result.sku ?? "",
      isVariation: result.is_variation ?? false,
      /** Only the fields whose stored value genuinely differed. Possibly empty. */
      changed: result.changed ?? {},
    });
  } catch (error) {
    if (error instanceof GopApiError) {
      return Response.json({ error: error.message, code: error.code }, { status: 502 });
    }
    throw error;
  }
}
