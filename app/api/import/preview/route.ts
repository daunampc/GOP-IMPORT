import { BuildError, buildProductsFromRequest } from "@/lib/build-products";
import { warningsFor } from "@/lib/import-options";
import { listJobs } from "@/lib/jobs";
import {
  countImages,
  findDuplicateSkus,
  savePreview,
  toRows,
} from "@/lib/preview";
import { computeStats, estimateDuration } from "@/lib/stats";
import { apiRequireView } from "@/lib/view";

/**
 * Building the preview.
 *
 * Runs EXACTLY the pipeline the real import runs, stores the result and returns
 * an id. "Start" then points at that id rather than rebuilding from the file —
 * which is what makes the preview literally what gets published, random slug
 * suffix included.
 */
export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const built = await buildProductsFromRequest(request);

    const duplicateSkus = findDuplicateSkus(built.products);
    const rows = toRows(built.products, duplicateSkus, built.generatedSku);
    const images = countImages(built.products);

    const meta = await savePreview(
      {
        sourceLabel: built.sourceLabel,
        dialect: built.dialect,
        columns: built.columns,
        signature: built.signature,
        options: built.options,
        total: built.products.length,
        images,
        warnings: [...built.warnings, ...warningsFor(built.options)],
        errors: built.errors,
        skippedRows: built.skippedRows,
        duplicateSkus,
        rows,
      },
      built.products,
      guard.ownerId,
    );

    // The estimate uses speeds MEASURED from history rather than an invented
    // constant. With no history it answers `basis: "default"` so the UI can say
    // plainly that this is a guess.
    // Measured from THIS account's history. Another customer's throughput
    // against another customer's sites says nothing about how long this run
    // will take, and would be a small leak of their activity besides.
    const stats = computeStats(await listJobs(guard.ownerId, 200));
    const estimate = estimateDuration(
      built.products.length,
      built.options.threads,
      built.options.batchSize,
      stats.avgBatchMs,
    );

    return Response.json({ preview: meta, estimate });
  } catch (error) {
    if (error instanceof BuildError) {
      return Response.json(
        { error: error.message, columns: error.columns },
        { status: error.status },
      );
    }
    throw error;
  }
}
