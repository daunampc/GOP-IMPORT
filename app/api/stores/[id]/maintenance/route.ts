import { clientFor, getStoreUnscoped } from "@/lib/stores";
import { GopApiError } from "@/lib/gop-client";
import { apiRequireOwned } from "@/lib/ownership";

/**
 * Maintenance actions called straight through the plugin.
 *
 * Exactly one for now: clearing WooCommerce's transients. It used to happen
 * only automatically, after a run finished, so when category pages showed the
 * wrong prices there was no button to press — it meant going into wp-admin.
 *
 * The Maintenance tab in wp-admin also recalculates min/max price for variable
 * products (`admin/Actions.php::fixPrices`), but that has NO HTTP route in
 * `index.php`, so this app cannot reach it.
 */
const ACTIONS = ["clear-transients"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(
  request: Request,
  context: RouteContext<"/api/stores/[id]/maintenance">,
) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("store", id);
  if (!guard.ok) {
    return guard.response;
  }

  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  const action = body.action;

  if (typeof action !== "string" || !(ACTIONS as ReadonlyArray<string>).includes(action)) {
    return Response.json(
      { error: `\`action\` must be one of: ${ACTIONS.join(", ")}` },
      { status: 400 },
    );
  }

  const store = await getStoreUnscoped(id);
  if (store === null) {
    return Response.json({ error: "No such site" }, { status: 404 });
  }

  const startedAt = Date.now();

  try {
    const client = await clientFor(store);

    switch (action as Action) {
      case "clear-transients": {
        const result = await client.clearTransients();
        return Response.json({
          ok: result.cleared,
          elapsedMs: Date.now() - startedAt,
          message: result.cleared
            ? "WooCommerce transients cleared. Reload a category page on the site to see the right prices."
            : "The plugin answered with something unexpected.",
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof GopApiError ? error.status : 502;

    return Response.json({ error: message }, { status: status === 200 ? 502 : status });
  }
}
