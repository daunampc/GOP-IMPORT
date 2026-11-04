import { readFile } from "node:fs/promises";

import { latestPluginPackage } from "@/lib/plugin-package.server";
import { apiRequireView } from "@/lib/view";

/**
 * The plugin, as an installable zip.
 *
 * Behind sign-in like everything else: the plugin is the licensed half of the
 * product, and an anonymous link would hand it to anybody who guessed the path. It
 * contains no secrets — `build.sh` refuses to package a `config.ini` — so the only
 * thing being protected is who may have it.
 *
 * Read into memory rather than streamed: it is about 400 KB, and one allocation of
 * that is simpler than a stream whose failure halfway would hand somebody a
 * truncated zip that WordPress then rejects with an unhelpful message.
 */
export async function GET() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const pack = await latestPluginPackage();
  if (pack === null) {
    return Response.json(
      { error: "This installation has no plugin package to download." },
      { status: 404 },
    );
  }

  const bytes = await readFile(pack.file);

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${pack.name}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
