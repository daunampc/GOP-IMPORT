import { z } from "zod";

import { GopApiError, MAX_LOOKUP_PAGE } from "@/lib/gop-client";
import { createdProductIds, getJobState } from "@/lib/jobs";
import { pluginSupportsNoImageFilter } from "@/lib/plugin-support";
import { purgeSelectionSchema, type PurgeSelection } from "@/lib/purge-options";
import { ownerOf } from "@/lib/ownership";
import { clientFor, getStore } from "@/lib/stores";
import { apiRequireView } from "@/lib/view";

/**
 * What would this selection remove?
 *
 * A separate call from the removal itself, on purpose. The operator confirms
 * the LIST they were shown, not the filter that produced it — a category that
 * gains a product between looking and pressing must not quietly take that
 * product with it.
 *
 * Answers with TWO things, and the difference between them is the point:
 *
 *  - `lookup.products`: a page of full detail, capped by the plugin at 500. For
 *    reading. Nobody reviews 3000 rows, and the summary is what makes a page
 *    expensive.
 *  - `ids`: EVERY id the selection matched. For executing. This is what the run
 *    is built from, so one confirmation removes everything that matched instead
 *    of the first page of it.
 *
 * The safety property survives intact, because it was never about the size of
 * the list: a filter is still not what executes. The ids are resolved once,
 * here, at the moment of looking; the operator confirms that known, counted
 * set; and the plugin's delete route still refuses to accept a filter at all.
 */

const bodySchema = z.object({
  storeId: z.string().min(1, "Pick a site first"),
  selection: purgeSelectionSchema,
  /** How many rows of full detail to show. Not how many the run covers. */
  limit: z.coerce.number().int().min(1).max(MAX_LOOKUP_PAGE).default(200),
  /**
   * Narrow the selection to products with NO image.
   *
   * A narrowing, exactly like the plugin treats it: it never replaces the selection,
   * so "products with no image" still has to say WHERE — a category, a run, or
   * explicitly the whole site. On its own it would be a filter that means everything,
   * which is the shape this screen refuses everywhere else.
   */
  withoutImages: z.boolean().default(false),
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

  const { storeId, selection, limit, withoutImages } = parsed.data;

  const store = await getStore(storeId, guard.ownerId);
  if (store === null) {
    return Response.json({ error: "No such site. Reload the site list." }, { status: 404 });
  }

  /*
   * The version gate, and it is not belt-and-braces.
   *
   * A plugin older than 3.7.0 does not refuse `without_images` — it IGNORES it. So
   * against such a site this request would answer with the whole catalogue, under a
   * heading saying these products have no picture, and the next press would delete
   * them. Refused with the version named instead.
   */
  if (withoutImages) {
    const support = pluginSupportsNoImageFilter(store);

    if (!support.ok) {
      return Response.json({ error: support.message, code: "plugin_too_old" }, { status: 502 });
    }
  }

  let filter: Record<string, unknown>;

  try {
    filter = await toFilter(selection, guard.ownerId);

    if (withoutImages) {
      filter.without_images = true;
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  try {
    const client = await clientFor(store);

    // Both from the same filter at the same moment. The page is what the
    // operator reads; the ids are what the run is built from.
    const [found, everything] = await Promise.all([
      client.lookupProducts({ ...filter, limit }),
      client.lookupProductIds(filter),
    ]);

    return Response.json({
      lookup: found,
      ids: everything.ids,
      // `everything.total` is the authority on the size of the selection, and
      // the confirm step quotes it. `ids.length` can be smaller only when the
      // catalogue is larger than the plugin's ceiling, and `truncated` says so
      // rather than letting a run quietly cover less than it claims.
      total: everything.total,
      truncated: everything.truncated,
    });
  } catch (error) {
    if (error instanceof GopApiError) {
      return Response.json({ error: error.message, code: error.code }, { status: 502 });
    }
    throw error;
  }
}

/**
 * Turn a selection into the plugin's filter.
 *
 * "One import run" is resolved HERE rather than on the site: the app already
 * recorded every product id the plugin handed back, so the plugin needs to know
 * nothing about runs, and a run that touched several sites still only removes
 * from the site being pointed at.
 */
async function toFilter(
  selection: PurgeSelection,
  ownerId: string,
): Promise<Record<string, unknown>> {
  switch (selection.kind) {
    // Already a list of ids: the product screen ticked them, so there is no filter
    // to evaluate and nothing to re-derive. This is the shape every other branch is
    // trying to reach.
    case "ids":
      return { product_ids: selection.productIds };

    case "run": {
      // "Everything one import run created" resolves a RUN ID that arrived in
      // the body, so it needs the same ownership rule as any [id] route —
      // otherwise a pasted id turns another customer's run into a list of
      // product ids to delete.
      const owner = await ownerOf("job", selection.runId);

      if (owner === null || owner !== ownerId) {
        throw new Error("That import run no longer exists.");
      }

      const run = await getJobState(selection.runId);

      if (run === null) {
        throw new Error("That import run no longer exists.");
      }

      const ids = await createdProductIds(selection.runId);

      if (ids.length === 0) {
        throw new Error("That run created no products, so there is nothing to remove.");
      }

      return { product_ids: ids };
    }

    case "skus":
      return { skus: selection.skus };

    case "category":
      return { category: selection.category };

    case "all":
      return { all: true };
  }
}
