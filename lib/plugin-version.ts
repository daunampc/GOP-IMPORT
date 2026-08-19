/**
 * Plugin version comparison.
 *
 * This file deliberately touches NO `node:fs`: it is imported from Client
 * Components (to colour the out-of-date warning) as well as from the server.
 * Reading `version.txt` lives in `lib/plugin-version.server.ts`.
 */

/** Compared segment by segment, not as strings — "3.10.0" is newer than "3.9.0". */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(".")
      .map((part) => {
        const parsed = Number.parseInt(part, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
      });

  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }

  return 0;
}

export function isOutdated(installed: string | null, expected: string | null): boolean {
  if (!installed || !expected) {
    return false;
  }
  return compareVersions(installed, expected) < 0;
}

/**
 * The build that moved image downloading OFF the site — `POST /images/upload`.
 *
 * It lives HERE rather than beside the other gates in `lib/plugin-support.ts`
 * because the import wizard has to grey the option out before a run is started, and
 * that is a Client Component — `plugin-support.ts` imports "server-only" and cannot
 * be reached from one. `plugin-support.ts` re-exports this and builds the sentences
 * an operator reads; the bare fact of which version is needed belongs where both
 * sides can see it, rather than being written as "3.9.0" in two places.
 */
export const IMAGE_UPLOAD_VERSION = "3.9.0";

/** True when this site can be sent image bytes to write. Null means "unknown". */
export function supportsImageUpload(pluginVersion: string | null | undefined): boolean {
  if (pluginVersion === null || pluginVersion === undefined || pluginVersion.trim() === "") {
    return false;
  }

  return compareVersions(pluginVersion, IMAGE_UPLOAD_VERSION) >= 0;
}

/** A gate's verdict, with the sentence an operator reads. */
export interface PluginSupport {
  ok: boolean;
  installed: string | null;
  required: string;
  message: string | null;
}

/**
 * May this site be sent image bytes to write, and if not, what does the operator
 * need to be told?
 *
 * This lives HERE rather than with the other two gates in `lib/plugin-support.ts`,
 * and the reason is a hard constraint rather than taste: that module starts with
 * `import "server-only"`, which throws under plain Node. The **worker** needs this
 * verdict, and `lib/stores.ts` and `lib/jobs.ts` both carry a comment saying not to
 * add that import for exactly this reason. Putting it there crashed the worker on
 * startup, and `tests/e2e.sh` caught it.
 *
 * Takes the version string rather than a `Store` so it stays free of that module's
 * dependencies, which is what makes it reachable from the import wizard too.
 *
 * Only the `upload_site` image mode needs this. `keep_remote` writes external URLs
 * and downloads nothing; `s3` puts the bytes in a bucket and never asks the site to
 * store a file. Both work against any supported build.
 */
export function imageUploadSupport(pluginVersion: string | null): PluginSupport {
  if (pluginVersion === null || pluginVersion.trim() === "") {
    return {
      ok: false,
      installed: null,
      required: IMAGE_UPLOAD_VERSION,
      message:
        `This site has not answered a health check yet, so which plugin build it runs is unknown, ` +
        `and copying images into the media library needs ${IMAGE_UPLOAD_VERSION}. Check the ` +
        `connection on the Sites screen, or start the run with a different image mode.`,
    };
  }

  if (!supportsImageUpload(pluginVersion)) {
    return {
      ok: false,
      installed: pluginVersion,
      required: IMAGE_UPLOAD_VERSION,
      message:
        `This site runs plugin ${pluginVersion}, and copying images into its media library needs ` +
        `${IMAGE_UPLOAD_VERSION}. From that build the app downloads each image and sends the bytes ` +
        `to the site, instead of asking the site's PHP to fetch them — which is what used to hold ` +
        `PHP processes open long enough to take a shop offline mid-import. Update the plugin on ` +
        `that site, or start this run with a different image mode.`,
    };
  }

  return { ok: true, installed: pluginVersion, required: IMAGE_UPLOAD_VERSION, message: null };
}
