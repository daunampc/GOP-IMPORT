import "server-only";

import { compareVersions } from "./plugin-version";
import type { Store } from "./stores";

/**
 * The plugin build a site must be running before the product screen will act on it.
 *
 * 3.2.0 is the release that added `/products/update`, `/products/exists` and the
 * server-side `name` / `status` narrowing on `/products/lookup`.
 *
 * THIS CHECK IS NOT DEFENCE IN DEPTH — it is the only thing standing between an
 * operator and a wrong answer, and the reason is specific. An older plugin does not
 * REFUSE an unknown filter key; `buildFilter` simply never looks at it. So a search
 * for "Áo khoác" against a 3.1.0 site returns the whole catalogue, silently, and the
 * screen would present it as the search result. Every product would look like a
 * match, and "this product is not on the site" and "your plugin is old" would be
 * indistinguishable.
 *
 * The update and exists routes fail loudly by comparison — an unknown route is a
 * 404 with `unknown_route` — but they are gated here too, so the whole screen gives
 * one answer about a site rather than three different ones depending on which button
 * was pressed.
 */
export const REQUIRED_PLUGIN_VERSION = "3.2.0";

/**
 * The build that added the "no image" filter — `without_images` on the lookup.
 *
 * Gated SEPARATELY from `REQUIRED_PLUGIN_VERSION`, and separately for a reason worth
 * stating: this one feeds a DELETE, and an older plugin does not refuse an unknown
 * filter key — it ignores it. So asking a 3.6.0 site for "products with no image"
 * answers with the WHOLE CATALOGUE, and nothing in the answer says the filter was
 * dropped. An operator would be shown every product they own under a heading saying
 * these have no picture.
 *
 * A version check is the only thing standing between that and a confirmed deletion,
 * which is why it lives here rather than in a screen.
 */
export const NO_IMAGE_FILTER_VERSION = "3.7.0";

/*
 * `PluginSupport` and the image-upload gate live in `lib/plugin-version.ts`, not
 * here. This module starts with `import "server-only"`, which throws under plain
 * Node — and the worker and the import wizard both need that gate. Re-exported so
 * server-side callers still have one place to look.
 */
export {
  IMAGE_UPLOAD_VERSION,
  imageUploadSupport,
  type PluginSupport,
} from "./plugin-version";
import type { PluginSupport } from "./plugin-version";

export function pluginSupportsProductEditing(store: Store): PluginSupport {
  const installed = store.pluginVersion;

  if (installed === null || installed.trim() === "") {
    return {
      ok: false,
      installed: null,
      required: REQUIRED_PLUGIN_VERSION,
      message:
        "This site has not answered a health check yet, so which plugin build it runs is unknown. " +
        "Check the connection on the Sites screen first — this screen will not guess.",
    };
  }

  if (compareVersions(installed, REQUIRED_PLUGIN_VERSION) < 0) {
    return {
      ok: false,
      installed,
      required: REQUIRED_PLUGIN_VERSION,
      message:
        `This site runs plugin ${installed}, and managing products needs ${REQUIRED_PLUGIN_VERSION}. ` +
        `Older builds do not have the update route at all, and — worse — they IGNORE the search ` +
        `filter rather than refusing it, so a search would quietly return the whole catalogue and ` +
        `look like it had matched everything. Update the plugin on that site.`,
    };
  }

  return { ok: true, installed, required: REQUIRED_PLUGIN_VERSION, message: null };
}

/**
 * May this site be asked for products with no image?
 *
 * Deliberately NOT folded into `pluginSupportsProductEditing`: a site on 3.2.0 can
 * still be searched, edited and have products removed, and refusing all of that
 * because one newer filter is unavailable would be the gate overreaching. What must
 * not happen is this filter being SENT to a build that would ignore it.
 */
export function pluginSupportsNoImageFilter(store: Store): PluginSupport {
  const installed = store.pluginVersion;

  if (installed === null || installed.trim() === "") {
    return {
      ok: false,
      installed: null,
      required: NO_IMAGE_FILTER_VERSION,
      message:
        `This site has not answered a health check yet, so which plugin build it runs is unknown, ` +
        `and finding products with no image needs ${NO_IMAGE_FILTER_VERSION}. An older build does ` +
        `not refuse the filter — it IGNORES it — so guessing would risk answering with the whole ` +
        `catalogue. Check the connection on the Sites screen first.`,
    };
  }

  if (compareVersions(installed, NO_IMAGE_FILTER_VERSION) < 0) {
    return {
      ok: false,
      installed,
      required: NO_IMAGE_FILTER_VERSION,
      message:
        `This site runs plugin ${installed}, and finding products with no image needs ` +
        `${NO_IMAGE_FILTER_VERSION}. An older build does not refuse the filter — it IGNORES it — so ` +
        `the answer would be the whole catalogue presented as products without a picture. Update ` +
        `the plugin on that site.`,
    };
  }

  return { ok: true, installed, required: NO_IMAGE_FILTER_VERSION, message: null };
}

/** Route-handler form: a refusal shaped so a handler can return it. */
export function refuseUnsupportedPlugin(store: Store): Response | null {
  const support = pluginSupportsProductEditing(store);

  if (support.ok) {
    return null;
  }

  return Response.json(
    {
      error: support.message,
      code: "plugin_too_old",
      installed: support.installed,
      required: support.required,
    },
    { status: 409 },
  );
}
