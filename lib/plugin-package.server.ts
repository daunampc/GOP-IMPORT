import "server-only";

import { readdir } from "node:fs/promises";
import path from "node:path";

import { compareVersions } from "./plugin-version";

/**
 * The plugin build this app hands out.
 *
 * A zip in `plugin/` beside the app, named `gop-import-<version>.zip` exactly as the
 * plugin repository's `build.sh` names it — so releasing is copying the new zip in,
 * and the version is read from the NAME rather than from a second place that can
 * drift from the file.
 *
 * Several may sit in the folder; the highest version wins, so an old zip left behind
 * is harmless. `PLUGIN_ZIP_DIR` moves the folder, for a deployment that keeps it
 * outside the checkout.
 *
 * `null` means no package is available, and the download button stays hidden rather
 * than offering a link that 404s.
 */

export interface PluginPackage {
  version: string;
  /** Absolute path to the zip. */
  file: string;
  /** The download's file name. */
  name: string;
}

const NAME = /^gop-import-(\d+\.\d+\.\d+)\.zip$/;

function directory(): string {
  const configured = process.env.PLUGIN_ZIP_DIR?.trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), "plugin");
}

export async function latestPluginPackage(): Promise<PluginPackage | null> {
  const dir = directory();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  let best: PluginPackage | null = null;

  for (const name of entries) {
    const match = NAME.exec(name);
    if (match === null) {
      continue;
    }

    if (best === null || compareVersions(match[1], best.version) > 0) {
      best = { version: match[1], file: path.join(dir, name), name };
    }
  }

  return best;
}
