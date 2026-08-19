import { getJobProducts, getJobState, getResults } from "@/lib/jobs";
import { adminProductUrl, getStoreUnscoped } from "@/lib/stores";
import { apiRequireOwned } from "@/lib/ownership";

/**
 * Exporting the results to CSV.
 *
 * The results are joined back to the source products so each row stands on its
 * own: with only `index` and `product_id`, opening the file tells you nothing
 * about which row was which product.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/jobs/[id]/results/export">,
) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  const job = await getJobState(id);
  if (job === null) {
    return Response.json({ error: "No such run" }, { status: 404 });
  }

  const [allResults, products, store] = await Promise.all([
    getResults(id, 0, 100_000),
    getJobProducts(id),
    getStoreUnscoped(job.storeId),
  ]);

  /*
   * `?only=failed` exports JUST the rows that failed.
   *
   * The whole-run export answers "what happened"; this one answers "what do I have
   * to deal with". They are different jobs, and on a 5,000-product run with 47
   * failures the second is the only one anybody can actually work from — finding 47
   * rows by scrolling a 5,000-row spreadsheet is not working from it.
   *
   * The file is deliberately a list of the ORIGINAL products, so it can be fixed in
   * a spreadsheet and imported again as a source file. "Resend the failures" on the
   * run screen is the other route, and the two are for different situations: resend
   * when the site was at fault, re-import when the DATA was.
   */
  const onlyFailed = new URL(request.url).searchParams.get("only") === "failed";
  const results = onlyFailed ? allResults.filter((result) => !result.ok) : allResults;

  /*
   * Two extra columns for the write modes, and the first one is the whole reason
   * this export matters for them.
   *
   * A run that repriced 3,000 products is the ONLY record anywhere of what those
   * prices were: the site has overwritten them and nothing else in this app kept
   * them. `gia_cu` carries the old price out into a spreadsheet, which is what makes
   * a mistaken bulk change recoverable by hand.
   *
   * Added unconditionally rather than only for update runs: a CSV whose columns
   * change shape depending on the run is a CSV nobody can build a template against.
   * They are simply empty on an import or a removal.
   */
  const header = [
    "dong",
    "trang_thai",
    "ten_san_pham",
    "sku",
    "slug",
    "product_id",
    "so_bien_the",
    "trung_khoa",
    "gia_cu",
    "da_doi",
    "ma_loi",
    "thong_bao_loi",
    "link_quan_tri",
  ];

  const lines = [header.join(",")];

  for (const result of results) {
    const product = products[result.index];

    const status = !result.ok
      ? "loi"
      : result.action === "updated"
        ? result.deduplicated
          ? "khong_doi"
          : "da_cap_nhat"
        : result.deduplicated
          ? "trung_khoa"
          : "tao_moi";

    // The price this row REPLACED, whichever of the two price fields moved.
    const previousPrice =
      result.changed?.regular_price?.from ?? result.changed?.price?.from ?? "";

    lines.push(
      [
        result.index + 1,
        status,
        product?.name ?? "",
        result.sku ?? product?.sku ?? "",
        product?.slug ?? "",
        result.product_id ?? "",
        result.variation_ids?.length ?? 0,
        result.deduplicated ? "1" : "0",
        Array.isArray(previousPrice) ? previousPrice.join(" | ") : previousPrice,
        // Which fields moved, so a reader can tell a price-only sync from one that
        // also rewrote categories.
        Object.keys(result.changed ?? {}).join(" "),
        result.error?.code ?? "",
        result.error?.message ?? "",
        result.product_id && store ? adminProductUrl(store, result.product_id) : "",
      ]
        .map(csvCell)
        .join(","),
    );
  }

  // A BOM at the front: without it Excel on Windows reads UTF-8 as mojibake, and
  // Excel is exactly what this file gets opened in.
  const body = `﻿${lines.join("\r\n")}\r\n`;

  const stamp = (job.finishedAt ?? job.createdAt).slice(0, 19).replace(/[:T]/g, "-");
  const prefix = onlyFailed ? "loi" : "ket-qua";

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${prefix}-${stamp}-${id.slice(0, 8)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

function csvCell(value: string | number): string {
  const text = String(value);
  // Quote on commas, quotes and newlines — error messages tend to contain all three.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
