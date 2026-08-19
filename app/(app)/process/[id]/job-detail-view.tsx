"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { JobStatusPill } from "@/components/domain/job-status";
import { jobPercent, useJobs } from "@/components/shell/jobs-provider";
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  Code,
  ConfirmDialog,
  DataTable,
  DateTime,
  DescriptionList,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  Panel,
  ProgressBar,
  Segmented,
  Sparkline,
  StackedBar,
  Stat,
  SkeletonTable,
  Tooltip,
  foldVietnamese,
  useHydrated,
  useToast,
  type Column,
  type DescriptionItem,
} from "@/components/ui";
import {
  elapsedBetween,
  formatDuration,
  formatMoney,
  formatNumber,
  formatPercent,
  formatThroughput,
} from "@/lib/format";
import {
  IMAGE_MODE_LABELS,
  IMPORT_MODE_LABELS,
  WRITE_MODE_LABELS,
} from "@/lib/import-options";
import type { BatchRecord, JobFootprint, JobState, RunResult } from "@/lib/jobs";
import {
  PURGE_SELECTION_LABELS,
  REMOVED_TABLES,
  sumRemoved,
  type PurgeOptions,
} from "@/lib/purge-options";
import type { ImportOptions } from "@/lib/import-options";
import { describeEdit, type EditOptions } from "@/lib/edit-options";
// From `lib/store-links`, NOT `lib/stores`: that module drags ioredis behind
// it, and a Client Component touching it puts the whole Redis package into the
// browser bundle.
import { adminProductUrl } from "@/lib/store-links";
import type { PublicStore } from "@/lib/stores";

import { RunLog } from "./run-log";


/**
 * One run in detail.
 *
 * This is where the questions the previous build could not answer get answered:
 *  - which row failed, with what error, and where to open that product;
 *  - which rows were CREATED and which were merely ALREADY PRESENT;
 *  - how long each batch took (`elapsed_ms`) and how the speed moved over time;
 *  - and how to rerun exactly the failures without touching what already
 *    landed.
 */

type ResultFilter = "all" | "created" | "deduplicated" | "failed";

interface FetchedResults {
  results: RunResult[];
  error: string | null;
}

/**
 * Fetches data and touches NO state.
 *
 * Keeping the fetch separate from the setState is what lets an effect call it
 * and only set state AFTER the await, and lets one function serve both the
 * first read and the three-second poll without duplicating anything.
 */
async function fetchResults(jobId: string): Promise<FetchedResults> {
  try {
    const response = await fetch(`/api/jobs/${jobId}/results?limit=5000`);
    const payload = (await response.json()) as { results?: RunResult[]; error?: string };

    if (!response.ok || !payload.results) {
      return { results: [], error: payload.error ?? "Could not read the results." };
    }

    return { results: payload.results, error: null };
  } catch (caught) {
    return {
      results: [],
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

/** `null` means unreadable — batch figures only feed a chart, so failing quietly is fine. */
async function fetchBatches(jobId: string): Promise<BatchRecord[] | null> {
  try {
    const response = await fetch(`/api/jobs/${jobId}`);
    const payload = (await response.json()) as { batches?: BatchRecord[] };
    return payload.batches ?? null;
  } catch {
    return null;
  }
}

export function JobDetailView({
  initialJob,
  initialBatches,
  store,
}: {
  initialJob: JobState;
  initialBatches: BatchRecord[];
  store: PublicStore | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const { snapshot, refresh } = useJobs();
  const hydrated = useHydrated();

  // The application-wide SSE stream already carries this run while it is going
  // — use the freshest copy from there, and fall back to the server-rendered
  // one once it has finished.
  const live = useMemo(
    () =>
      // `scheduled` is in this list too. It is a separate bucket in the snapshot
      // now, so leaving it out would have left a scheduled run's detail page
      // frozen on its server render — no countdown, and no update at the moment
      // it fires.
      [
        ...snapshot.running,
        ...snapshot.queued,
        ...snapshot.scheduled,
        ...snapshot.history,
      ].find((entry) => entry.id === initialJob.id),
    [snapshot, initialJob.id],
  );
  const job = live ?? initialJob;

  const [batches, setBatches] = useState(initialBatches);
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [resultsState, setResultsState] = useState<"loading" | "ready" | "error">("loading");
  const [resultsError, setResultsError] = useState<string | null>(null);

  const [filter, setFilter] = useState<ResultFilter>("all");
  const [query, setQuery] = useState("");

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [footprint, setFootprint] = useState<JobFootprint | null>(null);
  /** The runs this one shares a click with, so the group can be offered by size. */
  const [siblings, setSiblings] = useState<{ stoppable: number } | null>(null);
  const [busy, setBusy] = useState<"cancel" | "stop" | "retry" | "delete" | null>(null);

  const active = job.status === "running" || job.status === "queued";
  // One screen serves both kinds of run, but a few columns and labels are only
  // true of one. `job.kind` is the only discriminant.
  const purge = job.kind === "purge";
  /**
   * A bulk edit of products that already existed.
   *
   * Named separately from `purge` rather than lumped in with "not a purge", which is
   * exactly the mistake that let this kind render as an import when it was added:
   * every screen asked `kind === "purge"` and treated the remainder as one thing.
   */
  const edit = job.kind === "update";

  /**
   * The currency this run was REVIEWED under, stored on the run itself.
   *
   * Read from the run rather than from the account's current setting, for the same
   * reason the import options are: changing the account setting later must not
   * relabel a history somebody already read. Display only — it changed nothing on
   * any site.
   */
  const currency = purge
    ? ""
    : edit
      ? ((job.options as EditOptions).displayCurrency ?? "")
      : ((job.options as ImportOptions).displayCurrency ?? "");

  /**
   * Apply freshly read results to state.
   *
   * Deliberately does NOT raise a "loading" flag: this also runs every three
   * seconds while a run is going, and flagging on every tick would strobe the
   * table. The initial state is already "loading", and the retry button raises
   * the flag itself.
   */
  const applyResults = useCallback((payload: FetchedResults) => {
    if (payload.error !== null) {
      setResultsError(payload.error);
      setResultsState("error");
      return;
    }
    setResults(payload.results);
    setResultsState("ready");
  }, []);

  // Read once, and again whenever the run's status changes — particularly the
  // moment it finishes, otherwise the table freezes on a mid-run snapshot.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [fetched, batchRecords] = await Promise.all([
        fetchResults(job.id),
        fetchBatches(job.id),
      ]);

      if (cancelled) {
        return;
      }

      applyResults(fetched);
      if (batchRecords !== null) {
        setBatches(batchRecords);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [job.id, job.status, applyResults]);

  // While running: re-read every three seconds. Deliberately slower than the
  // progress bar's one-second beat — the results table is far heavier than a
  // few counters, and nobody needs each row to appear the instant it lands.
  useEffect(() => {
    if (!active) {
      return;
    }

    let cancelled = false;

    const timer = setInterval(() => {
      void (async () => {
        const [fetched, batchRecords] = await Promise.all([
          fetchResults(job.id),
          fetchBatches(job.id),
        ]);

        if (cancelled) {
          return;
        }

        applyResults(fetched);
        if (batchRecords !== null) {
          setBatches(batchRecords);
        }
      })();
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, job.id, applyResults]);

  /*
   * How many runs this click shares a group with.
   *
   * Read only when the run has a group and is still going, so an ordinary
   * single-site run costs nothing. The count is what lets the confirmation say
   * "cancel 5 runs" instead of quietly widening "cancel this run" into it —
   * those are different promises, and one press of Import against five sites is
   * how "I cancelled the import and it kept importing" happened.
   */
  useEffect(() => {
    if (job.groupId === null || !active) {
      // Deliberately NOT setSiblings(null) here — calling setState synchronously
      // in an effect body is an error in this codebase, not a warning. The
      // "no group" case is DERIVED below instead, which is the better shape
      // anyway: one source of truth rather than state mirroring a prop.
      return;
    }

    let dropped = false;

    void (async () => {
      const response = await fetch(`/api/jobs/${job.id}/cancel`).catch(() => null);
      if (dropped || response === null || !response.ok) {
        return;
      }
      const payload = (await response.json()) as { stoppable?: number };
      setSiblings({ stoppable: payload.stoppable ?? 0 });
    })();

    return () => {
      dropped = true;
    };
  }, [job.id, job.groupId, active]);

  /**
   * The group offer, or null when there is nothing to offer.
   *
   * Derived rather than stored: `siblings` holds whatever the last fetch found,
   * and this decides whether it is still relevant to the run on screen.
   */
  const groupOffer =
    job.groupId !== null && active && siblings !== null && siblings.stoppable > 1
      ? siblings
      : null;

  async function cancel(group: boolean) {
    setBusy("cancel");
    try {
      const response = await fetch(`/api/jobs/${job.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group }),
      });
      const payload = (await response.json()) as { count?: number; error?: string };

      if (!response.ok) {
        toast.error("Could not cancel", payload.error);
        return;
      }

      toast.success(
        group
          ? `Cancellation requested for ${payload.count ?? 0} run(s) in this batch`
          : "Cancellation requested",
        "Each lane finishes the batch it has already sent and then stops, so no product is cut off mid-write.",
      );
      await refresh();
    } finally {
      setBusy(null);
      setConfirmCancel(false);
    }
  }

  async function stop() {
    setBusy("stop");
    try {
      const response = await fetch(`/api/jobs/${job.id}/stop`, { method: "POST" });
      const payload = (await response.json()) as { warning?: string; error?: string };

      if (!response.ok) {
        toast.error("Could not stop the run", payload.error);
        return;
      }

      // The warning comes from the server rather than being written twice: it is
      // the same sentence that gets recorded on the run itself.
      toast.warn("Stopped", payload.warning);
      await refresh();
    } finally {
      setBusy(null);
      setConfirmStop(false);
    }
  }

  /** Ask what deleting this run would take with it, then confirm against that. */
  async function askDelete() {
    setBusy("delete");
    try {
      const response = await fetch("/api/jobs/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [job.id] }),
      });
      const payload = (await response.json()) as {
        footprints?: JobFootprint[];
        error?: string;
      };

      if (!response.ok) {
        toast.error("Could not work out what would be deleted", payload.error);
        return;
      }

      setFootprint(payload.footprints?.[0] ?? null);
      setConfirmDelete(true);
    } finally {
      setBusy(null);
    }
  }

  async function deleteRun() {
    setBusy("delete");
    try {
      const response = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        toast.error("Could not delete this run", payload.error);
        return;
      }

      toast.success("Run deleted", "Its results, batch figures and staged products went with it.");
      // The run no longer exists, so staying on its page would 404 on the next
      // read. Back to the list, which is where the operator was heading anyway.
      router.push("/process");
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  }

  async function retryFailed() {
    setBusy("retry");
    try {
      const response = await fetch(`/api/jobs/${job.id}/retry-failed`, { method: "POST" });
      const payload = (await response.json()) as { job?: JobState; error?: string };

      if (!response.ok || !payload.job) {
        toast.error("Could not resend", payload.error);
        return;
      }

      toast.success(
        `Created a new run with ${payload.job.total} failed row(s)`,
        "The idempotency keys are unchanged, so a row that did reach the site comes back as already present rather than becoming a second product.",
      );
      await refresh();
      router.push(`/process/${payload.job.id}`);
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => {
    if (results === null) {
      return [];
    }

    const needle = foldVietnamese(query.trim());

    return results.filter((result) => {
      if (filter === "failed" && result.ok) {
        return false;
      }
      if (filter === "created" && (!result.ok || result.deduplicated)) {
        return false;
      }
      if (filter === "deduplicated" && !result.deduplicated) {
        return false;
      }

      if (needle === "") {
        return true;
      }

      return foldVietnamese(
        `${result.sku ?? ""} ${result.product_id ?? ""} ${result.error?.code ?? ""} ${result.error?.message ?? ""}`,
      ).includes(needle);
    });
  }, [results, filter, query]);

  const counts = useMemo(() => {
    const list = results ?? [];
    return {
      all: list.length,
      created: list.filter((result) => result.ok && !result.deduplicated).length,
      deduplicated: list.filter((result) => result.deduplicated).length,
      failed: list.filter((result) => !result.ok).length,
    };
  }, [results]);

  /**
   * Does this run have per-field changes to show at all?
   *
   * Only the write modes produce them, so on an ordinary import or a removal the
   * column is left out entirely rather than rendered empty on every row.
   */
  const anyChanged = useMemo(
    () => (results ?? []).some((result) => result.changed !== undefined),
    [results],
  );

  const columns = useMemo<Column<RunResult>[]>(
    () => [
      {
        key: "index",
        header: "Row",
        width: "5rem",
        align: "right",
        sortable: true,
        sortValue: (result) => result.index,
        cell: (result) => (
          <span className="tnum text-xs text-ink-subtle">{result.index + 1}</span>
        ),
      },
      {
        key: "status",
        header: "Outcome",
        width: "10rem",
        sortable: true,
        sortValue: (result) => (!result.ok ? 2 : result.deduplicated ? 1 : 0),
        cell: (result) =>
          !result.ok ? (
            <Badge tone="bad" icon="alert-circle">
              Failed
            </Badge>
          ) : purge ? (
            <Badge tone="ok" icon="trash">
              Removed
            </Badge>
          ) : result.action === "updated" || edit ? (
            result.deduplicated ? (
              <Tooltip content="The product was already exactly as the file asked, so nothing was written.">
                <Badge tone="info" icon="layers">
                  Already correct
                </Badge>
              </Tooltip>
            ) : (
              <Tooltip content="A product already on the site was changed in place, keeping its id, its reviews and its URL.">
                <Badge tone="warn" icon="refresh">
                  Updated
                </Badge>
              </Tooltip>
            )
          ) : result.deduplicated ? (
            <Tooltip content="The idempotency key already existed — the plugin returned the original product and created NOTHING.">
              <Badge tone="info" icon="layers">
                Already present
              </Badge>
            </Tooltip>
          ) : (
            <Badge tone="ok" icon="check-circle">
              Created
            </Badge>
          ),
      },
      {
        key: "sku",
        header: "SKU",
        sortable: true,
        sortValue: (result) => result.sku ?? "",
        cell: (result) => (
          <span className="font-mono text-xs text-ink">{result.sku || "—"}</span>
        ),
      },
      // On a removal run the product name is the ONLY surviving record of what
      // went — the product is no longer on the site to open.
      ...(purge
        ? ([
            {
              key: "name",
              header: "Product removed",
              sortable: true,
              sortValue: (result: RunResult) => result.name ?? "",
              cell: (result: RunResult) => (
                <span className="block truncate text-xs text-ink">
                  {result.name || `#${result.product_id ?? "?"}`}
                </span>
              ),
            },
            {
              key: "removed",
              header: "Rows removed",
              width: "16rem",
              hideBelow: "md",
              cell: (result: RunResult) =>
                result.removed ? (
                  <Tooltip content={describeRemoved(result.removed)}>
                    <span className="tnum text-xs text-ink-muted">
                      {formatNumber(
                        Object.values(result.removed).reduce((sum, count) => sum + count, 0),
                      )}{" "}
                      rows
                    </span>
                  </Tooltip>
                ) : (
                  <span className="text-2xs text-ink-subtle">—</span>
                ),
            },
          ] satisfies Column<RunResult>[])
        : ([
            {
              key: "product",
              header: "Product on the site",
              width: "13rem",
              hideBelow: "md" as const,
              cell: (result: RunResult) =>
                result.product_id && store ? (
                  <a
                    href={adminProductUrl(store, result.product_id)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-accent-fg hover:underline"
                  >
                    <Icon name="external-link" className="size-3.5" />#{result.product_id}
                    {(result.variation_ids?.length ?? 0) > 0 ? (
                      <span className="text-ink-subtle">
                        · {result.variation_ids?.length} variations
                      </span>
                    ) : null}
                  </a>
                ) : (
                  <span className="text-2xs text-ink-subtle">—</span>
                ),
            },
          ] satisfies Column<RunResult>[])),
      // Only when the run actually produced one. An empty column on every import
      // run would be furniture.
      ...(anyChanged
        ? ([
            {
              key: "changed",
              header: "What changed",
              width: "20rem",
              cell: (result: RunResult) =>
                result.changed === undefined || Object.keys(result.changed).length === 0 ? (
                  <span className="text-2xs text-ink-subtle">—</span>
                ) : (
                  <ul className="space-y-0.5">
                    {Object.entries(result.changed).map(([field, change]) => (
                      <li key={field} className="flex flex-wrap items-baseline gap-1 text-2xs">
                        <span className="text-ink-subtle">{changedFieldLabel(field)}</span>
                        <span className="tnum text-ink-muted line-through">
                          {formatChangeSide(field, change.from, currency)}
                        </span>
                        <span className="text-ink-subtle">→</span>
                        <span className="tnum font-medium text-ink">
                          {formatChangeSide(field, change.to, currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ),
            },
          ] satisfies Column<RunResult>[])
        : []),
      {
        key: "error",
        header: "Why it failed",
        /*
         * The message is shown IN FULL. It used to be `truncate`, which is a CSS
         * ellipsis — so a message like "Field 'post_title' doesn't have a default
         * value" was cut to "Field 'post_titl…" and the one useful part of it was
         * the part removed. An error nobody can read is the same as no error.
         *
         * `whitespace-pre-wrap` keeps the plugin's own line breaks, and `break-words`
         * stops a long unbroken SQL fragment or URL from pushing the table sideways.
         */
        cell: (result) =>
          result.error ? (
            <div className="min-w-0 space-y-1 py-0.5">
              <Code>{result.error.code}</Code>
              <p className="whitespace-pre-wrap break-words text-xs text-bad-fg">
                {result.error.message}
              </p>
            </div>
          ) : (
            <span className="text-2xs text-ink-subtle">—</span>
          ),
      },
    ],
    [store, purge, edit, anyChanged, currency],
  );

  // A finished run has a fixed end and computes the same on both sides. A
  // running one ends at "now", which only the browser knows.
  const elapsed =
    job.finishedAt !== null || hydrated ? elapsedBetween(job.startedAt, job.finishedAt) : null;
  const perSecond =
    elapsed !== null && elapsed > 0 && job.processed > 0 ? job.processed / (elapsed / 1000) : null;

  const batchSpeeds = batches
    .filter((batch) => batch.elapsedMs !== null && batch.elapsedMs > 0)
    .map((batch) => (batch.size / (batch.elapsedMs as number)) * 1000);

  return (
    <div className="space-y-5">
      {/* ---------------------------------------------------------------- Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ButtonLink href="/process" size="sm" variant="ghost" icon="arrow-left">
              Activity
            </ButtonLink>
            <JobStatusPill job={job} />
            {job.retryOf ? (
              <ButtonLink
                href={`/process/${job.retryOf}`}
                size="sm"
                variant="ghost"
                icon="history"
              >
                Resent from an earlier run
              </ButtonLink>
            ) : null}
          </div>
          <h2 className="mt-1 truncate text-lg font-semibold text-ink">{job.sourceLabel}</h2>
          <p className="truncate text-xs text-ink-subtle">
            → {job.storeLabel} · created <DateTime iso={job.createdAt} />
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {/*
            Cancel and Stop deliberately do NOT look alike. Two buttons with the
            same weight and the same icon, doing different things to a live run, is
            worse than having only one — so Cancel is the ordinary secondary
            action and Stop is the dangerous one, and each says what it promises
            rather than just naming itself.
          */}
          {active ? (
            <>
              <Tooltip content="Each lane finishes the batch it has already sent and then stops. No product is cut off mid-write.">
                <Button
                  variant="secondary"
                  icon="stop"
                  loading={busy === "cancel"}
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel
                </Button>
              </Tooltip>
              <Tooltip content="Abandons the request in flight instead of waiting for it. For a site that has stopped answering — and the site may keep products the results do not list.">
                <Button
                  variant="danger"
                  icon="alert-triangle"
                  loading={busy === "stop"}
                  onClick={() => setConfirmStop(true)}
                >
                  Stop now
                </Button>
              </Tooltip>
            </>
          ) : null}

          {!active ? (
            <Tooltip content="Removes this run and everything hanging off it. The products already on the site are not touched.">
              <Button
                variant="ghost"
                icon="trash"
                loading={busy === "delete"}
                onClick={() => void askDelete()}
              >
                Delete
              </Button>
            </Tooltip>
          ) : null}

          {!active && job.failed > 0 ? (
            <Button
              variant="primary"
              icon="refresh"
              loading={busy === "retry"}
              onClick={() => void retryFailed()}
            >
              Resend {formatNumber(job.failed)} failed row(s)
            </Button>
          ) : null}

          <a
            href={`/api/jobs/${job.id}/results/export`}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-field-line bg-surface px-3.5 text-sm font-medium text-ink transition-colors duration-fast hover:bg-surface-sunken"
          >
            <Icon name="download" />
            Export CSV
          </a>
        </div>
      </div>

      {/*
        A Stop is not an error, and this field now carries both.
        "The run stopped on an error" over the Stop warning blames the site for
        something the operator chose to do — and worse, it dresses the one message
        that needs reading calmly in the language of a failure. Tone and title
        follow the CAUSE, not merely the presence of text in `error`.
      */}
      {job.error ? (
        <Alert
          tone={job.cancelMode === "stop" ? "warn" : "bad"}
          title={
            job.cancelMode === "stop"
              ? "This run was stopped immediately — what that means for the site"
              : "The run stopped on an error"
          }
        >
          {job.error}
        </Alert>
      ) : null}

      {store === null ? (
        <Alert tone="warn" title="This run's site has been removed">
          The results are still readable, but there is no site to link products to, and failures
          cannot be resent until the site is added again.
        </Alert>
      ) : null}

      {/* -------------------------------------------------------------- Progress */}
      <Panel title="Progress" icon="gauge">
        <div className="space-y-4">
          <ProgressBar
            value={job.processed}
            max={job.total}
            size="lg"
            tone={job.failed > 0 ? "warn" : job.status === "completed" ? "ok" : "accent"}
            label="Overall progress"
            indeterminate={job.status === "queued"}
          />

          <StackedBar
            total={job.total}
            size="md"
            segments={[
              { value: job.succeeded - job.deduplicated, tone: "ok", label: "Created" },
              {
                value: job.deduplicated,
                tone: "info",
                label: edit ? "Already correct" : "Already present",
              },
              { value: job.failed, tone: "bad", label: "Failed" },
            ]}
          />

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Processed"
              value={`${formatNumber(job.processed)}/${formatNumber(job.total)}`}
              icon="package"
              hint={`${jobPercent(job)}% · batch ${job.batchesDone}/${job.batches}`}
            />
            {/*
              "Created" is a lie on a run that created nothing.
              A bulk edit changes products that were already there, and a removal
              takes them away — printing "Created 2 · products genuinely created"
              over either is how somebody concludes the tool did the wrong thing.
              The three kinds get three words.
            */}
            <Stat
              label={edit ? "Changed" : purge ? "Removed" : "Created"}
              value={formatNumber(job.succeeded - job.deduplicated)}
              tone="ok"
              icon={edit ? "refresh" : purge ? "trash" : "check-circle"}
              hint={
                edit
                  ? job.deduplicated > 0
                    ? `${formatNumber(job.deduplicated)} were already exactly as asked, so nothing was written`
                    : "products changed in place, keeping their ids"
                  : job.deduplicated > 0
                    ? `${formatNumber(job.deduplicated)} row(s) already present, nothing recreated`
                    : purge
                      ? "products taken off the site"
                      : "products genuinely created"
              }
            />
            <Stat
              label="Failed"
              value={formatNumber(job.failed)}
              tone={job.failed > 0 ? "bad" : "neutral"}
              icon="alert-circle"
              hint={formatPercent(job.processed > 0 ? job.failed / job.processed : null)}
            />
            <Stat
              label="Speed"
              value={formatThroughput(perSecond)}
              icon="zap"
              hint={
                elapsed === null
                  ? "not started"
                  : `${formatDuration(elapsed)} wall clock`
              }
            />
          </div>
        </div>
      </Panel>

      {/* ------------------------------------------------------------- Per batch */}
      <div className="grid gap-5 xl:grid-cols-[2fr_1fr]">
        <Panel
          title="Speed batch by batch"
          icon="activity"
          description={`${batches.length} batch(es) done · elapsed_ms comes from the plugin itself`}
        >
          {batches.length === 0 ? (
            <EmptyState
              icon="activity"
              title="No batch has finished yet"
              description="Batch figures appear the moment the plugin answers the first one."
              action={
                <ButtonLink href="/process" variant="secondary" icon="arrow-left">
                  Back to activity
                </ButtonLink>
              }
            />
          ) : (
            <div className="space-y-4">
              <Sparkline
                values={batchSpeeds}
                label={`Speed per batch, from ${batchSpeeds[0]?.toFixed(1) ?? 0} to ${batchSpeeds[batchSpeeds.length - 1]?.toFixed(1) ?? 0} products per second`}
                height={64}
                tone="accent"
              />

              <div className="scroll-frame max-h-72 overflow-y-auto">
                <table className="w-full min-w-[32rem] border-collapse text-sm">
                  <caption className="sr-only">Figures for each batch</caption>
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-line">
                      {["Batch", "Size", "Plugin (elapsed_ms)", "Wall clock", "Speed", "Outcome"].map(
                        (header) => (
                          <th
                            key={header}
                            scope="col"
                            className="px-2 py-2 text-left text-2xs font-semibold tracking-wide text-ink-subtle uppercase"
                          >
                            {header}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((batch) => (
                      <tr key={batch.index} className="border-b border-line last:border-0">
                        <td className="tnum px-2 py-1.5 text-xs text-ink-subtle">
                          #{batch.index + 1}
                        </td>
                        <td className="tnum px-2 py-1.5 text-xs">{batch.size}</td>
                        <td className="tnum px-2 py-1.5 text-xs">
                          {batch.elapsedMs === null ? (
                            <Tooltip content="The whole batch died before the plugin answered, so there is no elapsed_ms.">
                              <span className="text-ink-subtle">—</span>
                            </Tooltip>
                          ) : (
                            formatDuration(batch.elapsedMs)
                          )}
                        </td>
                        <td className="tnum px-2 py-1.5 text-xs text-ink-muted">
                          {formatDuration(batch.wallMs)}
                        </td>
                        <td className="tnum px-2 py-1.5 text-xs">
                          {batch.elapsedMs && batch.elapsedMs > 0
                            ? formatThroughput((batch.size / batch.elapsedMs) * 1000)
                            : "—"}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="flex flex-wrap gap-1">
                            {batch.succeeded - batch.deduplicated > 0 ? (
                              <Badge tone="ok">{batch.succeeded - batch.deduplicated}</Badge>
                            ) : null}
                            {batch.deduplicated > 0 ? (
                              <Badge tone="info">{batch.deduplicated}</Badge>
                            ) : null}
                            {batch.failed > 0 ? <Badge tone="bad">{batch.failed}</Badge> : null}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Panel>

        <Panel title="Options used" icon="settings">
          <DescriptionList
            columns={1}
            items={[
              ...(job.kind === "purge"
                ? purgeOptionItems(job.options as PurgeOptions)
                : edit
                  ? editOptionItems(job.options as EditOptions)
                  : importOptionItems(job.options as ImportOptions)),
              {
                term: "Timing",
                value: (
                  <>
                    <DateTime iso={job.startedAt} /> → <DateTime iso={job.finishedAt} />
                  </>
                ),
                hint:
                  job.pluginElapsedMs > 0
                    ? `The plugin worked ${formatDuration(job.pluginElapsedMs)} in total (summed across batches that ran in parallel)`
                    : undefined,
                wide: true,
              },
            ]}
          />
        </Panel>
      </div>

      {purge && results !== null ? <RemovalEvidence results={results} /> : null}

      {/* --------------------------------------------------------- Per-row results */}
      <Panel
        title="Per-row results"
        icon="file"
        padded={false}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              icon="search"
              placeholder="Search by SKU or error code…"
              aria-label="Search the results"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 w-52 text-xs"
            />
            <Segmented
              label="Filter the results"
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All (${counts.all})` },
                {
                  value: "created",
                  // Same reason as the headline stat: this tab must not say
                  // "Created" over rows that changed a product already on the site.
                  label: `${edit ? "Changed" : purge ? "Removed" : "Created"} (${counts.created})`,
                },
                {
                  value: "deduplicated",
                  label: `${edit ? "Already correct" : "Already present"} (${counts.deduplicated})`,
                },
                { value: "failed", label: `Failed (${counts.failed})` },
              ]}
            />
          </div>
        }
      >
        {resultsState === "loading" && results === null ? (
          <SkeletonTable rows={8} columns={5} className="p-4" />
        ) : resultsState === "error" ? (
          <div className="p-4">
            <ErrorState
              title="Could not read the results"
              message={resultsError ?? "Unknown error."}
              hint="Results are kept for 7 days. If this run has aged out, its rows have been cleaned up."
              onRetry={() => {
                setResultsState("loading");
                setResultsError(null);
                void fetchResults(job.id).then(applyResults);
              }}
            />
          </div>
        ) : (
          <DataTable
            caption="Per-row results for this run"
            rows={filtered}
            columns={columns}
            rowKey={(result) => String(result.index)}
            defaultSort={{ key: "index", direction: "asc" }}
            rowTone={(result) => (!result.ok ? "bad" : result.deduplicated ? "none" : "none")}
            dense
            empty={
              counts.all === 0 ? (
                <EmptyState
                  icon="clock"
                  title={active ? "No row has finished yet" : "No results"}
                  description={
                    active
                      ? "Results are written after EVERY batch, so they will appear here as they land."
                      : "This run processed nothing — it was probably cancelled before its first batch."
                  }
                  action={
                    <ButtonLink href="/process" variant="secondary" icon="arrow-left">
                      Back to activity
                    </ButtonLink>
                  }
                />
              ) : (
                <EmptyState
                  icon="search"
                  title="No row matches the filter"
                  description="Change the search term, or pick a different filter above."
                  action={
                    <Button
                      variant="secondary"
                      icon="refresh"
                      onClick={() => {
                        setFilter("all");
                        setQuery("");
                      }}
                    >
                      Clear the filter
                    </Button>
                  }
                />
              )
            }
          />
        )}
      </Panel>

      {/*
        The failed products, kept as a list, with BOTH ways out of the situation.
        They are not interchangeable, and offering only one is what made this feel
        like a dead end:

          - Resend  — the SITE was at fault (timeout, a lock, a dropped connection).
                      The data is fine, so send exactly the same rows again.
          - Download — the DATA was at fault (a missing name, a price that is not a
                      number, a category that does not exist). Resending identical
                      rows would fail identically; the file has to be corrected first.

        The error code on each row is what tells them apart, which is why the results
        table now shows the message in full rather than cutting it off.
      */}
      {counts.failed > 0 && !active ? (
        <Card tone="accent">
          <CardBody className="space-y-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-accent-fg">
                {formatNumber(counts.failed)} product(s) failed — the list is kept
              </p>
              <p className="text-xs text-accent-fg opacity-90">
                Every failed row is below with its full error, and stays on record for as long as
                this run does. Nothing has to be found again by hand.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Tooltip content="Creates a new run with exactly these rows. The idempotency keys are unchanged, so a row that did reach the site comes back as already present rather than becoming a second product.">
                <Button
                  variant="primary"
                  icon="refresh"
                  loading={busy === "retry"}
                  disabled={store === null}
                  onClick={() => void retryFailed()}
                >
                  Resend these {formatNumber(counts.failed)} product(s)
                </Button>
              </Tooltip>

              {/* A real link rather than a scripted download: a plain GET the server
                  already serves, and script-driven saves can be blocked. */}
              <Tooltip content="A CSV of only the failed rows, with the error on each one — fix it in a spreadsheet and import it as a new file.">
                <a
                  href={`/api/jobs/${job.id}/results/export?only=failed`}
                  download
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-accent-border px-3 text-xs font-medium text-accent-fg transition-colors duration-fast hover:bg-accent-soft"
                >
                  <Icon name="download" className="size-3.5" />
                  Download the failed rows
                </a>
              </Tooltip>

              <button
                type="button"
                onClick={() => setFilter("failed")}
                className="text-xs text-accent-fg underline-offset-2 hover:underline"
              >
                Show only the failures below
              </button>
            </div>

            <p className="text-2xs text-accent-fg opacity-80">
              Resend when the SITE was at fault — a timeout, a lock, a dropped connection. Download
              and fix the file when the DATA was at fault: resending identical rows fails
              identically. The error code on each row says which.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {/*
        Last thing on the page, deliberately.
        It is the most detailed and least summarised panel here — putting it above
        the numbers would mean scrolling past a thousand lines to reach the summary.
      */}
      <RunLog jobId={job.id} active={active} />

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => void cancel(false)}
        busy={busy === "cancel"}
        title="Cancel this run?"
        confirmLabel="Cancel this run"
        message={
          <>
            <p>
              Cancelling does NOT kill the job mid-flight. Each lane finishes the batch it has
              already sent and then stops, so no product is cut off while it is being written to the
              database.
            </p>
            <p className="mt-2">
              The {formatNumber(job.processed)} products already processed stay on the site.
            </p>
            <p className="mt-2">
              If the site has stopped answering altogether, this will wait for the request already
              in flight to time out. <strong>Stop now</strong> is the one that does not wait.
            </p>

            {/*
              The group is offered explicitly, with its real size, and never
              folded into the button above. "Cancel this run" and "cancel 5 runs"
              are different promises: one press of Import against five sites
              creates five runs, and silently widening the first into the second
              would be the same dishonesty as the bug this fixes.
            */}
            {groupOffer !== null ? (
              <div className="mt-3 rounded-md border border-warn-border bg-warn-soft p-2.5">
                <p className="text-xs text-warn-fg">
                  This run is one of <strong>{formatNumber(groupOffer.stoppable)}</strong> still going
                  from the same press of Import. Cancelling this one leaves the other{" "}
                  {formatNumber(groupOffer.stoppable - 1)} running.
                </p>
                <Button
                  size="sm"
                  variant="danger"
                  icon="stop"
                  className="mt-2"
                  loading={busy === "cancel"}
                  onClick={() => void cancel(true)}
                >
                  Cancel all {formatNumber(groupOffer.stoppable)} runs in this batch
                </Button>
              </div>
            ) : null}
          </>
        }
      />

      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => void stop()}
        busy={busy === "stop"}
        title="Stop this run immediately?"
        confirmLabel="Stop now"
        message={
          <>
            <p>
              This abandons the request that is in flight rather than waiting for it. Use it when a
              site has accepted the connection and stopped answering — the case where Cancel appears
              to do nothing because there is no batch boundary to reach.
            </p>
            {/*
              The removal screen sets the standard for this kind of honesty, and
              this is the same shape of admission: say what is NOT guaranteed,
              before the press, in the same words that get recorded on the run.
            */}
            <p className="mt-2">
              <strong>What this cannot promise:</strong> the plugin may already have committed the
              batch it was sent. The site can end up holding products that are{" "}
              <strong>not listed in the results table</strong>, because this app never saw the answer
              for them. Check the site before importing the same file again — the idempotency keys
              mean a second import returns the existing products rather than creating duplicates.
            </p>
            <p className="mt-2">
              If the site is merely slow rather than stuck, <strong>Cancel</strong> is the safer
              choice: it stops at a batch boundary and everything it sent is accounted for.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void deleteRun()}
        busy={busy === "delete"}
        title="Delete this run?"
        confirmLabel={
          footprint === null
            ? "Delete the run"
            : `Delete ${formatNumber(footprint.total)} row(s)`
        }
        message={
          <>
            <p>
              This removes the run and everything hanging off it
              {footprint === null ? (
                "."
              ) : (
                <>
                  : <strong>{formatNumber(footprint.results)}</strong> result row(s),{" "}
                  <strong>{formatNumber(footprint.batches)}</strong> batch record(s),{" "}
                  <strong>{formatNumber(footprint.logs)}</strong> log line(s) and the staged product
                  payload — <strong>{formatNumber(footprint.total)}</strong> rows in total. For a run
                  this size that cascade is the only way to reclaim the space.
                </>
              )}
            </p>
            <p className="mt-2">
              The {formatNumber(job.succeeded)} products already published are{" "}
              <strong>not</strong> touched. This deletes the record of the run, not its effect — use{" "}
              <strong>Remove products</strong> for that.
            </p>
            <p className="mt-2">There is no undo.</p>
          </>
        }
      />
    </div>
  );
}

/* ========================================================================== */

/**
 * The options shown have to be the options of the RIGHT kind of run.
 *
 * `job.kind` is the discriminant: a removal has no image mode, and an import has
 * no "delete the files too". Merging them into one list of optional fields is a
 * reliable way to print "undefined" on half the rows.
 */
/**
 * A bulk edit's options.
 *
 * `describeEdit` is the same function the run's `sourceLabel` was built from, so the
 * sentence here and the one on the Activity screen cannot drift apart.
 */
function editOptionItems(options: EditOptions): DescriptionItem[] {
  return [
    { term: "Change", value: describeEdit(options.operation), wide: true },
    {
      term: "Throughput",
      value: `${options.threads} parallel · ${options.batchSize} products per batch`,
    },
    {
      term: "What it could not do",
      value:
        "An update never writes images, slugs, attributes or the variation set, and never " +
        "clears a field the change did not name.",
      wide: true,
    },
  ];
}

function importOptionItems(options: ImportOptions): DescriptionItem[] {
  return [
    { term: "Mode", value: IMPORT_MODE_LABELS[options.mode] },
    // Which of the three write modes this run used. On the run rather than only in
    // the wizard: "did this run overwrite existing products?" is the first question
    // anybody asks about a repriced catalogue, and the answer has to survive.
    { term: "Existing products", value: WRITE_MODE_LABELS[options.writeMode] },
    { term: "Images", value: IMAGE_MODE_LABELS[options.imageMode] },
    {
      term: "Lanes / batch",
      value: `${options.threads} parallel · ${options.batchSize} products per batch`,
    },
    {
      term: "Handling",
      value: (
        <span className="flex flex-wrap gap-1">
          {options.flattenVariants ? <Badge tone="neutral">Variants flattened</Badge> : null}
          {options.addRandomSuffixToSlug ? <Badge tone="neutral">Random slug suffix</Badge> : null}
          {options.keepProductAttributes ? <Badge tone="neutral">Attributes kept</Badge> : null}
          {options.autoSku ? (
            <Badge tone="neutral">Auto SKU: {options.autoSkuPattern}</Badge>
          ) : null}
          {options.skipRepeatedSku ? <Badge tone="neutral">Repeated SKUs skipped</Badge> : null}
        </span>
      ),
      wide: true,
    },
    {
      term: "Forced terms",
      value:
        options.forceCategory || options.forceTag
          ? `${options.forceCategory || "—"} / ${options.forceTag || "—"}`
          : "none",
      wide: true,
    },
  ];
}

function purgeOptionItems(options: PurgeOptions): DescriptionItem[] {
  return [
    { term: "Selection", value: PURGE_SELECTION_LABELS[options.selection.kind], wide: true },
    {
      term: "Image files",
      value: options.deleteImages ? (
        <Badge tone="warn">Deleted from uploads too</Badge>
      ) : (
        <Badge tone="neutral">Left on disk</Badge>
      ),
      wide: true,
    },
    {
      term: "Lanes / batch",
      value: `${options.threads} parallel · ${options.batchSize} products per batch`,
    },
  ];
}

/** The tooltip names each table, so the total is not something to take on trust. */
/**
 * A field name from the plugin's `changed` map, in words.
 *
 * `custom_meta.foo` keeps its key: the operator chose that key, and inventing a
 * label for it would hide which meta was written.
 */
function changedFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    name: "Name",
    sku: "SKU",
    slug: "Slug",
    description: "Description",
    short_description: "Short description",
    status: "Status",
    price: "Price",
    regular_price: "Regular price",
    sale_price: "Sale price",
    stock: "Stock",
    manage_stock: "Manage stock",
    instock: "Availability",
    categories: "Categories",
    tags: "Tags",
    shipping_class: "Shipping class",
  };

  return labels[field] ?? field;
}

/**
 * One side of a change, formatted for reading.
 *
 * The money fields go through `formatMoney` so the run's own recorded currency is
 * applied — the same number the operator was looking at when they pressed Start.
 * Everything else is shown verbatim, and an empty value is named rather than left
 * as a blank gap, because "cleared" and "not shown" must not look the same.
 */
function formatChangeSide(
  field: string,
  value: string | string[],
  currency: string,
): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? "(none)" : value.join(", ");
  }

  if (value === "") {
    return "(empty)";
  }

  if (field === "price" || field === "regular_price" || field === "sale_price") {
    return formatMoney(value, currency);
  }

  if (field === "description" || field === "short_description") {
    // A description can be kilobytes of HTML. The length is the useful fact in a
    // table cell; the full value is on the product itself.
    return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  }

  return value;
}

function describeRemoved(removed: Record<string, number>): string {
  return REMOVED_TABLES.filter((table) => (removed[table.key] ?? 0) > 0)
    .map((table) => `${table.label}: ${removed[table.key]}`)
    .join(" · ");
}

/**
 * The evidence for a removal run.
 *
 * "40 products deleted" is a claim. This is evidence: every table in the
 * database, with the exact number of rows that left it. It is the only way to
 * know for certain that nothing orphaned stayed behind.
 */
function RemovalEvidence({ results }: { results: RunResult[] }) {
  const totals = sumRemoved(results);
  const rows = REMOVED_TABLES.filter((table) => (totals[table.key] ?? 0) > 0);

  if (rows.length === 0) {
    return null;
  }

  return (
    <Panel
      title="Removed from the database"
      icon="trash"
      description="Counted per table, summed across the run"
    >
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {rows.map((table) => (
          <Stat
            key={table.key}
            label={table.label}
            value={formatNumber(totals[table.key] ?? 0)}
            icon={table.key === "files" ? "image" : "database"}
          />
        ))}
      </div>
    </Panel>
  );
}
