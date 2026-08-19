import { z } from "zod";

import { deleteSchedule, getSchedule, setSchedulePaused } from "@/lib/schedules";
import { apiRequireOwned } from "@/lib/ownership";

/**
 * One repeating series: pause it, start it again, or delete it — §6 C2.
 *
 * Through `apiRequireOwned`, so another account asking about a series by id gets
 * **404 and never 403** — a 403 would confirm the id exists, which is itself a fact
 * about another customer.
 *
 * Deleting takes the occurrence the series had waiting with it. Leaving that behind
 * would mean a series somebody deleted still publishes tonight; the runs that
 * already happened keep their results and their place in the history.
 */

const patchSchema = z.object({ paused: z.boolean() });

export async function GET(_request: Request, context: RouteContext<"/api/schedules/[id]">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("schedule", id);
  if (!guard.ok) {
    return guard.response;
  }

  const schedule = await getSchedule(id);

  if (schedule === null) {
    return Response.json({ error: "No such schedule" }, { status: 404 });
  }

  return Response.json({ schedule });
}

export async function PATCH(request: Request, context: RouteContext<"/api/schedules/[id]">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("schedule", id);
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json({ error: "Send { paused: true } or { paused: false }." }, { status: 400 });
  }

  const schedule = await setSchedulePaused(id, parsed.data.paused);

  if (schedule === null) {
    return Response.json({ error: "No such schedule" }, { status: 404 });
  }

  return Response.json({ schedule });
}

export async function DELETE(_request: Request, context: RouteContext<"/api/schedules/[id]">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("schedule", id);
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ deleted: await deleteSchedule(id) });
}
