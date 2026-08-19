"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Badge,
  Button,
  Icon,
  Panel,
  Segmented,
  Tooltip,
  cn,
  useToast,
} from "@/components/ui";
import { formatNumber } from "@/lib/format";
// Types only — `lib/job-log` reaches the database, and a value import from here
// would put postgres in the browser bundle.
import type { JobLogLine, LogLevel } from "@/lib/job-log";

/**
 * What the run is doing, as it does it.
 *
 * Live over SSE rather than polled, because the point is to watch: the worker
 * writes a line, publishes the run id on a Redis channel, and the stream reads from
 * its cursor and pushes. A dropped broadcast costs a second, not a line — the
 * server's fallback tick has the same cursor.
 *
 * Deliberately at the BOTTOM of the run page. It is the most detailed and least
 * summarised thing on the screen, and somebody who wants the summary should not
 * have to scroll past a thousand log lines to reach it.
 */

type Filter = "all" | "warn" | "error";

/** How many lines to keep in the browser. */
const MAX_LINES = 5000;

const LEVEL_TONE: Record<LogLevel, string> = {
  debug: "text-ink-subtle",
  info: "text-ink-muted",
  warn: "text-warn-fg",
  error: "text-bad-fg",
};

export function RunLog({ jobId, active }: { jobId: string; active: boolean }) {
  const toast = useToast();

  const [lines, setLines] = useState<JobLogLine[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [connection, setConnection] = useState<"connecting" | "live" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether to keep the view pinned to the newest line.
   *
   * Turns itself OFF the moment somebody scrolls up, because a panel that yanks you
   * back to the bottom while you are reading is unusable — and reading an older line
   * is exactly why anybody opens this. The button below turns it back on.
   */
  const [follow, setFollow] = useState(true);

  const scroller = useRef<HTMLDivElement | null>(null);
  const cursor = useRef(0);

  /**
   * Append lines, keeping the cursor and the cap.
   *
   * Deduplicated by id: the fallback tick and a broadcast can both fire for the
   * same write, and without this every line would appear twice.
   */
  const append = useCallback((incoming: JobLogLine[]) => {
    if (incoming.length === 0) {
      return;
    }

    setLines((current) => {
      const seen = new Set(current.map((line) => line.id));
      const fresh = incoming.filter((line) => !seen.has(line.id));

      if (fresh.length === 0) {
        return current;
      }

      const next = [...current, ...fresh];
      // A very long run must not grow the tab's memory without bound. The whole
      // log is still on the server and downloadable.
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);

  /* ---- live stream while the run is going; one read once it is not ---- */

  useEffect(() => {
    let dropped = false;

    if (!active) {
      // Finished run: one paged read, no stream to hold open.
      void (async () => {
        try {
          const response = await fetch(`/api/jobs/${jobId}/logs?limit=2000`);
          const payload = (await response.json()) as { lines?: JobLogLine[]; error?: string };

          if (dropped) {
            return;
          }

          if (!response.ok) {
            setError(payload.error ?? "Could not read the log.");
          } else {
            append(payload.lines ?? []);
          }
          setConnection("closed");
        } catch (caught) {
          if (!dropped) {
            setError(caught instanceof Error ? caught.message : String(caught));
            setConnection("closed");
          }
        }
      })();

      return () => {
        dropped = true;
      };
    }

    const source = new EventSource(`/api/jobs/${jobId}/logs/stream?after=${cursor.current}`);

    source.onopen = () => {
      if (!dropped) {
        setConnection("live");
        setError(null);
      }
    };

    source.onmessage = (event) => {
      if (dropped) {
        return;
      }

      const message = JSON.parse(event.data as string) as
        | { ok: true; lines: JobLogLine[]; cursor: number; done: boolean }
        | { ok: false; error: string };

      if (!message.ok) {
        setError(message.error);
        return;
      }

      cursor.current = message.cursor;
      append(message.lines);

      if (message.done) {
        // The server closes too; closing here as well stops the browser
        // reconnecting to a stream that has nothing left to say.
        setConnection("closed");
        source.close();
      }
    };

    source.onerror = () => {
      if (!dropped) {
        // EventSource retries on its own. Say so rather than showing an error the
        // reader cannot act on.
        setConnection("connecting");
      }
    };

    return () => {
      dropped = true;
      source.close();
    };
  }, [jobId, active, append]);

  /* ---- keep the newest line in view, unless the reader scrolled away ---- */

  useEffect(() => {
    if (!follow) {
      return;
    }

    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines, follow]);

  const shown = useMemo(() => {
    if (filter === "all") {
      return lines;
    }
    if (filter === "warn") {
      return lines.filter((line) => line.level === "warn" || line.level === "error");
    }
    return lines.filter((line) => line.level === "error");
  }, [lines, filter]);

  const counts = useMemo(
    () => ({
      warn: lines.filter((line) => line.level === "warn").length,
      error: lines.filter((line) => line.level === "error").length,
    }),
    [lines],
  );

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(shown.map(asText).join("\n"));
      toast.success(`Copied ${formatNumber(shown.length)} line(s)`);
    } catch {
      toast.error("Could not copy", "The browser refused clipboard access.");
    }
  }

  return (
    <Panel
      title="Log"
      icon="file"
      description="What the worker did, as it did it"
      padded={false}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <LogConnection state={connection} active={active} />

          <Segmented
            label="Log level"
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `All ${lines.length > 0 ? `(${formatNumber(lines.length)})` : ""}`.trim() },
              { value: "warn", label: `Warnings ${counts.warn + counts.error > 0 ? `(${counts.warn + counts.error})` : ""}`.trim() },
              { value: "error", label: `Errors ${counts.error > 0 ? `(${counts.error})` : ""}`.trim() },
            ]}
          />

          <Tooltip content="Copy the lines currently shown">
            <Button size="sm" variant="ghost" icon="copy" onClick={() => void copyAll()}>
              Copy
            </Button>
          </Tooltip>

          {/* A real link, not a scripted download: the viewer's sandbox can block
              script-driven saves, and this is a plain GET the server already serves. */}
          <Tooltip content="Download the whole log as a text file">
            <a
              href={`/api/jobs/${jobId}/logs?format=text&limit=2000`}
              download={`run-${jobId}.log`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-ink-muted transition-colors duration-fast hover:border-accent-border hover:text-accent-fg"
            >
              <Icon name="download" className="size-3.5" />
              Download
            </a>
          </Tooltip>
        </div>
      }
    >
      {error !== null ? (
        <p className="border-b border-bad-border bg-bad-soft px-3 py-2 text-xs text-bad-fg">{error}</p>
      ) : null}

      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          // 24px of slack: "at the bottom" should survive sub-pixel scroll maths.
          const atBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight < 24;

          if (atBottom !== follow) {
            setFollow(atBottom);
          }
        }}
        className="max-h-96 overflow-y-auto overflow-x-auto bg-surface-sunken px-3 py-2 font-mono text-2xs leading-relaxed"
      >
        {shown.length === 0 ? (
          <p className="py-6 text-center text-xs text-ink-subtle">
            {connection === "connecting"
              ? "Waiting for the first line…"
              : lines.length === 0
                ? "This run wrote no log. Runs started before logging was added have none."
                : "No line matches this filter."}
          </p>
        ) : (
          shown.map((line) => <LogRow key={line.id} line={line} />)
        )}
      </div>

      {!follow && active ? (
        <div className="flex justify-center border-t border-line bg-surface px-3 py-2">
          <Button
            size="sm"
            variant="secondary"
            icon="arrow-down"
            onClick={() => {
              setFollow(true);
              const element = scroller.current;
              if (element !== null) {
                element.scrollTop = element.scrollHeight;
              }
            }}
          >
            Follow the newest line
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

function LogRow({ line }: { line: JobLogLine }) {
  return (
    <p className="flex gap-2 whitespace-pre-wrap py-0.5">
      {/* The time is rendered from the STRING the server sent, sliced rather than
          parsed into a Date — a locale-formatted time here would differ between the
          server render and the browser's and break hydration, and a log wants a
          stable machine-readable stamp anyway. */}
      <span className="shrink-0 text-ink-subtle">{line.at.slice(11, 19)}</span>
      <span className="shrink-0 text-ink-subtle">
        {line.batchIndex === null ? line.stage : `${line.stage}#${line.batchIndex + 1}`}
      </span>
      <span className={cn("min-w-0", LEVEL_TONE[line.level])}>{line.message}</span>
    </p>
  );
}

function LogConnection({
  state,
  active,
}: {
  state: "connecting" | "live" | "closed";
  active: boolean;
}) {
  if (!active) {
    return <Badge tone="neutral">finished</Badge>;
  }

  if (state === "live") {
    return (
      <Tooltip content="New lines arrive the moment the worker writes them.">
        <Badge tone="ok" icon="zap">
          live
        </Badge>
      </Tooltip>
    );
  }

  if (state === "connecting") {
    return (
      <Tooltip content="Reconnecting. Nothing is lost — the stream resumes from where it left off.">
        <Badge tone="warn">reconnecting</Badge>
      </Tooltip>
    );
  }

  return <Badge tone="neutral">closed</Badge>;
}

/** Same shape as the server's `formatLogLine`, for copy-to-clipboard. */
function asText(line: JobLogLine): string {
  const stamp = line.at.replace("T", " ").replace(/\.\d+Z$/, "");
  const batch = line.batchIndex === null ? "" : ` [batch ${line.batchIndex}]`;
  return `${stamp}  ${line.level.toUpperCase().padEnd(5)} ${line.stage.padEnd(10)}${batch} ${line.message}`;
}
