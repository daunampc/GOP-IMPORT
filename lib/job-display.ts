/**
 * What a run's state is CALLED on screen, as opposed to what it is in the column.
 *
 * Its own module, and that is not tidiness. Every one of these is needed by a
 * Client Component, and `lib/jobs.ts` pulls in `bullmq`, `ioredis` and
 * `postgres` — importing anything from it into the browser bundle fails the build
 * with `Can't resolve 'net'`. So the pure derivations live here, beside
 * `lib/store-links.ts`, `lib/plugin-version.ts` and `lib/purge-options.ts`, which
 * exist for exactly the same reason. `lib/jobs.ts` re-exports them so server code
 * still has one entry point, and the only import here is TYPE-ONLY, so it is
 * erased and there is no runtime cycle.
 *
 * The database has five statuses and keeps them. What the screen shows is four
 * more, all derived, because "queued" was doing the work of three different
 * sentences: waiting for a worker, waiting for Tuesday, and being told to stop.
 */

import type { JobKind, JobState } from "./jobs";

/**
 * What each kind of run is CALLED, and how its badge looks.
 *
 * A `Record<JobKind, …>` on purpose, and this is the lesson from adding the third
 * member. `kind === "purge" ? "Removal" : "Import"` compiled perfectly happily when
 * `update` appeared, so every screen quietly labelled a bulk edit an import and
 * would have printed "Created" over a product it had merely repriced — the call
 * sites had to be found with grep. A record keyed by the union does not compile
 * until a new member is handled, so the badges cannot drift from the enum again.
 */
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  import: "Import",
  purge: "Removal",
  update: "Bulk edit",
};

export const JOB_KIND_ICONS: Record<JobKind, "upload" | "trash" | "refresh"> = {
  import: "upload",
  purge: "trash",
  update: "refresh",
};

export const JOB_KIND_TONES: Record<JobKind, "neutral" | "bad" | "warn"> = {
  import: "neutral",
  purge: "bad",
  // Warn rather than neutral: it wrote over products that were already on sale.
  update: "warn",
};

export type JobDisplayStatus =
  | "queued"
  | "scheduled"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "stopped";

/**
 * Is this run waiting for a time rather than for a worker?
 *
 * FREE OF "NOW", on purpose. A run is scheduled because it carries a due time and
 * has not started — NOT because that time is in the future. A run whose moment
 * has passed but which no worker has picked up yet is still a scheduled run; more
 * to the point, a predicate that reads the clock answers one way in the server
 * render and another in the first client render, which React reports as hydration
 * error #418. The countdown is what needs the clock, and that belongs in
 * `components/ui/client-time.tsx`.
 */
export function isScheduled(job: Pick<JobState, "scheduledFor" | "status">): boolean {
  return job.scheduledFor !== null && job.status === "queued";
}

/** Asked to stop, but still winding down. */
export function isCancelling(
  job: Pick<JobState, "status" | "cancelRequestedAt">,
): boolean {
  return job.status === "running" && job.cancelRequestedAt !== null;
}

/**
 * The name to put on the pill.
 *
 * `stopped` and `cancelled` are separated because the two carry different
 * promises about what is on the site: a graceful cancel stopped at a batch
 * boundary and everything it sent is in the results, while a Stop abandoned a
 * request in flight and the site may hold products the results do not list. One
 * label for both would hide precisely the thing the operator needs to know.
 */
export function displayStatusOf(
  job: Pick<JobState, "status" | "scheduledFor" | "cancelRequestedAt" | "cancelMode">,
): JobDisplayStatus {
  if (isScheduled(job)) {
    return "scheduled";
  }

  if (isCancelling(job)) {
    return "cancelling";
  }

  if (job.status === "cancelled" && job.cancelMode === "stop") {
    return "stopped";
  }

  return job.status;
}

/** Can this run still be cancelled or stopped? */
export function isStoppable(job: Pick<JobState, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

/**
 * Can this run be deleted?
 *
 * The mirror of `isStoppable`, and deliberately not its negation in spirit:
 * `forgetJob` refuses a live run because deleting the row would leave the worker
 * with nowhere to write progress. The interface disables the control for the same
 * reason, and the route refuses it again regardless — hiding a button is a
 * courtesy, the route is the boundary.
 */
export function isDeletable(job: Pick<JobState, "status">): boolean {
  return !isStoppable(job);
}
