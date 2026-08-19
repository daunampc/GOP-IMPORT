"use client";

import Link from "next/link";
import { useState } from "react";

import { JobStatusPill } from "@/components/domain/job-status";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Panel,
  ProgressBar,
  RelativeTime,
  Stat,
  useToast,
  type Column,
} from "@/components/ui";
import { formatNumber } from "@/lib/format";
import { JOB_KIND_ICONS, JOB_KIND_LABELS, JOB_KIND_TONES } from "@/lib/job-display";
import type { AllJobsSnapshot, OwnedJobState } from "@/lib/jobs";

/**
 * Every account's runs, in one place, with the owning account on every row.
 *
 * The point of the owner column is that it is never absent. A cross-account
 * list where you have to click a row to find out whose it is invites reading
 * one customer's numbers as another's — the whole reason this screen exists is
 * to see the difference.
 */
export function AllRunsPanel({ initial }: { initial: AllJobsSnapshot }) {
  const toast = useToast();
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  const live = [...snapshot.running, ...snapshot.queued, ...snapshot.scheduled];
  const all = [...live, ...snapshot.history];

  async function refresh() {
    const response = await fetch("/api/admin/jobs", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    setSnapshot((await response.json()) as AllJobsSnapshot);
  }

  async function cancel(job: OwnedJobState) {
    setBusy(job.id);
    try {
      const response = await fetch("/api/admin/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [job.id] }),
      });

      const payload = (await response.json()) as { count?: number; error?: string };

      if (!response.ok) {
        toast.error("Could not cancel that run", payload.error);
        return;
      }

      toast.success(
        "Cancelling",
        `The worker stops ${job.ownerEmail}'s run at the next batch boundary, never mid-write.`,
      );
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<OwnedJobState>[] = [
    {
      key: "owner",
      header: "Account",
      sortable: true,
      sortValue: (row) => row.ownerEmail,
      cell: (row) => <span className="truncate font-medium text-ink">{row.ownerEmail}</span>,
    },
    {
      key: "kind",
      header: "Kind",
      width: "6rem",
      // Keyed off JOB_KIND_LABELS rather than a ternary: a ternary is what let the
      // `update` kind be labelled "Import" on every screen when it was added.
      cell: (row) => (
        <Badge tone={JOB_KIND_TONES[row.kind]} icon={JOB_KIND_ICONS[row.kind]}>
          {JOB_KIND_LABELS[row.kind]}
        </Badge>
      ),
    },
    {
      key: "source",
      header: "Source",
      hideBelow: "md",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{row.sourceLabel}</p>
          <p className="truncate text-2xs text-ink-subtle">{row.storeLabel}</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "8rem",
      cell: (row) => <JobStatusPill job={row} />,
    },
    {
      key: "progress",
      header: "Progress",
      width: "12rem",
      cell: (row) => (
        <div className="space-y-1">
          <ProgressBar
            value={row.total === 0 ? 0 : (row.processed / row.total) * 100}
            tone={row.failed > 0 ? "warn" : "accent"}
          />
          <p className="text-2xs text-ink-subtle">
            {formatNumber(row.processed)} / {formatNumber(row.total)}
          </p>
        </div>
      ),
    },
    {
      key: "createdAt",
      header: "Started",
      hideBelow: "lg",
      width: "9rem",
      sortable: true,
      sortValue: (row) => row.createdAt,
      cell: (row) => <RelativeTime iso={row.createdAt} />,
    },
    {
      key: "action",
      header: "",
      align: "right",
      width: "10rem",
      cell: (row) => (
        <div className="flex justify-end gap-2">
          {row.status === "running" || row.status === "queued" ? (
            <Button
              variant="ghost"
              size="sm"
              icon="stop"
              loading={busy === row.id}
              onClick={() => void cancel(row)}
            >
              Cancel
            </Button>
          ) : null}
          <Link
            href={`/process/${row.id}`}
            className="text-2xs font-medium text-accent-fg underline-offset-2 hover:underline"
          >
            Open
          </Link>
        </div>
      ),
    },
  ];

  return (
    <Panel
      title="All runs"
      icon="activity"
      description="Every account's activity, with the owning account on every row"
      actions={
        <Button variant="secondary" size="sm" icon="refresh" onClick={() => void refresh()}>
          Refresh
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Running" value={formatNumber(snapshot.running.length)} icon="play" />
          <Stat label="Queued" value={formatNumber(snapshot.queued.length)} icon="clock" />
          {/* Kept apart from Queued: a queue of forty runs waiting for next
              Tuesday is not a worker forty runs behind, and an operator looking
              at this panel to judge load needs to tell them apart. */}
          <Stat label="Scheduled" value={formatNumber(snapshot.scheduled.length)} icon="clock" />
          <Stat label="In history" value={formatNumber(snapshot.history.length)} icon="history" />
        </div>

        {all.length === 0 ? (
          <EmptyState
            icon="activity"
            title="No runs on the system yet"
            description="Every account's imports and removals will appear here as they are started."
            action={null}
          />
        ) : (
          <DataTable
            rows={all}
            columns={columns}
            rowKey={(row) => row.id}
            caption="Every account's runs, newest first"
            defaultSort={{ key: "createdAt", direction: "desc" }}
          />
        )}
      </div>
    </Panel>
  );
}
