import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The plugin version this app expects.
 *
 * Read from the plugin's `version.txt` rather than hard-coded: a hard-coded
 * string drifts on the very next release, and a wrong "this site is out of date"
 * warning is worse than no warning at all.
 *
 * The plugin used to live in the repository ABOVE this app, so a single
 * `../../version.txt` was enough. It now has its own checkout beside it, which
 * silently broke this: the file was never found, the function always answered
 * `null`, and the Sites screen showed "the current plugin version could not be
 * read" permanently — so the outdated-build warning had quietly stopped existing.
 *
 * Hence a list of candidates rather than one path, newest layout first, with
 * `PLUGIN_DIR` honoured because `tests/e2e.sh` already uses that name for the
 * same thing.
 *
 * `null` still means "unknown", and the UI stays quiet rather than guessing.
 */

let cached: string | null | undefined;

/** Cleared by the tests; nothing in the app needs to call this. */
export function resetPluginVersionCache(): void {
  cached = undefined;
}

function candidates(): string[] {
  const found: string[] = [];

  const configured = process.env.PLUGIN_DIR?.trim();
  if (configured) {
    found.push(path.resolve(configured, "version.txt"));
  }

  // The current layout: clients/manager-push-product-wordpress inside one
  // checkout, with the plugin's checkout a sibling of that checkout's root.
  found.push(path.resolve(process.cwd(), "..", "..", "..", "GPM_toshstack", "version.txt"));

  // The old layout, when this app was a folder inside the plugin repository.
  found.push(path.resolve(process.cwd(), "..", "..", "version.txt"));

  return found;
}

export async function expectedPluginVersion(): Promise<string | null> {
  if (cached !== undefined) {
    return cached;
  }

  // GOP_PLUGIN_VERSION is the documented name — it is what the Sites screen tells
  // the operator to set. TSD_PLUGIN_VERSION is read after it only so that anyone
  // who set the old name during the rename is not silently ignored.
  const override =
    process.env.GOP_PLUGIN_VERSION?.trim() || process.env.TSD_PLUGIN_VERSION?.trim();

  if (override) {
    cached = override;
    return cached;
  }

  for (const candidate of candidates()) {
    try {
      const raw = await readFile(candidate, "utf8");
      const trimmed = raw.trim();
      if (trimmed !== "") {
        cached = trimmed;
        return cached;
      }
    } catch {
      // Not at this path — try the next.
    }
  }

  cached = null;
  return cached;
}
