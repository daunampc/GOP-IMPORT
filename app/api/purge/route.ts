import { z } from "zod";

import { enqueuePurge, type JobState } from "@/lib/jobs";
import {
  CONFIRM_PHRASE,
  describeSelection,
  purgeNeedsConfirmation,
  purgeOptionsSchema,
} from "@/lib/purge-options";
import { checkRemove } from "@/lib/limits";
import { getStore, storeLabel } from "@/lib/stores";
import { apiRequireView, refusePublishingAsAdmin } from "@/lib/view";

/**
 * Start a removal run.
 *
 * Takes the explicit list of products the operator was shown and confirmed —
 * not the filter. Everything about this route is built on that: the filter has
 * already done its job by the time we get here.
 *
 * The body carries the list in two parts, which is what lets ONE run cover the
 * WHOLE selection while the screen still only renders a readable page:
 *
 *  - `ids`: every product id the selection matched, resolved at lookup time.
 *    This is the run.
 *  - `products`: full detail — sku and name — for the rows that were actually
 *    displayed. Once a product is deleted its result row is the only surviving
 *    record of what it was, so the detail is kept where it exists.
 *
 * Ids with no matching detail are staged as bare ids. `getPurgeItems()` already
 * reads those back as `{ product_id, sku: "", name: "" }` — the payload has
 * always tolerated that shape — so a run of 3000 stages 3000 entries of which
 * the first few hundred carry names, rather than 3000 fabricated ones.
 *
 * The staged list goes to `job_item`, which exists precisely so a multi-megabyte
 * payload does not sit in the `job` row that every queue listing reads.
 */

const bodySchema = z.object({
  options: purgeOptionsSchema,
  /** Full detail for the rows that were displayed. May be a subset of `ids`. */
  products: z
    .array(
      z.object({
        product_id: z.coerce.number().int().positive(),
        sku: z.string().default(""),
        name: z.string().default(""),
      }),
    )
    .default([]),
  /**
   * Every id the selection matched. Optional so an older client that only sends
   * `products` still works — it simply removes what it showed, as before.
   */
  ids: z.array(z.coerce.number().int().positive()).default([]),
  /** Required for the selections that can empty a catalogue in one press. */
  confirmPhrase: z.string().default(""),
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

  // The most dangerous capability in the product, so it has its own switch.
  const allowed = await checkRemove(guard.ownerId);
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

  const { options, products, ids, confirmPhrase } = parsed.data;

  // The staged list: every matched id, in order, carrying detail wherever the
  // screen had it. Deduplicated because the same product must not be handed to
  // the plugin twice — the second delete would report `not_found` and the run
  // would look as though it half failed.
  const detail = new Map(products.map((product) => [product.product_id, product]));
  const ordered = ids.length > 0 ? ids : products.map((product) => product.product_id);

  const items = [...new Set(ordered)].map(
    (productId) => detail.get(productId) ?? { product_id: productId, sku: "", name: "" },
  );

  if (items.length === 0) {
    return Response.json({ error: "Nothing selected to remove." }, { status: 400 });
  }

  /*
   * Checked on the server as well as in the form: a typed confirmation that exists
   * only in the browser protects against a slip of the mouse and against nothing
   * else.
   *
   * The gate now depends on the SIZE of an explicitly-ticked list as well as on the
   * kind of selection.
   *
   * The two filter selections are unconditional and unchanged — a filter is a
   * description, and the operator cannot see what it caught. A list ticked on the
   * product screen is different in kind, because those rows were on screen; but only
   * up to the point where "selected" stopped meaning "read", which is why it is
   * counted rather than trusted.
   *
   * `items.length` and not the posted count: the number checked here is the number
   * that will actually be deleted.
   */
  if (
    purgeNeedsConfirmation(options.selection.kind, items.length) &&
    confirmPhrase !== CONFIRM_PHRASE
  ) {
    return Response.json(
      { error: `Type ${CONFIRM_PHRASE} to confirm a removal of this size.` },
      { status: 400 },
    );
  }

  const store = await getStore(options.storeId, guard.ownerId);
  if (store === null) {
    return Response.json({ error: "No such site. Reload the site list." }, { status: 404 });
  }

  const job: JobState = await enqueuePurge({
    storeId: store.id,
    storeUrl: store.url,
    storeLabel: storeLabel(store),
    sourceLabel: describeSelection(options.selection),
    // The account on screen, not the signed-in user — see app/api/import.
    createdBy: guard.ownerId,
    options,
    products: items,
  });

  return Response.json({ job }, { status: 202 });
}
