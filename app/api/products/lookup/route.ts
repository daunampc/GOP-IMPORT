import { z } from "zod";

import { GopApiError, MAX_LOOKUP_PAGE } from "@/lib/gop-client";
import { pluginSupportsNoImageFilter, refuseUnsupportedPlugin } from "@/lib/plugin-support";
import { clientFor, getStore, storeLabel } from "@/lib/stores";
import { apiRequireView } from "@/lib/view";

/**
 * One page of a site's catalogue, for the product-management screen.
 *
 * The honesty rule this route exists to keep: **the page is never presented as
 * everything.** The plugin caps a summary lookup at 500 products because the
 * per-product summary is what makes a page expensive, and that cap is real and
 * stays. So the answer always carries `total` — how many the filter matched on the
 * site — beside `products.length`, and the screen says both. Reporting only what
 * came back is the specific bug the removal flow already had to fix once, and it is
 * not being reintroduced here.
 *
 * The FILTERING is server-side for the same reason. A screen that searched only the
 * rows it had loaded would have a search box that silently misses everything past
 * the first page — which reads, to whoever uses it, exactly like a product that is
 * not on the site.
 *
 * Read-only, so it goes through `apiRequireView` and no capability switch: looking
 * at your own catalogue is not a dangerous act, and an account whose editing has
 * been switched off can still find a product and open it in wp-admin.
 */

const bodySchema = z.object({
  storeId: z.string().min(1, "Pick a site first"),

  /** Free text, matched against the product name on the site. */
  search: z.string().trim().default(""),
  /** Exact SKUs. Takes precedence over `search` — it is a lookup, not a filter. */
  skus: z.array(z.string().trim().min(1)).default([]),
  category: z.string().trim().default(""),
  status: z.enum(["publish", "draft", "pending", "private", "future"]).optional(),

  limit: z.coerce.number().int().min(1).max(MAX_LOOKUP_PAGE).default(100),
  offset: z.coerce.number().int().min(0).default(0),

  /**
   * Also resolve EVERY matching id, not just this page.
   *
   * What makes "select the whole filter" possible: a bulk edit built from the ids
   * the filter matched at the moment of looking, rather than from the page that
   * happened to be on screen. Asked for explicitly because it is a second query.
   */
  withIds: z.boolean().default(false),

  /**
   * Only products with no image — plugin 3.7.0 and newer.
   *
   * Gated separately below rather than folded into the screen's own version gate: a
   * site on 3.2.0 can still be searched and edited, and refusing all of that because
   * one newer filter is unavailable would be the gate overreaching. What must not
   * happen is this key being SENT to a build that ignores it and answering with the
   * whole catalogue under a heading that says otherwise.
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

  const { storeId, search, skus, category, status, limit, offset, withIds , withoutImages } = parsed.data;

  // Scoped: a site id belonging to another account answers exactly as an id that
  // does not exist. 404, never 403 — a 403 would confirm the id is real.
  const store = await getStore(storeId, guard.ownerId);
  if (store === null) {
    return Response.json({ error: "No such site. Reload the site list." }, { status: 404 });
  }

  /*
   * The plugin build, checked BEFORE the request goes out.
   *
   * Not belt-and-braces. An older plugin does not refuse an unknown filter key — it
   * never looks at it — so a name search against a 3.1.0 site comes back as the whole
   * catalogue and would be presented as the search result. Failing here is the only
   * way the screen can tell "no such product" from "your plugin is old".
   */
  const unsupported = refuseUnsupportedPlugin(store);
  if (unsupported !== null) {
    return unsupported;
  }

  /*
   * The filter handed to the plugin.
   *
   * `skus` is a SELECTION and wins outright: "find me these exact SKUs" is a
   * different act from "search the catalogue", and mixing them would make an exact
   * lookup silently subject to whatever was left in the search box.
   *
   * Otherwise the selection is `all: true` — stated explicitly, because the plugin
   * refuses a filter that does not name one, and that refusal is what stops an
   * empty filter from quietly meaning the whole catalogue.
   */
  const filter: Record<string, unknown> =
    skus.length > 0
      ? { skus }
      : {
          ...(category !== "" ? { category } : { all: true }),
          ...(search !== "" ? { name: search } : {}),
          ...(status !== undefined ? { status } : {}),
        };

  if (withoutImages) {
    const support = pluginSupportsNoImageFilter(store);

    if (!support.ok) {
      return Response.json({ error: support.message, code: "plugin_too_old" }, { status: 502 });
    }

    filter.without_images = true;
  }

  try {
    const client = await clientFor(store);

    const page = await client.lookupProducts({ ...filter, limit, offset });

    /*
     * Every matching id, for "select everything this filter matched".
     *
     * From the SAME filter at the same moment as the page above, which is what keeps
     * the promise the removal screen makes: the operator confirms a known, counted
     * set, and the run is built from those ids rather than from the filter. A product
     * that joins the filter afterwards cannot be swept along.
     */
    const everything = withIds ? await client.lookupProductIds(filter) : null;

    return Response.json({
      storeId: store.id,
      storeLabel: storeLabel(store),
      products: page.products,
      /** How many the filter matched ON THE SITE — not how many came back. */
      total: page.total,
      /** How many are in this answer. The screen says both, always. */
      shown: page.products.length,
      offset,
      limit,
      /** True when there is another page after this one. */
      more: offset + page.products.length < page.total,
      ids: everything?.ids ?? null,
      /** The plugin refused to return every id. Said, never hidden. */
      idsTruncated: everything?.truncated ?? false,
      /** The plugin's own ceiling on one summary page, so the screen can name it. */
      pageCeiling: MAX_LOOKUP_PAGE,
    });
  } catch (error) {
    if (error instanceof GopApiError) {
      if (error.code === "invalid_status") {
        return Response.json({ error: error.message, code: error.code }, { status: 400 });
      }

      return Response.json({ error: error.message, code: error.code }, { status: 502 });
    }
    throw error;
  }
}
