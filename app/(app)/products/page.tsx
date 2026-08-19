import { limitsFor } from "@/lib/limits";
import { pluginSupportsProductEditing } from "@/lib/plugin-support";
import { getSettings } from "@/lib/settings";
import { listStores, toPublic } from "@/lib/stores";
import { requireView } from "@/lib/view";

import { ProductsView } from "./products-view";

export const dynamic = "force-dynamic";

/**
 * Product management for a customer account.
 *
 * Three things are resolved here rather than in the browser, and each for a reason:
 *
 *  - the account's PERMISSION, so the screen opens read-only rather than offering
 *    buttons the route will refuse. The route is still the boundary — see
 *    `checkProductEdit` — this only stops the interface from lying;
 *  - the PLUGIN BUILD per site, because an older plugin does not refuse the search
 *    filter, it ignores it, and a screen that presented the whole catalogue as a
 *    search result would be worse than one that refused to open;
 *  - the account's display CURRENCY, so prices are labelled the way the rest of the
 *    app labels them.
 *
 * There is deliberately no product data here. The first list is fetched by the
 * client once a site is chosen: reading somebody's catalogue on every page load,
 * including the loads where they came here to look at a different site, is a request
 * to a live shop for nothing.
 */
export default async function ProductsPage() {
  const { ownerId, user, actingAs } = await requireView();

  const [stores, limits, settings] = await Promise.all([
    listStores(ownerId),
    limitsFor(ownerId),
    getSettings(ownerId),
  ]);

  return (
    <ProductsView
      stores={stores.map((store) => ({
        ...toPublic(store),
        // Computed on the server so the message names the version the site actually
        // reported, rather than the client guessing from a failed request.
        support: pluginSupportsProductEditing(store),
      }))}
      canEdit={limits.productEditEnabled}
      canRemove={limits.removeEnabled}
      /*
       * An administrator in their OWN account gets a read-only screen.
       *
       * The same rule Import and Remove follow: an administrator account operates the
       * service and does not publish products of its own. Inside a customer's account
       * `actingAs` is set and the screen is fully live, because working on a
       * customer's behalf is support work and the change belongs to them.
       *
       * The navigation already hides this screen in that state; this is the second
       * half, so a bookmarked URL behaves the same way. The routes are the actual
       * boundary — `refusePublishingAsAdmin` — and answer 403 regardless.
       */
      operatorOnly={user.role === "admin" && actingAs === null}
      currency={settings.displayCurrency ?? ""}
    />
  );
}
