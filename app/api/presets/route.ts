import { importOptionsSchema } from "@/lib/import-options";
import { listPresets, savePreset } from "@/lib/presets";
import { apiRequireView } from "@/lib/view";

export async function GET() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ presets: await listPresets(guard.ownerId) });
}

export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    options?: unknown;
  } | null;

  if (body === null || typeof body.name !== "string" || body.name.trim() === "") {
    return Response.json({ error: "A preset needs a name." }, { status: 400 });
  }

  // A preset carries no `storeId`: the site is a per-run choice. Folding it in
  // would make picking the wrong preset mean publishing to the wrong site.
  const parsed = importOptionsSchema.omit({ storeId: true }).safeParse(body.options);

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  return Response.json(
    { preset: await savePreset(body.name, parsed.data, guard.ownerId) },
    { status: 201 },
  );
}
