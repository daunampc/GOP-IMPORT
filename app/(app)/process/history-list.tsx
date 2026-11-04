"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import { JobStatusPill } from "@/components/domain/job-status";
import {
  Badge,
  Checkbox,
  DateTime,
  ElapsedTime,
  Icon,
  RelativeTime,
  Select,
  StackedBar,
  cn,
  foldVietnamese,
} from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { JobState } from "@/lib/jobs";

/**
 * The History tab.
 *
 * A list of cards rather than a table, for one reason that was the whole complaint:
 * a table cell takes the width of its longest content, so a long source title pushed
 * the table past the panel and the panel scrolled sideways. Here every piece of text
 * lives in a `min-w-0` column that WRAPS, and nothing in the row has a width of its
 * own, so no title — however long, with or without spaces — can widen the page.
 *
 * Runs resent before resends were merged into their original are still in the
 * database as runs of their own. They are shown under the run they were resent from,
 * so it is visible which run is whose, instead of as unrelated lines further down.
 */

export type HistorySort = "newest" | "oldest" | "failures" | "name";

const SORTS: Array<{ value: HistorySort; label: string }> = [
  { value: "newest", label: "Date — newest first" },
  { value: "oldest", label: "Date — oldest first" },
  { value: "failures", label: "Most failed rows" },
  { value: "name", label: "Name A–Z" },
];

/** When a run is "from": it finishing, or failing that, being created. */
function dateOf(job: JobState): string {
  return job.finishedAt ?? job.createdAt;
}

function compare(sort: HistorySort): (left: JobState, right: JobState) => number {
  switch (sort) {
    case "oldest":
      return (left, right) => dateOf(left).localeCompare(dateOf(right));
    case "failures":
      return (left, right) =>
        right.failed - left.failed || dateOf(right).localeCompare(dateOf(left));
    case "name":
      return (left, right) =>
        left.sourceLabel.localeCompare(right.sourceLabel, "vi") ||
        dateOf(right).localeCompare(dateOf(left));
    default:
      return (left, right) => dateOf(right).localeCompare(dateOf(left));
  }
}

export function HistoryList({
  jobs,
  everything,
  query,
  selected,
  onSelectedChange,
  empty,
}: {
  /** The finished runs to show. */
  jobs: JobState[];
  /** Every run there is, so a run's resends can be found wherever they are. */
  everything: JobState[];
  query: string;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Shown when there is nothing at all, not when a search finds nothing. */
  empty: ReactNode;
}) {
  const router = useRouter();
  const [sort, setSort] = useState<HistorySort>("newest");

  const { roots, resendsOf } = useMemo(() => {
    const present = new Set(jobs.map((job) => job.id));
    const byParent = new Map<string, JobState[]>();

    for (const job of everything) {
      if (job.retryOf !== null) {
        byParent.set(job.retryOf, [...(byParent.get(job.retryOf) ?? []), job]);
      }
    }

    // A resend is nested only under a parent that is itself on this list; one whose
    // original is gone stands on its own rather than disappearing.
    const top = jobs.filter((job) => job.retryOf === null || !present.has(job.retryOf));

    return { roots: top, resendsOf: byParent };
  }, [jobs, everything]);

  const visible = useMemo(() => {
    const needle = foldVietnamese(query.trim());

    const matches = (job: JobState): boolean =>
      needle === "" ||
      foldVietnamese(`${job.sourceLabel} ${job.storeLabel} ${job.storeUrl}`).includes(needle);

    return roots
      .filter((job) => matches(job) || (resendsOf.get(job.id) ?? []).some(matches))
      .sort(compare(sort));
  }, [roots, resendsOf, query, sort]);

  const selectable = useMemo(
    () => visible.flatMap((job) => [job, ...(resendsOf.get(job.id) ?? [])]).map((job) => job.id),
    [visible, resendsOf],
  );

  const allSelected = selectable.length > 0 && selectable.every((id) => selected.has(id));
  const someSelected = selectable.some((id) => selected.has(id));

  function toggle(id: string, on: boolean): void {
    const next = new Set(selected);

    if (on) {
      next.add(id);
    } else {
      next.delete(id);
    }

    onSelectedChange(next);
  }

  if (jobs.length === 0) {
    return <>{empty}</>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2">
        <Checkbox
          label={<span className="text-xs text-ink-muted">Select all ({formatNumber(selectable.length)})</span>}
          checked={allSelected}
          indeterminate={someSelected}
          onChange={(on) => onSelectedChange(on ? new Set(selectable) : new Set())}
        />

        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="shrink-0">Sort by</span>
          <Select
            aria-label="Sort history"
            value={sort}
            onChange={(event) => setSort(event.target.value as HistorySort)}
            className="h-8 text-xs"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-ink-subtle">
          No finished run matches “{query.trim()}”.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((job) => {
            const resends = [...(resendsOf.get(job.id) ?? [])].sort(
              (left, right) => left.createdAt.localeCompare(right.createdAt),
            );

            return (
              <li key={job.id}>
                <RunRow
                  job={job}
                  selected={selected.has(job.id)}
                  onToggle={(on) => toggle(job.id, on)}
                  onOpen={() => router.push(`/process/${job.id}`)}
                />

                {resends.map((resend) => (
                  <RunRow
                    key={resend.id}
                    job={resend}
                    nested
                    selected={selected.has(resend.id)}
                    onToggle={(on) => toggle(resend.id, on)}
                    onOpen={() => router.push(`/process/${resend.id}`)}
                  />
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RunRow({
  job,
  nested = false,
  selected,
  onToggle,
  onOpen,
}: {
  job: JobState;
  /** A resend, drawn under the run it was made from. */
  nested?: boolean;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}) {
  function onKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      onOpen();
    }
  }

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onKey}
      className={cn(
        "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-4 py-3 transition-colors duration-fast hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none",
        nested && "ml-6 border-l-2 border-line bg-surface-sunken/40 py-2.5 pl-3",
        selected && "bg-accent-soft hover:bg-accent-soft",
        job.status === "failed" && !selected && "bg-bad-soft/40",
      )}
    >
      <span
        className="pt-0.5"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Checkbox
          label={<span className="sr-only">Select {job.sourceLabel}</span>}
          checked={selected}
          onChange={onToggle}
        />
      </span>

      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <p
            title={job.sourceLabel}
            className="min-w-0 flex-1 basis-56 text-sm font-medium text-ink [overflow-wrap:anywhere] line-clamp-2"
          >
            {nested ? (
              <Icon name="history" className="mr-1.5 inline size-3.5 align-[-2px] text-ink-subtle" />
            ) : null}
            {job.sourceLabel}
          </p>
          <JobStatusPill job={job} />
        </div>

        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-subtle">
          <span className="max-w-full truncate" title={job.storeLabel}>
            → {job.storeLabel}
          </span>
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">
            <DateTime iso={dateOf(job)} /> (<RelativeTime iso={dateOf(job)} />)
          </span>
          {job.startedAt ? (
            <>
              <span aria-hidden>·</span>
              <span className="tnum whitespace-nowrap">
                took <ElapsedTime from={job.startedAt} to={job.finishedAt} />
              </span>
            </>
          ) : null}
          {job.groupId ? (
            <>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">multi-site batch</span>
            </>
          ) : null}
          {nested ? (
            <>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">resend of the run above</span>
            </>
          ) : null}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StackedBar
            total={job.total}
            size="sm"
            className="w-40 max-w-full"
            segments={[
              { value: job.succeeded - job.deduplicated, tone: "ok", label: "Created" },
              { value: job.deduplicated, tone: "info", label: "Already present" },
              { value: job.failed, tone: "bad", label: "Failed" },
            ]}
          />
          <span className="flex flex-wrap items-center gap-1">
            <Badge tone="ok">{formatNumber(job.succeeded)} ok</Badge>
            {job.deduplicated > 0 ? (
              <Badge tone="info">{formatNumber(job.deduplicated)} present</Badge>
            ) : null}
            {job.failed > 0 ? <Badge tone="bad">{formatNumber(job.failed)} failed</Badge> : null}
            <span className="tnum text-2xs text-ink-subtle">of {formatNumber(job.total)}</span>
          </span>
        </div>

        {job.error ? (
          <p className="flex min-w-0 items-start gap-1 text-xs text-bad-fg">
            <Icon name="alert-circle" className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere] line-clamp-2" title={job.error}>
              {job.error}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
