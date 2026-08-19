import { getJobState, isScheduled, rescheduleJob } from "@/lib/jobs";
import { checkImport, checkProductEdit } from "@/lib/limits";
import { apiRequireOwned } from "@/lib/ownership";
import type { ImportOptions } from "@/lib/import-options";
import type { EditOptions } from "@/lib/edit-options";

/** How far ahead a run may be scheduled. A year is a mistake, not a plan. */
const MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Move a scheduled run to a different time.
 *
 * `apiRequireOwned` first, so a member reaching for another account's run gets
 * 404 and never 403 — the same rule as every other `[id]` route, and asserted by
 * id in tests/isolation.ts rather than assumed.
 *
 * The per-account import switch is re-checked HERE as well as at creation and
 * again in the worker when the run fires. Three checks is not paranoia: this
 * route is the one that can move a run from a time when the account was allowed
 * to import into a time when it may not be, so it has to ask again. And the check
 * is in the route handler, not only hidden in the interface — a switch that only
 * greys out a button is a suggestion.
 */
export async function PATCH(request: Request, context: RouteContext<"/api/jobs/[id]/schedule">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  const state = await getJobState(id);
  if (state === null) {
    return Response.json({ error: "No such run" }, { status: 404 });
  }

  if (!isScheduled(state)) {
    return Response.json(
      {
        error:
          state.status === "queued"
            ? "This run was started immediately, so there is no schedule to move. Cancel it and start a new one."
            : `This run is "${state.status}" — its schedule cannot be changed.`,
      },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { scheduledFor?: unknown };

  if (typeof body.scheduledFor !== "string") {
    return Response.json(
      { error: "Expected `scheduledFor` as an ISO 8601 timestamp." },
      { status: 400 },
    );
  }

  const when = new Date(body.scheduledFor);

  if (Number.isNaN(when.getTime())) {
    return Response.json({ error: "That is not a valid date and time." }, { status: 400 });
  }

  if (when.getTime() - Date.now() > MAX_AHEAD_MS) {
    return Response.json(
      { error: "A run cannot be scheduled more than 90 days ahead." },
      { status: 400 },
    );
  }

  // The run's OWNER, not the caller: an administrator moving a member's run is
  // bound by the member's ceilings, because it is the member's run that will fire.
  if (state.kind === "import") {
    const limit = await checkImport(guard.ownerId, {
      count: state.total,
      threads: (state.options as ImportOptions).threads,
    });

    if (!limit.ok) {
      return limit.response;
    }
  }

  // A bulk edit obeys its OWN switch, checked here as well as when it fires — the
  // same two moments an import is checked at, and for the same reason: the operator
  // finds out now, while they can still act on it, and the worker checks again
  // because the answer can change in the days between.
  if (state.kind === "update") {
    const limit = await checkProductEdit(guard.ownerId, {
      count: state.total,
      threads: (state.options as EditOptions).threads,
    });

    if (!limit.ok) {
      return limit.response;
    }
  }

  const outcome = await rescheduleJob(id, when);

  if (!outcome.ok) {
    const message: Record<typeof outcome.reason, string> = {
      not_found: "No such run",
      already_started: "This run has already started — its schedule cannot be changed.",
      not_delayed:
        "The queue has already promoted this run and it is about to start. Cancel it instead.",
    };

    return Response.json(
      { error: message[outcome.reason] },
      { status: outcome.reason === "not_found" ? 404 : 409 },
    );
  }

  return Response.json({ scheduledFor: outcome.scheduledFor });
}
