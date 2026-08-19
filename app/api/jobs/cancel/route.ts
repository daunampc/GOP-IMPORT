import { cancelMany, jobsSnapshot } from "@/lib/jobs";
import { apiRequireView } from "@/lib/view";

/**
 * Bulk cancellation.
 *
 * `{ ids: [...] }` cancels exactly those runs; `{ scope: "queued" }` clears the
 * whole queue. There is deliberately no "cancel everything including what is
 * running": stopping every job mid-write across several sites is something that
 * should be pressed one at a time, on purpose.
 *
 * Scoped to the account on screen at BOTH ends. `scope: "queued"` reads that
 * account's queue, and an explicit list of ids is filtered by `cancelMany` — so
 * pasting another customer's run id into the array silently cancels nothing
 * rather than stopping their run. An administrator inside an account can stop
 * that account's runs; the cross-account form is `cancelManyUnscoped`, which
 * lives behind the admin oversight screen.
 */
export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const body = (await request.json().catch(() => ({}))) as {
    ids?: unknown;
    scope?: unknown;
  };

  let ids: string[];

  if (body.scope === "queued") {
    const snapshot = await jobsSnapshot(guard.ownerId);
    ids = snapshot.queued.map((job) => job.id);
  } else if (Array.isArray(body.ids)) {
    ids = body.ids.filter((id): id is string => typeof id === "string");
  } else {
    return Response.json(
      { error: 'Expected `ids` as an array of strings, or `scope: "queued"`.' },
      { status: 400 },
    );
  }

  if (ids.length === 0) {
    return Response.json({ cancelled: [], count: 0 });
  }

  const cancelled = await cancelMany(ids, guard.ownerId);

  return Response.json({ cancelled, count: cancelled.length });
}
