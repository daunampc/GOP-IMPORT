/*
 * Do NOT import "server-only" here — the worker advances schedules, and so do routes.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { jobSchedules } from "@/db/schema";

import { dropStagedRun, enqueueJob, type JobKind, type JobState } from "./jobs";

/**
 * A run that happens again — §6 C2.
 *
 * See the long note on `jobSchedules` in `db/schema.ts` for the shape and why it is
 * that shape. The short version, because it is the part that matters:
 *
 * EACH OCCURRENCE IS AN ORDINARY RUN. A firing stages a NEW `job` row with its own
 * copy of the payload, its own results, its own log and its own Cancel. Repeating
 * one job on a BullMQ `repeat` cannot work here — `runJob` refuses to touch a run
 * whose status is terminal, which is the guard that stops a redelivered job
 * re-publishing a catalogue — so `JobStatus` keeps its original five members and
 * "scheduled" stays DERIVED from `scheduled_for`.
 *
 * THE SERIES HOLDS THE PAYLOAD, ONCE. Each occurrence gets a copy, but the copy the
 * next one is built from lives here, so retention taking last night's staged rows
 * away cannot quietly make tonight's run empty.
 *
 * WHAT IT IS NOT: a file watcher. It re-sends the same staged data on a cadence,
 * because "the preview is a contract" and this app never re-reads a file. That keeps
 * a shop matching a price list somebody edits in wp-admin; it will not pick up a new
 * export. The screen says so, in those words.
 */

/** The shortest series this allows. Below an hour it is a load generator. */
export const MIN_EVERY_MINUTES = 60;

/** 31 days. Longer than that and a calendar reminder is the better tool. */
export const MAX_EVERY_MINUTES = 44_640;

export interface Schedule {
  id: string;
  createdBy: string;
  storeId: string;
  storeUrl: string;
  storeLabel: string;
  kind: JobKind;
  sourceLabel: string;
  options: Record<string, unknown>;
  everyMinutes: number;
  nextRunAt: string;
  nextJobId: string | null;
  lastFiredAt: string | null;
  paused: boolean;
  createdAt: string;
  /** Items in the staged payload. The payload itself never goes to a browser. */
  total: number;
}

export interface CreateScheduleInput {
  createdBy: string;
  storeId: string;
  storeUrl: string;
  storeLabel?: string;
  kind?: JobKind;
  sourceLabel: string;
  options: Record<string, unknown>;
  items: unknown[];
  everyMinutes: number;
  /** When the FIRST occurrence is due. */
  firstRunAt: Date;
}

type Row = typeof jobSchedules.$inferSelect;

function toSchedule(row: Row): Schedule {
  return {
    id: row.id,
    createdBy: row.createdBy,
    storeId: row.storeId,
    storeUrl: row.storeUrl,
    storeLabel: row.storeLabel,
    kind: row.kind,
    sourceLabel: row.sourceLabel,
    options: row.options,
    everyMinutes: row.everyMinutes,
    nextRunAt: row.nextRunAt.toISOString(),
    nextJobId: row.nextJobId,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    paused: row.paused,
    createdAt: row.createdAt.toISOString(),
    // The count, never the payload: a list of series must not carry a catalogue per
    // row, and no screen has a use for the items themselves.
    total: Array.isArray(row.payload) ? row.payload.length : 0,
  };
}

export function clampEveryMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) {
    return MIN_EVERY_MINUTES;
  }

  return Math.max(MIN_EVERY_MINUTES, Math.min(Math.round(minutes), MAX_EVERY_MINUTES));
}

/**
 * When the next occurrence is due, counting from the one that just fired.
 *
 * Two decisions live in this one function.
 *
 * Counted from the PREVIOUS DUE TIME rather than from now, so a series set for
 * 02:00 stays at 02:00 instead of drifting later every night by however long the
 * last run waited for a worker.
 *
 * MISSED OCCURRENCES ARE SKIPPED, not caught up. A worker that was down for a week
 * would otherwise come back and fire seven nightly price syncs at once, against a
 * shop, in a burst — which is worse than having missed them. So the time is advanced
 * until it is in the future, and the ones in between simply did not happen. The
 * screen says when the next one is; nothing pretends the missed ones ran.
 */
export function nextOccurrenceAt(previousDue: Date, everyMinutes: number, now: Date): Date {
  const step = clampEveryMinutes(everyMinutes) * 60_000;
  let next = previousDue.getTime() + step;

  while (next <= now.getTime()) {
    next += step;
  }

  return new Date(next);
}

async function rowOf(id: string): Promise<Row | null> {
  const [found] = await db.select().from(jobSchedules).where(eq(jobSchedules.id, id)).limit(1);
  return found ?? null;
}

/** Stage one occurrence of a series as an ordinary scheduled run. */
async function stageOccurrence(row: Row, dueAt: Date): Promise<JobState> {
  return enqueueJob({
    kind: row.kind,
    storeId: row.storeId,
    storeUrl: row.storeUrl,
    storeLabel: row.storeLabel,
    createdBy: row.createdBy,
    sourceLabel: row.sourceLabel,
    options: row.options as never,
    items: Array.isArray(row.payload) ? row.payload : [],
    scheduledFor: dueAt,
    scheduleId: row.id,
  });
}

export async function createSchedule(
  input: CreateScheduleInput,
): Promise<{ schedule: Schedule; first: JobState }> {
  const id = randomUUID();
  const everyMinutes = clampEveryMinutes(input.everyMinutes);

  const [row] = await db
    .insert(jobSchedules)
    .values({
      id,
      createdBy: input.createdBy,
      storeId: input.storeId,
      storeUrl: input.storeUrl,
      storeLabel: input.storeLabel ?? input.storeUrl,
      kind: input.kind ?? "import",
      sourceLabel: input.sourceLabel,
      options: input.options,
      payload: input.items,
      everyMinutes,
      nextRunAt: input.firstRunAt,
    })
    .returning();

  // The series exists before its first occurrence does, so a crash between the two
  // leaves a series with nothing pending — which `resume` fixes — rather than a run
  // pointing at a series that was never written.
  const first = await stageOccurrence(row, input.firstRunAt);

  const [updated] = await db
    .update(jobSchedules)
    .set({ nextJobId: first.id })
    .where(eq(jobSchedules.id, id))
    .returning();

  return { schedule: toSchedule(updated ?? row), first };
}

export async function listSchedules(ownerId: string): Promise<Schedule[]> {
  const rows = await db
    .select()
    .from(jobSchedules)
    .where(eq(jobSchedules.createdBy, ownerId))
    .orderBy(desc(jobSchedules.createdAt));

  return rows.map(toSchedule);
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const row = await rowOf(id);
  return row === null ? null : toSchedule(row);
}

/**
 * Stop it firing, keeping everything — or start it again.
 *
 * Pausing DROPS the pending occurrence rather than cancelling it. A cancelled run
 * would sit in the history as something that happened and was stopped, and nothing
 * happened: it had not run, has no results, and the operator asked for the series to
 * be quiet rather than for a record of a non-event.
 *
 * Resuming stages a fresh occurrence, always in the future — never a backlog, for
 * the same reason `nextOccurrenceAt` skips missed times.
 */
export async function setSchedulePaused(id: string, paused: boolean): Promise<Schedule | null> {
  const row = await rowOf(id);

  if (row === null) {
    return null;
  }

  if (paused) {
    if (row.nextJobId !== null) {
      await dropStagedRun(row.nextJobId);
    }

    const [updated] = await db
      .update(jobSchedules)
      .set({ paused: true, nextJobId: null })
      .where(eq(jobSchedules.id, id))
      .returning();

    return updated === undefined ? null : toSchedule(updated);
  }

  const now = new Date();
  const dueAt =
    row.nextRunAt.getTime() > now.getTime()
      ? row.nextRunAt
      : nextOccurrenceAt(row.nextRunAt, row.everyMinutes, now);

  const occurrence = await stageOccurrence(row, dueAt);

  const [updated] = await db
    .update(jobSchedules)
    .set({ paused: false, nextJobId: occurrence.id, nextRunAt: dueAt })
    .where(eq(jobSchedules.id, id))
    .returning();

  return updated === undefined ? null : toSchedule(updated);
}

/**
 * Delete the series, and with it the occurrence it had waiting.
 *
 * Both halves matter. Leaving the pending occurrence behind would mean a series
 * somebody deleted still publishes tonight, which is the worst kind of surprise this
 * feature could produce. And the runs that already HAPPENED are untouched: their
 * `schedule_id` becomes null by the foreign key, so they keep their results, their
 * log and their place in the history of the account.
 */
export async function deleteSchedule(id: string): Promise<boolean> {
  const row = await rowOf(id);

  if (row === null) {
    return false;
  }

  if (row.nextJobId !== null) {
    await dropStagedRun(row.nextJobId);
  }

  await db.delete(jobSchedules).where(eq(jobSchedules.id, id));

  return true;
}

/**
 * One occurrence has been picked up: stage the next one.
 *
 * Called by the worker the moment it takes an occurrence on, rather than when the
 * run finishes, so a series survives its own runs being cancelled, failing, or
 * dying with the worker.
 *
 * IDEMPOTENT UNDER REDELIVERY, and that is the whole reason for `nextJobId`. BullMQ
 * handing the same job over twice is an ordinary event; the claim below is a single
 * conditional UPDATE, so the second delivery finds the series already advanced and
 * does nothing. Claiming BEFORE staging is deliberate too: two workers racing would
 * otherwise both stage an occurrence and one would be an orphan nobody points at.
 */
export async function advanceSchedule(
  scheduleId: string,
  firedJobId: string,
): Promise<JobState | null> {
  const [claimed] = await db
    .update(jobSchedules)
    .set({ nextJobId: null, lastFiredAt: new Date() })
    .where(and(eq(jobSchedules.id, scheduleId), eq(jobSchedules.nextJobId, firedJobId)))
    .returning();

  if (claimed === undefined) {
    // Not the pending occurrence: a redelivery, or a series somebody paused or
    // deleted while this run sat in the queue. Nothing to advance.
    return null;
  }

  if (claimed.paused) {
    return null;
  }

  const dueAt = nextOccurrenceAt(claimed.nextRunAt, claimed.everyMinutes, new Date());
  const next = await stageOccurrence(claimed, dueAt);

  await db
    .update(jobSchedules)
    .set({ nextJobId: next.id, nextRunAt: dueAt })
    .where(eq(jobSchedules.id, scheduleId));

  return next;
}
