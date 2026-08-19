import { deleteCsvMap, getCsvMap, saveCsvMap } from "@/lib/csv-maps";
import { apiRequireView } from "@/lib/view";

/**
 * Remembered CSV column mappings, keyed by the signature of a file's header row.
 *
 * Remembered per FORMAT, not per file: two exports from the same system share a
 * header row, so a mapping corrected once is reapplied automatically next time.
 *
 * And per ACCOUNT: the signature is a hash of the header row, so two customers
 * exporting from the same platform collide on it while meaning different things.
 */

export async function GET(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const signature = new URL(request.url).searchParams.get("signature");

  if (signature === null || signature === "") {
    return Response.json({ error: "`signature` is required." }, { status: 400 });
  }

  return Response.json({ map: await getCsvMap(guard.ownerId, signature) });
}

export async function PUT(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const body = (await request.json().catch(() => null)) as {
    signature?: unknown;
    dialect?: unknown;
    columnMap?: unknown;
  } | null;

  if (
    body === null ||
    typeof body.signature !== "string" ||
    body.signature === "" ||
    (body.dialect !== "shopify" && body.dialect !== "woocommerce") ||
    typeof body.columnMap !== "object" ||
    body.columnMap === null
  ) {
    return Response.json(
      { error: "`signature`, `dialect` and `columnMap` are required." },
      { status: 400 },
    );
  }

  const map = await saveCsvMap(
    guard.ownerId,
    body.signature,
    body.dialect,
    body.columnMap as Record<string, string>,
  );

  return Response.json({ map });
}

export async function DELETE(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const signature = new URL(request.url).searchParams.get("signature");

  if (signature === null || signature === "") {
    return Response.json({ error: "`signature` is required." }, { status: 400 });
  }

  await deleteCsvMap(guard.ownerId, signature);

  return new Response(null, { status: 204 });
}
