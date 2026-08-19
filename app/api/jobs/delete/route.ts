import { forgetMany, jobFootprintsFor } from "@/lib/jobs";
import { apiRequireView } from "@/lib/view";

/**
 * Bulk delete, and the count that has to be quoted before it.
 *
 * `POST` asks what would go; `DELETE` does it. Two methods rather than a
 * `confirm: true` flag, because the preflight is not a formality here: deleting a
 * run takes its `job_item`, `job_result` and `job_batch` rows with it by cascade,
 * and for a large run that cascade is the entire point — it is the only way to
 * reclaim the space. "Delete 3 runs" and "delete 3 runs and 12,000 rows" are the
 * same click, so the screen is given the number first.
 *
 * Scoped to the account on screen at both ends, exactly like the bulk cancel:
 * `forgetMany` filters by owner, so pasting another customer's run id into the
 * array silently deletes nothing rather than destroying their history. An
 * administrator inside an account can clear that account's runs; the
 * cross-account form is `forgetManyUnscoped`, behind the admin oversight screen.
 */
function readIds(body: { ids?: unknown }): string[] | null {
  if (!Array.isArray(body.ids)) {
    return null;
  }
  return body.ids.filter((id): id is string => typeof id === "string");
}

/** What deleting these would take with it. Changes nothing. */
export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
  const ids = readIds(body);

  if (ids === null) {
    return Response.json({ error: "Expected `ids` as an array of strings." }, { status: 400 });
  }

  // Filtered to the account on screen BEFORE any count is computed: a row count
  // for another customer's run is still a fact about another customer.
  const mine = await jobFootprintsFor(ids, guard.ownerId);

  return Response.json({
    footprints: mine,
    /** Everything that would go, across every run named — the run rows included. */
    rows: mine.reduce((sum, footprint) => sum + footprint.total, 0),
    deletable: mine.filter((footprint) => footprint.deletable).length,
    /** Still queued or running, so they must be cancelled or stopped first. */
    blocked: mine.filter((footprint) => !footprint.deletable).length,
  });
}

export async function DELETE(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
  const ids = readIds(body);

  if (ids === null) {
    return Response.json({ error: "Expected `ids` as an array of strings." }, { status: 400 });
  }

  if (ids.length === 0) {
    return Response.json({ deleted: [], count: 0 });
  }

  const deleted = await forgetMany(ids, guard.ownerId);

  return Response.json({
    deleted,
    count: deleted.length,
    /**
     * Named separately so the screen can say "3 deleted, 2 still running" rather
     * than reporting a partial success as a whole one.
     */
    skipped: ids.length - deleted.length,
  });
}
