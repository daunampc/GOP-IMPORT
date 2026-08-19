import { forgetJob, getBatchRecords, getJobState } from "@/lib/jobs";
import { getStoreUnscoped, toPublic } from "@/lib/stores";
import { apiRequireOwned } from "@/lib/ownership";

/** One run in detail: status, per-batch figures, and the target site. */
export async function GET(_request: Request, context: RouteContext<"/api/jobs/[id]">) {
  const { id } = await context.params;

  // A run belonging to another account answers 404, exactly as a run that never
  // existed does — see lib/ownership.ts.
  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  const job = await getJobState(id);
  if (job === null) {
    return Response.json({ error: "No such run" }, { status: 404 });
  }

  const [batches, store] = await Promise.all([
    getBatchRecords(id),
    // The site belongs to the run's owner, which is not the caller when an
    // administrator is looking at a member's run.
    getStoreUnscoped(job.storeId),
  ]);

  return Response.json({
    job,
    batches,
    // Can be null when the site was removed after the run — the UI has to cope
    // with that and say so, rather than render a broken link.
    store: store ? toPublic(store) : null,
  });
}

/** Removes a finished run from the history. */
export async function DELETE(_request: Request, context: RouteContext<"/api/jobs/[id]">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  if (!(await forgetJob(id))) {
    return Response.json(
      { error: "Could not remove it: no such run, or it is still queued or running." },
      { status: 409 },
    );
  }

  return new Response(null, { status: 204 });
}
