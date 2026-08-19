/*
 * `displayStatusOf` comes from `lib/job-display`, NOT from `lib/jobs`.
 *
 * `lib/jobs` re-exports it for server callers, but importing the VALUE through
 * that re-export puts `lib/jobs` in the browser bundle, and `lib/jobs` pulls in
 * bullmq — which fails the build with `Can't resolve 'net'`. This module is used
 * by Client Components, so it takes the direct route. The type imports below are
 * erased at compile time and are safe from anywhere.
 */
import { displayStatusOf, type JobDisplayStatus } from "@/lib/job-display";
import type { JobState, JobStatus } from "@/lib/jobs";
import { StatusPill, type IconName, type Tone } from "@/components/ui";

/**
 * How a run's state looks, declared in exactly one place.
 *
 * The previous build had two separate maps — one for labels, one for colour
 * classes — buried in the activity screen and reachable from nowhere else, so the
 * same status was drawn differently on every other screen.
 *
 * FOUR of these eight are derived rather than stored, because the five database
 * statuses were making one word do several jobs:
 *
 *  - `scheduled` was `queued`, which on the status bar read as a worker that had
 *    fallen behind rather than a run waiting for Tuesday;
 *  - `cancelling` was `running`, so pressing Cancel appeared to do nothing at all
 *    while a lane finished the batch it had already sent — which is a large part
 *    of why "cancel does not work" was a fair description;
 *  - `stopped` was `cancelled`, hiding the one difference that matters: a Stop
 *    abandoned a request in flight, so the site may hold products the results
 *    table does not list.
 *
 * The status COLUMN still has its original five members. Adding to the enum would
 * have meant a migration plus every `switch` on status across the status bar, the
 * dashboard, `computeStats` and the Activity filters either handling the new
 * member or failing at runtime — see the note on `scheduledFor` in `db/schema.ts`.
 */
export const JOB_DISPLAY: Record<
  JobDisplayStatus,
  { label: string; tone: Tone; icon: IconName; pulse?: boolean; hint: string }
> = {
  queued: {
    label: "Queued",
    tone: "neutral",
    icon: "clock",
    hint: "Waiting for the worker to pick it up.",
  },
  scheduled: {
    label: "Scheduled",
    tone: "info",
    icon: "clock",
    hint: "Waiting for its time. The products are already staged, so it does not depend on the preview.",
  },
  running: {
    label: "Running",
    tone: "accent",
    icon: "zap",
    pulse: true,
    hint: "The worker is calling the site.",
  },
  cancelling: {
    label: "Cancelling",
    tone: "warn",
    icon: "stop",
    pulse: true,
    hint: "Asked to stop. Each lane finishes the batch it has already sent, so no product is cut off mid-write.",
  },
  completed: {
    label: "Completed",
    tone: "ok",
    icon: "check-circle",
    hint: "Every batch was sent and answered.",
  },
  failed: {
    label: "Failed",
    tone: "bad",
    icon: "alert-circle",
    hint: "The run stopped on an error. The note says which.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "warn",
    icon: "stop",
    hint: "Stopped at a batch boundary. Everything that was sent is in the results below.",
  },
  stopped: {
    label: "Stopped",
    tone: "warn",
    icon: "stop",
    hint: "Ended immediately, abandoning a request in flight. The site may hold products the results do not list.",
  },
};

/**
 * The five stored statuses, for the few callers that have a bare status and no
 * run to derive from — the Activity filter list, mainly.
 */
export const JOB_STATUS: Record<JobStatus, { label: string; tone: Tone; icon: IconName }> = {
  queued: JOB_DISPLAY.queued,
  running: JOB_DISPLAY.running,
  completed: JOB_DISPLAY.completed,
  failed: JOB_DISPLAY.failed,
  cancelled: JOB_DISPLAY.cancelled,
};

/**
 * Prefer passing the whole run. A bare `status` cannot tell a scheduled run from
 * a queued one, nor a stopped one from a cancelled one, so it draws the plainer
 * of the two — correct, but less than it could say.
 */
export function JobStatusPill({
  job,
  status,
}: { job: JobStateForPill; status?: never } | { job?: never; status: JobStatus }) {
  const key: JobDisplayStatus = job ? displayStatusOf(job) : status;
  const meta = JOB_DISPLAY[key];

  return <StatusPill tone={meta.tone} label={meta.label} icon={meta.icon} pulse={meta.pulse} />;
}

export type JobStateForPill = Pick<
  JobState,
  "status" | "scheduledFor" | "cancelRequestedAt" | "cancelMode"
>;
