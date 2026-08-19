"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { JOB_STATUS, JobStatusPill } from "@/components/domain/job-status";
import { jobPercent, useJobs } from "@/components/shell/jobs-provider";
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  ConfirmDialog,
  DataTable,
  DateTime,
  ElapsedTime,
  EmptyState,
  useHydrated,
  Icon,
  Panel,
  ProgressBar,
  RelativeTime,
  StackedBar,
  Stat,
  Tabs,
  Tooltip,
  cn,
  foldVietnamese,
  useToast,
  type Column,
} from "@/components/ui";
import {
  elapsedBetween,
  formatDuration,
  formatNumber,
  formatThroughput,
} from "@/lib/format";
/*
 * From `lib/job-display`, NOT `lib/jobs`.
 *
 * This is a Client Component, and `lib/jobs` pulls in bullmq, ioredis and
 * postgres — importing a value from it here fails the build with
 * `Can't resolve 'net'`. The type import below is erased, so it is safe.
 */
import { isDeletable, isStoppable } from "@/lib/job-display";
import type { JobState } from "@/lib/jobs";
import { Input } from "@/components/ui";

/**
 * The activity list.
 *
 * Kept entirely separate from the detail page (`/process/[id]`): cramming live
 * progress, the queue, the history and the failed rows onto one page left
 * nowhere with enough room to do any of them properly.
 */

type Scope = "active" | "scheduled" | "history";

/** What the bulk-delete preflight came back with. */
interface DeletePlan {
  rows: number;
  deletable: number;
  blocked: number;
}

/**
 * When a scheduled run is due. Only shown on the Scheduled tab.
 *
 * Declared outside the component because it holds no state and so has no reason
 * to be rebuilt, and the countdown deliberately uses `RelativeTime`: it is
 * measured from "now", so rendering it on the server produces one string and the
 * first client render produces another, which React reports as hydration error
 * #418. The absolute stamp beside it is safe because `DateTime` pins its locale.
 */
const DUE_COLUMN: Column<JobState> = {
  key: "due",
  header: "Due",
  width: "11rem",
  sortable: true,
  sortValue: (job) => job.scheduledFor ?? "",
  cell: (job) =>
    job.scheduledFor === null ? (
      <span className="text-2xs text-ink-subtle">—</span>
    ) : (
      <span className="block text-xs text-ink-muted">
        <DateTime iso={job.scheduledFor} />
        <span className="block text-2xs text-ink-subtle">
          <RelativeTime iso={job.scheduledFor} />
        </span>
      </span>
    ),
};

export function ProcessListView() {
  const router = useRouter();
  const toast = useToast();
  const { snapshot, connection, streamError, refresh } = useJobs();
  const hydrated = useHydrated();

  const [scope, setScope] = useState<Scope>("active");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [busy, setBusy] = useState(false);

  /**
   * Delete is confirmed against a COUNT fetched from the server, not against the
   * number of rows ticked. Deleting a run takes its staged payload, its per-row
   * results and its per-batch records with it by cascade, and for a large run
   * that cascade is the whole point — it is the only way to reclaim the space. So
   * the question asked is "delete 3 runs and 12,000 rows?", never just "delete 3
   * runs?".
   */
  const [deletePlan, setDeletePlan] = useState<DeletePlan | null>(null);

  const active = useMemo(
    () => [...snapshot.running, ...snapshot.queued],
    [snapshot.running, snapshot.queued],
  );

  const source =
    scope === "active" ? active : scope === "scheduled" ? snapshot.scheduled : snapshot.history;

  const rows = useMemo(() => {
    const needle = foldVietnamese(query.trim());
    if (needle === "") {
      return source;
    }
    return source.filter((job) =>
      foldVietnamese(`${job.sourceLabel} ${job.storeLabel} ${job.storeUrl}`).includes(needle),
    );
  }, [source, query]);

  const totals = useMemo(
    () => ({
      running: snapshot.running.length,
      queued: snapshot.queued.length,
      scheduled: snapshot.scheduled.length,
      products: active.reduce((sum, job) => sum + job.total, 0),
      done: active.reduce((sum, job) => sum + job.processed, 0),
    }),
    [snapshot.running.length, snapshot.queued.length, snapshot.scheduled.length, active],
  );

  /**
   * How many of the ticked runs each action can actually act on.
   *
   * Counted from the runs themselves rather than from `selected.size`, so a
   * selection mixing a running run with a finished one offers Stop for one and
   * Delete for the other and claims neither covers both. The buttons are labelled
   * with these numbers for the same reason.
   */
  const selectedJobs = useMemo(() => {
    const all = [...snapshot.running, ...snapshot.queued, ...snapshot.scheduled, ...snapshot.history];
    return all.filter((job) => selected.has(job.id));
  }, [snapshot, selected]);

  const selectedStoppable = selectedJobs.filter(isStoppable).length;
  const selectedDeletable = selectedJobs.filter(isDeletable).length;

  async function cancelQueued() {
    setBusy(true);
    try {
      const response = await fetch("/api/jobs/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "queued" }),
      });
      const payload = (await response.json()) as { count?: number; error?: string };

      if (!response.ok) {
        toast.error("Could not clear the queue", payload.error);
        return;
      }

      toast.success(`Cancelled ${payload.count ?? 0} queued run(s)`);
      await refresh();
    } finally {
      setBusy(false);
      setConfirmBulk(false);
    }
  }

  async function cancelSelected() {
    setBusy(true);
    try {
      const response = await fetch("/api/jobs/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const payload = (await response.json()) as { count?: number; error?: string };

      if (!response.ok) {
        toast.error("Could not cancel", payload.error);
        return;
      }

      toast.success(`Cancellation requested for ${payload.count ?? 0} run(s)`,
        "Anything running stops at the next batch boundary, with no product cut off mid-write.");
      setSelected(new Set());
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Stop the selected runs immediately, rather than at a batch boundary.
   *
   * Sequential rather than concurrent, matching `cancelMany`: each Stop touches
   * the queue and publishes, and firing thirty at once to save a few hundred
   * milliseconds trades a correctness risk for nothing.
   */
  async function stopSelected() {
    setBusy(true);
    try {
      const ids = [...selected];
      const outcomes = [];

      for (const id of ids) {
        const response = await fetch(`/api/jobs/${id}/stop`, { method: "POST" });
        outcomes.push(response.ok);
      }

      const stopped = outcomes.filter(Boolean).length;

      if (stopped === 0) {
        toast.error("Could not stop anything", "None of the selected runs was still going.");
        return;
      }

      toast.warn(
        `Stopped ${stopped} run(s) immediately`,
        "Requests in flight were abandoned. Each site may hold products its results table " +
          "does not list — check before importing the same file again.",
      );
      setSelected(new Set());
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /** Ask what deleting the selection would take with it. Changes nothing. */
  async function planDelete() {
    setBusy(true);
    try {
      const response = await fetch("/api/jobs/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const payload = (await response.json()) as DeletePlan & { error?: string };

      if (!response.ok) {
        toast.error("Could not work out what would be deleted", payload.error);
        return;
      }

      setDeletePlan(payload);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    setBusy(true);
    try {
      const response = await fetch("/api/jobs/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const payload = (await response.json()) as {
        count?: number;
        skipped?: number;
        error?: string;
      };

      if (!response.ok) {
        toast.error("Could not delete", payload.error);
        return;
      }

      // A partial result is reported as one, never rounded up into a success.
      toast.success(
        `Deleted ${payload.count ?? 0} run(s)`,
        (payload.skipped ?? 0) > 0
          ? `${payload.skipped} left alone — a run that is queued or running has to be cancelled or stopped first.`
          : undefined,
      );
      setSelected(new Set());
      setDeletePlan(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<Column<JobState>[]>(
    () => [
      {
        key: "status",
        header: "Status",
        width: "9rem",
        sortable: true,
        sortValue: (job) => job.status,
        cell: (job) => <JobStatusPill job={job} />,
      },
      // "Due" only where it means something. On the other tabs every row would
      // be a dash, and a column of dashes is worse than no column.
      ...(scope === "scheduled" ? [DUE_COLUMN] : []),
      {
        key: "source",
        header: "Source",
        sortable: true,
        sortValue: (job) => job.sourceLabel,
        cell: (job) => (
          <div className="min-w-0">
            <span className="block truncate text-sm text-ink">{job.sourceLabel}</span>
            <span className="block truncate text-2xs text-ink-subtle">
              <DateTime iso={job.createdAt} />
              {job.retryOf ? " · resent failures" : ""}
              {job.groupId ? " · multi-site batch" : ""}
            </span>
          </div>
        ),
      },
      {
        key: "store",
        header: "Site",
        sortable: true,
        sortValue: (job) => job.storeLabel,
        hideBelow: "md",
        cell: (job) => (
          <span className="block max-w-48 truncate text-sm text-ink-muted">{job.storeLabel}</span>
        ),
      },
      {
        key: "progress",
        header: "Progress",
        width: "14rem",
        sortable: true,
        sortValue: (job) => (job.total === 0 ? 0 : job.processed / job.total),
        cell: (job) => (
          <div className="space-y-1">
            <StackedBar
              total={job.total}
              size="sm"
              segments={[
                { value: job.succeeded - job.deduplicated, tone: "ok", label: "Created" },
                { value: job.deduplicated, tone: "info", label: "Already present" },
                { value: job.failed, tone: "bad", label: "Failed" },
              ]}
            />
            <span className="tnum flex justify-between text-2xs text-ink-subtle">
              <span>
                {formatNumber(job.processed)}/{formatNumber(job.total)}
              </span>
              <span>{jobPercent(job)}%</span>
            </span>
          </div>
        ),
      },
      {
        key: "result",
        header: "Outcome",
        width: "12rem",
        hideBelow: "lg",
        cell: (job) => (
          <div className="flex flex-wrap gap-1">
            <Badge tone="ok">{formatNumber(job.succeeded)} ok</Badge>
            {job.deduplicated > 0 ? (
              <Tooltip content="Matched an existing idempotency key — the plugin returned the original product instead of creating a second one.">
                <Badge tone="info">{formatNumber(job.deduplicated)} present</Badge>
              </Tooltip>
            ) : null}
            {job.failed > 0 ? <Badge tone="bad">{formatNumber(job.failed)} failed</Badge> : null}
          </div>
        ),
      },
      {
        key: "elapsed",
        header: "When",
        width: "8rem",
        align: "right",
        hideBelow: "xl",
        sortable: true,
        sortValue: (job) => elapsedBetween(job.startedAt, job.finishedAt) ?? 0,
        cell: (job) => (
          <span className="tnum text-xs text-ink-muted">
            <ElapsedTime from={job.startedAt} to={job.finishedAt} />
          </span>
        ),
      },
      {
        key: "error",
        header: "Note",
        hideBelow: "xl",
        cell: (job) =>
          job.error ? (
            <Tooltip content={job.error}>
              <span className="flex max-w-48 items-center gap-1 truncate text-xs text-bad-fg">
                <Icon name="alert-circle" className="size-3.5 shrink-0" />
                {job.error}
              </span>
            </Tooltip>
          ) : (
            <span className="text-2xs text-ink-subtle">—</span>
          ),
      },
    ],
    [scope],
  );

  return (
    <div className="space-y-5">
      {connection === "offline" ? (
        <Alert tone="warn" title="The update stream dropped">
          Runs ARE still going in the worker — the numbers below are frozen and will catch up when
          the connection returns.
        </Alert>
      ) : null}

      {streamError ? (
        <Alert tone="bad" title="The server could not read run state">
          <p>{streamError}</p>
          <p className="mt-1">
            Usually Redis being unreachable. Open Settings to check the connection.
          </p>
        </Alert>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Running"
          value={formatNumber(totals.running)}
          icon="zap"
          tone={totals.running > 0 ? "accent" : "neutral"}
          hint={totals.running > 0 ? "the worker is calling the site" : "the worker is idle"}
        />
        <Stat
          label="Queued"
          value={formatNumber(totals.queued)}
          icon="clock"
          // Scheduled runs are excluded from this number on purpose: a queue of
          // forty runs waiting for next Tuesday is not a worker forty runs
          // behind, and the two read identically if they share a tile.
          hint={
            totals.queued > 0
              ? "waiting to be picked up"
              : totals.scheduled > 0
                ? `the queue is empty — ${formatNumber(totals.scheduled)} scheduled for later`
                : "the queue is empty"
          }
        />
        <Stat
          label="Products remaining"
          value={formatNumber(Math.max(0, totals.products - totals.done))}
          icon="package"
          hint={`of ${formatNumber(totals.products)} across the open runs`}
        />
        <Stat
          label="Done today"
          value={
            // "Today" in the READER's time zone, not the server's — so it can
            // only be settled after hydration.
            hydrated
              ? formatNumber(
                  snapshot.history
                    .filter((job) => job.finishedAt !== null && isToday(job.finishedAt))
                    .reduce((sum, job) => sum + job.succeeded, 0),
                )
              : "—"
          }
          icon="check-circle"
          tone="ok"
          hint="products succeeded"
        />
      </section>

      {/* Running jobs get their own prominent block — this is what people open
          the page to look at. */}
      {snapshot.running.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {snapshot.running.map((job) => (
            <RunningCard key={job.id} job={job} />
          ))}
        </div>
      ) : null}

      <Panel
        title="Activity"
        icon="activity"
        padded={false}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              icon="search"
              placeholder="Search by source or site…"
              aria-label="Search runs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 w-56 text-xs"
            />
            {snapshot.queued.length > 0 ? (
              <Button
                size="sm"
                variant="danger"
                icon="stop"
                onClick={() => setConfirmBulk(true)}
              >
                Clear the queue ({snapshot.queued.length})
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="border-b border-line px-3 pt-2">
          <Tabs
            items={[
              { value: "active", label: "Running and queued", icon: "zap", count: active.length },
              // Its own tab rather than mixed in with the queue: "waiting to be
              // picked up" and "waiting for Tuesday" are different answers, and
              // forty scheduled runs sitting in the queue tab would read as a
              // worker forty runs behind.
              {
                value: "scheduled",
                label: "Scheduled",
                icon: "clock",
                count: snapshot.scheduled.length,
              },
              {
                value: "history",
                label: "History",
                icon: "history",
                count: snapshot.history.length,
              },
            ]}
            value={scope}
            onChange={(next) => {
              setScope(next);
              setSelected(new Set());
              setDeletePlan(null);
            }}
          />
        </div>

        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-accent-border bg-accent-soft px-3 py-2">
            <span className="tnum text-xs font-medium text-accent-fg">
              {selected.size} run{selected.size === 1 ? "" : "s"} selected
            </span>

            {/*
              Cancel and Stop sit side by side and are deliberately NOT twins.
              Two buttons that look alike and behave differently would be worse
              than one, so Cancel is the ordinary secondary action and Stop is
              the dangerous one, each labelled with what it actually promises.
            */}
            {selectedStoppable > 0 ? (
              <>
                <Tooltip content="Each lane finishes the batch it has already sent and then stops. No product is cut off mid-write.">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="stop"
                    loading={busy}
                    onClick={() => void cancelSelected()}
                  >
                    Cancel gracefully ({selectedStoppable})
                  </Button>
                </Tooltip>
                <Tooltip content="Abandons the request in flight instead of waiting for it. Use this when a site has stopped answering \u2014 the site may keep products the results do not list.">
                  <Button
                    size="sm"
                    variant="danger"
                    icon="alert-triangle"
                    loading={busy}
                    onClick={() => void stopSelected()}
                  >
                    Stop now ({selectedStoppable})
                  </Button>
                </Tooltip>
              </>
            ) : null}

            {selectedDeletable > 0 ? (
              <Tooltip content="Removes the run and everything hanging off it \u2014 its staged products, its per-row results and its per-batch figures.">
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  loading={busy}
                  onClick={() => void planDelete()}
                >
                  Delete ({selectedDeletable})
                </Button>
              </Tooltip>
            ) : null}

            <Button
              size="sm"
              variant="ghost"
              icon="x"
              className="ml-auto"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        ) : null}

        <DataTable
          caption={
            scope === "active"
              ? "Runs that are running or queued"
              : scope === "scheduled"
                ? "Runs waiting for their time"
                : "Run history"
          }
          rows={rows}
          columns={columns}
          rowKey={(job) => job.id}
          // Selectable on every tab now: history is where deleting happens, and
          // it used to be the one tab with no way to select anything.
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          onRowClick={(job) => router.push(`/process/${job.id}`)}
          rowTone={(job) =>
            job.status === "failed" ? "bad" : job.status === "cancelled" ? "warn" : "none"
          }
          defaultSort={{ key: "source", direction: "desc" }}
          empty={
            scope === "active" ? (
              <EmptyState
                icon="activity"
                title="Nothing running"
                description="The queue is empty and the worker is idle. Start a run to watch its progress here and on the status bar."
                action={
                  <ButtonLink href="/import" variant="primary" icon="upload">
                    Start an import
                  </ButtonLink>
                }
              />
            ) : scope === "scheduled" ? (
              <EmptyState
                icon="clock"
                title="Nothing scheduled"
                description="A run can be set to start later from the last step of the import wizard. Its products are staged when you schedule it, so it does not depend on the preview staying alive."
                action={
                  <ButtonLink href="/import" variant="primary" icon="upload">
                    Start an import
                  </ButtonLink>
                }
              />
            ) : (
              <EmptyState
                icon="history"
                title="No finished runs yet"
                description="History is kept for 7 days. After the first run, every row\u2019s result is searchable here."
                action={
                  <ButtonLink href="/import" variant="primary" icon="upload">
                    Start an import
                  </ButtonLink>
                }
              />
            )
          }
        />
      </Panel>

      <ConfirmDialog
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={() => void cancelQueued()}
        busy={busy}
        title="Clear the whole queue?"
        confirmLabel={`Cancel ${snapshot.queued.length} run(s)`}
        message={
          <>
            <p>
              {snapshot.queued.length} run(s) that have not started will be dropped from the queue
              immediately. Anything already RUNNING is left alone.
            </p>
            <p className="mt-2">There is no undo — running them again means creating a new batch.</p>
          </>
        }
      />

      {/*
        The row count is quoted BEFORE the question, not after it. Deleting a run
        takes its staged payload, its per-row results and its per-batch figures
        with it by cascade, and for a large run that is thousands of rows — which
        is the point of offering it at all, and exactly why the number has to be
        on screen before anyone presses anything.
      */}
      <ConfirmDialog
        open={deletePlan !== null}
        onClose={() => setDeletePlan(null)}
        onConfirm={() => void deleteSelected()}
        busy={busy}
        title={`Delete ${formatNumber(deletePlan?.deletable ?? 0)} run${
          (deletePlan?.deletable ?? 0) === 1 ? "" : "s"
        }?`}
        confirmLabel={`Delete ${formatNumber(deletePlan?.rows ?? 0)} row(s)`}
        message={
          <>
            <p>
              This removes <strong>{formatNumber(deletePlan?.rows ?? 0)} rows</strong> in total: each
              run, its staged products, its per-row results, its per-batch figures and its log lines.
              For a large run that cascade is the only way to reclaim the space.
            </p>
            {(deletePlan?.blocked ?? 0) > 0 ? (
              <p className="mt-2">
                {formatNumber(deletePlan?.blocked ?? 0)} of the selected run(s) are still queued or
                running and will be <strong>left alone</strong> — cancel or stop them first.
              </p>
            ) : null}
            <p className="mt-2">
              The products already published to the sites are <strong>not</strong> touched. This
              deletes the record of the run, not its effect. Use Remove products for that.
            </p>
            <p className="mt-2">There is no undo.</p>
          </>
        }
      />
    </div>
  );
}

function RunningCard({ job }: { job: JobState }) {
  // Speed and time remaining are measured from "now", so they can only be
  // computed in the browser — doing it on the server gives two different
  // numbers either side of hydration.
  const hydrated = useHydrated();

  const elapsed = hydrated ? elapsedBetween(job.startedAt, null) : null;
  const perSecond =
    elapsed !== null && elapsed > 0 && job.processed > 0 ? job.processed / (elapsed / 1000) : null;

  const remaining = job.total - job.processed;
  const etaSeconds = perSecond !== null && perSecond > 0 ? remaining / perSecond : null;

  return (
    <Panel
      title={job.sourceLabel}
      icon="zap"
      description={`→ ${job.storeLabel}`}
      actions={
        <ButtonLink href={`/process/${job.id}`} size="sm" variant="secondary" iconAfter="arrow-right">
          Detail
        </ButtonLink>
      }
    >
      <div className="space-y-3">
        <ProgressBar
          value={job.processed}
          max={job.total}
          size="lg"
          tone={job.failed > 0 ? "warn" : "accent"}
          label={`Progress of ${job.sourceLabel}`}
        />

        <div className="tnum flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className="text-ink">
            {formatNumber(job.processed)} / {formatNumber(job.total)} products ·{" "}
            <span className="text-ink-subtle">{jobPercent(job)}%</span>
          </span>
          <span className="flex flex-wrap items-center gap-3 text-ink-subtle">
            <span>batch {job.batchesDone}/{job.batches}</span>
            <span>{formatThroughput(perSecond)}</span>
            {etaSeconds !== null ? <span>~{formatDuration(etaSeconds * 1000)} left</span> : null}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <MiniStat label="Created" value={job.succeeded - job.deduplicated} tone="ok" />
          <MiniStat label="Already present" value={job.deduplicated} tone="info" />
          <MiniStat label="Failed" value={job.failed} tone="bad" />
        </div>
      </div>
    </Panel>
  );
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "info" | "bad";
}) {
  const tones = {
    ok: "border-ok-border bg-ok-soft text-ok-fg",
    info: "border-info-border bg-info-soft text-info-fg",
    bad: "border-bad-border bg-bad-soft text-bad-fg",
  } as const;

  return (
    <div className={cn("rounded-md border px-2.5 py-1.5", tones[tone])}>
      <p className="text-2xs">{label}</p>
      <p className="tnum text-base font-semibold">{formatNumber(value)}</p>
    </div>
  );
}

function isToday(iso: string): boolean {
  const date = new Date(iso);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export { JOB_STATUS };
