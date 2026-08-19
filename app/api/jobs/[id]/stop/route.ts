import { STOP_WARNING, getJobState, requestStop } from "@/lib/jobs";
import { apiRequireOwned } from "@/lib/ownership";

/**
 * Stop a run NOW, abandoning whatever is in flight.
 *
 * A separate route from `cancel` rather than a flag on it, because the two make
 * DIFFERENT PROMISES and a query parameter is a poor place to keep that
 * difference:
 *
 *  - Cancel is graceful. The worker stops at the next batch boundary and a
 *    request already sent runs to its deadline, so no product is cut off while it
 *    is being written. That property is documented and it survives.
 *  - Stop aborts the request in flight. It is the only thing that helps a run
 *    wedged in a request the site will never answer — and it gives up the
 *    graceful guarantee to do it. The plugin may already have committed the batch
 *    it was sent, so the site can hold products the results table does not list.
 *
 * The response carries that warning so the interface says it at the moment of
 * pressing, and `requestStop` also writes it onto the run, because the person
 * reading the history next week is not the one who pressed the button.
 *
 * Same rules as every other `[id]` route: ownership through `apiRequireOwned`, so
 * a member reaching for another account's run gets 404 and never 403.
 */
export async function POST(_request: Request, context: RouteContext<"/api/jobs/[id]/stop">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  const state = await getJobState(id);
  if (state === null) {
    return Response.json({ error: "No such run" }, { status: 404 });
  }

  if (state.status !== "queued" && state.status !== "running") {
    return Response.json(
      { error: `This run is "${state.status}" — there is nothing to stop.` },
      { status: 409 },
    );
  }

  await requestStop(id);

  return Response.json({
    stopping: true,
    /** Shown at the moment of pressing, and recorded on the run as well. */
    warning: STOP_WARNING,
  });
}
