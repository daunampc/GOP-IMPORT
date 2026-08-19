/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import { and, asc, eq, gt, sql } from "drizzle-orm";

import { db } from "@/db";
import { jobLogs } from "@/db/schema";

import { LOG_CHANNEL, redis } from "./redis";

/**
 * What a run did, line by line, as it happened.
 *
 * Two rules shape everything here.
 *
 * WRITTEN THE MOMENT THE EVENT HAPPENS, not batched. An earlier design collected a
 * batch's lines and wrote them at the batch boundary to save round trips; that was
 * abandoned because it defeats the point. Against a slow site a batch takes two
 * minutes, so batching means the operator watches an empty panel for two minutes
 * and then gets everything at once — precisely when they most want to know what is
 * going on. And the saving was imaginary: a batch is an HTTP call measured in
 * seconds, so five small INSERTs beside it are not on the same scale as the thing
 * they run next to.
 *
 * NEVER A PAYLOAD, A HEADER, A KEY OR A SIGNATURE. Headers carry the site's API
 * key; the payload is the customer's entire catalogue. `detail` is for numbers,
 * codes and counts. The e2e and isolation suites grep this table for the fixture
 * secrets, so this is enforced by a failing test rather than by care.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogStage =
  | "run"
  | "limits"
  | "s3"
  | "images"
  | "batch"
  | "plugin"
  | "cancel"
  | "transients"
  | "notify"
  | "finish";

export interface LogEntry {
  level?: LogLevel;
  stage: LogStage;
  batchIndex?: number | null;
  message: string;
  detail?: Record<string, unknown> | null;
}

export interface JobLogLine {
  id: number;
  at: string;
  level: LogLevel;
  stage: LogStage;
  batchIndex: number | null;
  message: string;
  detail: Record<string, unknown> | null;
}

/**
 * Write one or more lines, then knock on the door.
 *
 * The knock is a Redis publish carrying only the run id — the same arrangement Stop
 * uses, and for the same reason. Postgres is the record; the broadcast only tells a
 * watching SSE connection to go and read. Publishing the LINES instead would mean a
 * dropped message is a line lost for ever with nothing to notice it; this way a
 * dropped message costs a couple of seconds, because the cursor is still there and
 * the fallback heartbeat picks it up.
 *
 * Never throws. A log that takes a run down with it would be worse than no log at
 * all — this is diagnostics, and diagnostics must not become the fault.
 */
export async function logJob(jobId: string, entries: LogEntry | LogEntry[]): Promise<void> {
  const list = Array.isArray(entries) ? entries : [entries];

  if (list.length === 0) {
    return;
  }

  try {
    await db.insert(jobLogs).values(
      list.map((entry) => ({
        jobId,
        level: entry.level ?? "info",
        stage: entry.stage,
        batchIndex: entry.batchIndex ?? null,
        // Postgres rejects a null byte in text, and a mangled CSV cell can carry
        // one all the way here. Trimmed to keep one bad byte from losing the line.
        message: entry.message.replace(/\0/g, "").slice(0, 4000),
        detail: entry.detail ?? null,
      })),
    );

    await redis.publish(LOG_CHANNEL, jobId).catch(() => undefined);
  } catch (error) {
    // Reported to the process log so a broken log is visible, but never rethrown.
    console.warn(
      `[job-log] could not write ${list.length} line(s) for ${jobId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Lines after a cursor, oldest first.
 *
 * `after` is an id rather than a timestamp because two lines in the same
 * millisecond are ordinary, and a timestamp cursor either repeats them or skips
 * them. Both the paged read and the SSE stream use this one function, so they
 * cannot drift apart in what they consider "next".
 */
export async function getJobLogs(
  jobId: string,
  options: { after?: number; limit?: number } = {},
): Promise<JobLogLine[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 2000));
  const after = options.after ?? 0;

  const rows = await db
    .select()
    .from(jobLogs)
    .where(and(eq(jobLogs.jobId, jobId), gt(jobLogs.id, after)))
    .orderBy(asc(jobLogs.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    at: row.at.toISOString(),
    level: row.level,
    stage: row.stage,
    batchIndex: row.batchIndex,
    message: row.message,
    detail: row.detail,
  }));
}

export async function countJobLogs(jobId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobLogs)
    .where(eq(jobLogs.jobId, jobId));

  return row?.count ?? 0;
}

/**
 * One line as plain text, for the "download the log" button.
 *
 * Fixed-width stage and level so a downloaded log is readable in any editor
 * without being a table — the thing somebody pastes into a support message.
 */
export function formatLogLine(line: JobLogLine): string {
  const stamp = line.at.replace("T", " ").replace(/\.\d+Z$/, "");
  const batch = line.batchIndex === null ? "" : ` [batch ${line.batchIndex}]`;

  return `${stamp}  ${line.level.toUpperCase().padEnd(5)} ${line.stage.padEnd(10)}${batch} ${line.message}`;
}
