import { deletePreset } from "@/lib/presets";
import { apiRequireOwned } from "@/lib/ownership";

export async function DELETE(_request: Request, context: RouteContext<"/api/presets/[id]">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("preset", id);
  if (!guard.ok) {
    return guard.response;
  }

  if (!(await deletePreset(id))) {
    return Response.json({ error: "No such preset" }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
