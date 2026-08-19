"use client";

import Link from "next/link";

import { JobStatusPill } from "@/components/domain/job-status";
import { Icon, ProgressBar, StatusPill, Tooltip, cn } from "@/components/ui";

import { jobPercent, primaryJob, useJobs } from "./jobs-provider";

/**
 * The persistent status bar, pinned to the bottom of the viewport.
 *
 * This answers the biggest complaint about the previous tool: a run took forty
 * minutes and leaving the activity screen meant losing sight of it entirely.
 * Here, every screen shows how far a run has got, and clicking goes straight to
 * its detail page.
 */
export function StatusBar() {
  const { snapshot, connection, streamError } = useJobs();

  const job = primaryJob(snapshot);
  const running = snapshot.running.length;
  const queued = snapshot.queued.length;
  const scheduled = snapshot.scheduled.length;

  return (
    <footer className="z-30 flex h-9 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-xs">
      <ConnectionIndicator state={connection} error={streamError} />

      <span aria-hidden className="h-4 w-px bg-line" />

      {job ? (
        <Link
          href={`/process/${job.id}`}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-sm transition-colors duration-fast hover:text-accent-fg"
        >
          {/*
            The whole run, not just its status: a run that has been asked to stop
            reads "Cancelling" here rather than sitting at "Running", which is
            most of the reason pressing Cancel looked like it did nothing.
          */}
          <JobStatusPill job={job} />

          <span className="hidden min-w-0 max-w-64 truncate text-ink-muted sm:block">
            {job.sourceLabel}
          </span>

          <span className="hidden min-w-0 max-w-40 truncate text-ink-subtle md:block">
            → {job.storeLabel}
          </span>

          <span className="flex min-w-0 flex-1 items-center gap-2">
            <ProgressBar
              value={job.processed}
              max={job.total}
              size="sm"
              tone={job.failed > 0 ? "warn" : "accent"}
              label={`Progress of ${job.sourceLabel}`}
              className="max-w-48 min-w-16"
            />
            <span className="tnum shrink-0 text-ink-muted">
              {job.processed}/{job.total}
              <span className="ml-1 text-ink-subtle">({jobPercent(job)}%)</span>
            </span>
          </span>
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-ink-subtle">
          <Icon name="check-circle" className="size-3.5" />
          {/* "Nothing running" alone would be misleading with runs waiting for a
              time — the worker is idle, but work IS pending. */}
          {scheduled > 0
            ? `Nothing running — ${scheduled} scheduled for later`
            : "Nothing running"}
        </span>
      )}

      <span className="tnum hidden shrink-0 items-center gap-3 text-ink-subtle sm:flex">
        {running > 1 ? <span>{running} running</span> : null}
        {queued > 0 ? <span>{queued} queued</span> : null}
        {/* Counted apart from `queued`: "waiting to be picked up" and "waiting
            for Tuesday" say different things about the worker's health. */}
        {scheduled > 0 && job !== null ? <span>{scheduled} scheduled</span> : null}
      </span>
    </footer>
  );
}

function ConnectionIndicator({
  state,
  error,
}: {
  state: "connecting" | "live" | "offline";
  error: string | null;
}) {
  if (error !== null) {
    return (
      <Tooltip
        side="top"
        content={`The server errored while reading status: ${error}. Runs carry on in the worker.`}
      >
        <StatusPill tone="bad" label="Status unavailable" />
      </Tooltip>
    );
  }

  if (state === "offline") {
    return (
      <Tooltip
        side="top"
        content="The update stream dropped. Runs ARE still going in the worker — these numbers are frozen and will catch up when the connection returns."
      >
        <StatusPill tone="warn" label="Disconnected" />
      </Tooltip>
    );
  }

  return (
    <StatusPill
      tone={state === "live" ? "ok" : "neutral"}
      label={state === "live" ? "Live" : "Connecting"}
      pulse={state === "connecting"}
      className={cn(state === "live" && "text-ok-fg")}
    />
  );
}
