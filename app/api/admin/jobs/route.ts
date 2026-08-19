import { allJobsSnapshot, cancelManyUnscoped } from "@/lib/jobs";
import { apiRequireAdmin } from "@/lib/session";

/**
 * Every account's runs, and cancelling any of them.
 *
 * Separate from `/api/jobs` rather than a `?all=true` on it. The ordinary route
 * is what a customer's status bar polls every second; a flag that widens it to
 * the whole installation is one typo away from putting every customer's runs on
 * an ordinary customer's screen, and the typo would be invisible at the call
 * site. This route is administrators-only from its first line and cannot be
 * reached by leaving an argument out of that one.
 */
export async function GET() {
  const guard = await apiRequireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json(await allJobsSnapshot());
}

export async function POST(request: Request) {
  const guard = await apiRequireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const body = (await request.json().catch(() => ({}))) as { ids?: unknown };

  if (!Array.isArray(body.ids)) {
    return Response.json({ error: "Expected `ids` as an array of strings." }, { status: 400 });
  }

  const ids = body.ids.filter((id): id is string => typeof id === "string");

  if (ids.length === 0) {
    return Response.json({ cancelled: [], count: 0 });
  }

  // Cancelling still only raises a flag — the worker stops at the next batch
  // boundary. An administrator stopping a customer's run does not cut a product
  // off mid-write any more than the customer does.
  const cancelled = await cancelManyUnscoped(ids);

  return Response.json({ cancelled, count: cancelled.length });
}
