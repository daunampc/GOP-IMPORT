import { cancelMany, getJobState, groupSiblings, requestCancel } from "@/lib/jobs";
import { apiRequireOwned } from "@/lib/ownership";

/**
 * Cancel a run gracefully — and, if asked, its siblings with it.
 *
 * One click on Import aimed at several sites creates one run PER SITE sharing a
 * `groupId`, and this route acts on a single id. That is why "I cancelled the
 * import and it kept importing" was a completely fair description of what
 * happened: five runs, one cancelled, four carrying on.
 *
 * The fix is NOT to make Cancel quietly mean the whole group. "Cancel this run"
 * and "cancel 5 runs" are different promises, and widening one into the other
 * without saying so would be the same class of dishonesty as the bug. So the
 * group is opt-in — `{ group: true }` — and the response says how many runs it
 * covered so the interface can report it rather than guess.
 *
 * Whichever is asked for, the run's own siblings are returned so the screen can
 * OFFER the group with its real count before anything is pressed.
 */
export async function POST(request: Request, context: RouteContext<"/api/jobs/[id]/cancel">) {
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
      { error: `This run is "${state.status}" — there is nothing to cancel.` },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { group?: unknown };
  const wholeGroup = body.group === true && state.groupId !== null;

  if (wholeGroup) {
    /*
     * Scoped to the run's OWNER, not to the caller.
     *
     * `guard.ownerId` is the account the run belongs to, which is the member's
     * account when an administrator is acting on their behalf. Using the caller's
     * id here would make an administrator's group cancel silently cancel nothing.
     */
    const siblings = await groupSiblings(id);
    const cancelled = await cancelMany(
      siblings.map((sibling) => sibling.id),
      guard.ownerId,
    );

    return Response.json({ cancelling: true, cancelled, count: cancelled.length, group: true });
  }

  // Only raises a durable record on the run; the worker stops at the next batch
  // boundary, so no product is cut off mid-write.
  await requestCancel(id);

  return Response.json({ cancelling: true, cancelled: [id], count: 1, group: false });
}

/**
 * The runs this one shares a click with, so the screen can offer the group by its
 * real size instead of the operator having to work it out from the list.
 */
export async function GET(_request: Request, context: RouteContext<"/api/jobs/[id]/cancel">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  const siblings = await groupSiblings(id);

  return Response.json({
    siblings: siblings.map((sibling) => ({
      id: sibling.id,
      storeLabel: sibling.storeLabel,
      status: sibling.status,
    })),
    /** Only these can still be stopped — the rest of the group has settled. */
    stoppable: siblings.filter((sibling) => sibling.status === "queued" || sibling.status === "running")
      .length,
  });
}
