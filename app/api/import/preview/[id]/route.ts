import { getPreview, getPreviewProducts } from "@/lib/preview";
import { apiRequireOwned } from "@/lib/ownership";

/**
 * Re-read a preview, or the full detail of ONE row.
 *
 * Row detail is fetched through `?index=` rather than shipped with everything:
 * 5000 products with variations and meta is tens of megabytes, while the detail
 * drawer only ever shows one row.
 */
export async function GET(request: Request, context: RouteContext<"/api/import/preview/[id]">) {
  const { id } = await context.params;

  // A staged preview is a whole product file — someone's catalogue, prices and
  // supplier image URLs. Another account's answers 404.
  const guard = await apiRequireOwned("preview", id);
  if (!guard.ok) {
    return guard.response;
  }

  const preview = await getPreview(id);
  if (preview === null) {
    return Response.json(
      { error: "This preview has expired (they are kept for an hour). Read the file again." },
      { status: 404 },
    );
  }

  const rawIndex = new URL(request.url).searchParams.get("index");
  if (rawIndex === null) {
    return Response.json({ preview });
  }

  const index = Number.parseInt(rawIndex, 10);
  if (Number.isNaN(index) || index < 0) {
    return Response.json({ error: "`index` is not valid." }, { status: 400 });
  }

  const products = await getPreviewProducts(id);
  const product = products?.[index];

  if (product === undefined) {
    return Response.json({ error: "There is no row at that position." }, { status: 404 });
  }

  return Response.json({ index, product });
}
