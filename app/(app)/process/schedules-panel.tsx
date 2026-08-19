"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  Alert,
  Badge,
  Button,
  DataTable,
  DateTime,
  Panel,
  RelativeTime,
  useToast,
  type Column,
} from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { Schedule } from "@/lib/schedules";

/**
 * The repeating series this account has — §6 C2.
 *
 * Its data arrives as a prop from the server-rendered page rather than from a fetch
 * on mount: reading the clock or setting state in an effect is what produces
 * hydration error #418 and trips `react-hooks/set-state-in-effect`, and the times on
 * this panel all go through the client-time components for the same reason.
 *
 * The series are listed APART from the runs, because they are not runs. Each
 * occurrence appears in the Scheduled tab below as an ordinary run with its own
 * results and its own Cancel; this panel is where the series itself is paused or
 * deleted.
 */
export function SchedulesPanel({ schedules }: { schedules: Schedule[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (schedules.length === 0) {
    // Nothing to say when there are none: the wizard is where one is made, and an
    // empty panel on the busiest screen in the app would be furniture.
    return null;
  }

  async function act(schedule: Schedule, action: "pause" | "resume" | "delete") {
    setBusy(schedule.id);

    try {
      const response = await fetch(`/api/schedules/${schedule.id}`, {
        method: action === "delete" ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: action === "delete" ? undefined : JSON.stringify({ paused: action === "pause" }),
      });

      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        toast.error("Could not change the repeating run", payload.error);
        return;
      }

      toast.success(
        action === "delete"
          ? "Repeating run deleted"
          : action === "pause"
            ? "Repeating run paused"
            : "Repeating run started again",
        action === "delete"
          ? "The occurrence it had waiting was dropped. The runs that already happened are untouched."
          : action === "pause"
            ? "The occurrence it had waiting was dropped. Its products are still staged, so starting it again needs no file read."
            : "A fresh occurrence is staged, due at the next interval.",
      );

      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<Schedule>[] = [
    {
      key: "source",
      header: "What repeats",
      cell: (row) => (
        <div className="min-w-0">
          <span className="block truncate text-sm text-ink">{row.sourceLabel}</span>
          <span className="block truncate text-2xs text-ink-subtle">
            {formatNumber(row.total)} product(s) → {row.storeLabel}
          </span>
        </div>
      ),
    },
    {
      key: "every",
      header: "How often",
      width: "9rem",
      cell: (row) => <span className="text-xs text-ink-muted">{describeInterval(row.everyMinutes)}</span>,
    },
    {
      key: "next",
      header: "Next run",
      width: "13rem",
      cell: (row) =>
        row.paused ? (
          <Badge tone="warn">Paused</Badge>
        ) : (
          <span className="flex flex-col">
            <DateTime iso={row.nextRunAt} />
            <span className="text-2xs text-ink-subtle">
              <RelativeTime iso={row.nextRunAt} />
            </span>
          </span>
        ),
    },
    {
      key: "last",
      header: "Last fired",
      width: "11rem",
      hideBelow: "lg",
      cell: (row) =>
        row.lastFiredAt === null ? (
          <span className="text-xs text-ink-subtle">never yet</span>
        ) : (
          <RelativeTime iso={row.lastFiredAt} />
        ),
    },
    {
      key: "actions",
      header: "",
      width: "14rem",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={row.paused ? "play" : "stop"}
            loading={busy === row.id}
            onClick={() => void act(row, row.paused ? "resume" : "pause")}
          >
            {row.paused ? "Start again" : "Pause"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            loading={busy === row.id}
            onClick={() => void act(row, "delete")}
          >
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Panel
      title="Repeating runs"
      icon="refresh"
      description={`${formatNumber(schedules.length)} series — each occurrence appears under Scheduled below as an ordinary run`}
    >
      <div className="space-y-4">
        <DataTable
          columns={columns}
          rows={schedules}
          rowKey={(row) => row.id}
          caption="Repeating runs this account has set up"
          paginate={false}
        />

        <Alert tone="info" title="A series re-sends the same staged products">
          It does not re-read the file — the products were staged when the series was made, which
          is what lets it run months later without a preview. Missed occurrences, from a server
          that was off, are skipped rather than fired in a burst afterwards. Deleting a series
          drops the occurrence it had waiting and leaves everything that already ran alone.
        </Alert>
      </div>
    </Panel>
  );
}

/** "every 12 hours" reads better than "720 minutes" on a screen somebody scans. */
function describeInterval(minutes: number): string {
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return weeks === 1 ? "every week" : `every ${weeks} weeks`;
  }

  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "every day" : `every ${days} days`;
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "every hour" : `every ${hours} hours`;
  }

  return `every ${formatNumber(minutes)} minutes`;
}
