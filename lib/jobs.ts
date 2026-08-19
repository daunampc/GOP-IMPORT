/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { jobBatches, jobItems, jobLogs, jobResults, jobs as jobsTable, users } from "@/db/schema";

import { isScheduled } from "./job-display";
import type { ImportOptions } from "./import-options";
import type { PurgeItem } from "./purge-options";
import type { PurgeOptions } from "./purge-options";
import type { EditItem, EditOptions } from "./edit-options";
import { STOP_CHANNEL, createConnection, redis } from "./redis";
import { MAX_BATCH_SIZE, type ImportResult, type Product } from "./gop-client";

/**
 * The run queue and run state.
 *
 * The split matters: Postgres holds every durable fact about a run — the cancel
 * record included — and Redis holds only the queue and the Stop broadcast.
 * Closing the browser, restarting the web process, or flushing Redis all leave
 * the history intact, and now leave a CANCEL intact too: reopen the Activity
 * screen and the numbers are still there.
 */

export const QUEUE_NAME = "gop-import";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobKind = "import" | "purge" | "update";

/**
 * A status a run cannot move out of.
 *
 * `runJob` consults this before doing any work, which is the whole of the fix
 * for a redelivered job re-running from the beginning. BullMQ redelivery is not
 * exotic: the worker is built with the default `lockDuration` of 30s and
 * `maxStalledCount` of 1, so a redeploy, a restart, or an event loop blocked
 * past the lock window is enough for the queue to hand the same job over twice.
 * It used to check only that the run EXISTED, so the second delivery called
 * `markRunning()` and flipped a `cancelled` run back to `running`.
 */
const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["completed", "failed", "cancelled"]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * How a stop was asked for.
 *
 *  - `cancel` is graceful, and that is a promise rather than an implementation
 *    detail: the lane stops at the next batch boundary and a request already in
 *    flight runs to its deadline, so no product is cut off while it is being
 *    written.
 *  - `stop` aborts the in-flight request immediately. It is the only thing that
 *    helps a run wedged in a request that will never return, and it costs the
 *    graceful guarantee: the plugin may already have committed the batch it was
 *    sent, so the site can hold products the results table does not list.
 */
export type CancelMode = "cancel" | "stop";

/**
 * A run carries the options of its own kind and nothing else.
 *
 * Read it through `job.kind` — that is the discriminant, and every screen that
 * touches `options` has to look at it first.
 */
export type JobOptions = ImportOptions | PurgeOptions | EditOptions;

/** Narrowing helpers, so no screen has to guess at the shape of `options`. */
export function isImportRun(job: JobState): job is JobState & { options: ImportOptions } {
  return job.kind === "import";
}

export function isPurgeRun(job: JobState): job is JobState & { options: PurgeOptions } {
  return job.kind === "purge";
}

/**
 * A bulk edit of products that already exist.
 *
 * Its own kind rather than an import with a flag, because its results read
 * differently: an import row says "Created", and a screen that treated this as an
 * import would print that over a product it had merely repriced.
 */
export function isEditRun(job: JobState): job is JobState & { options: EditOptions } {
  return job.kind === "update";
}

export interface JobState {
  id: string;
  kind: JobKind;
  storeId: string;
  storeUrl: string;
  storeLabel: string;
  sourceLabel: string;
  status: JobStatus;

  /** The account this run belongs to. Every read is filtered on it. */
  createdBy: string;

  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  /** Rows the plugin answered with `deduplicated: true` — already present. */
  deduplicated: number;

  /** Total batches = ceil(total / batch size). */
  batches: number;
  batchesDone: number;
  /**
   * Sum of the plugin's own `elapsed_ms` across batches.
   *
   * Different from wall time (`finishedAt - startedAt`) because batches run in
   * parallel. Both are kept: one answers "how hard did the site work", the
   * other answers "how long did I wait".
   */
  pluginElapsedMs: number;

  /** One click aimed at several sites shares a group id. */
  groupId: string | null;
  /** Set when this run was built from another run's failed rows. */
  retryOf: string | null;

  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;

  /**
   * When a stop was asked for, if it was. THE cancel record — there is no
   * longer a Redis flag beside it to disagree with.
   *
   * Set while the run is still `running` is what the interface reads to say
   * "cancelling" honestly, rather than claiming the run has already stopped
   * while a lane is still finishing the batch it had already sent.
   */
  cancelRequestedAt: string | null;
  /** Which of the two was pressed. See `CancelMode`. */
  cancelMode: CancelMode | null;

  /** When a scheduled run is due to fire. Null for anything started now. */
  scheduledFor: string | null;
  /**
   * The repeating series this run is one occurrence of, or null — §6 C2.
   *
   * A pointer, never a status: `JobStatus` still has its original five members and
   * "scheduled" is still derived from `scheduledFor`, so nothing that switches on
   * status had to learn about repeats.
   */
  scheduleId: string | null;

  error: string | null;
  options: JobOptions;
}

/**
 * The display derivations live in `lib/job-display.ts` because a Client Component
 * needs them and this module pulls in `bullmq`, `ioredis` and `postgres`.
 * Re-exported so server code still has a single entry point — the same
 * arrangement as `storeLabel` in `lib/stores.ts`.
 */
export {
  JOB_KIND_ICONS,
  JOB_KIND_LABELS,
  JOB_KIND_TONES,
  displayStatusOf,
  isCancelling,
  isDeletable,
  isScheduled,
  isStoppable,
  type JobDisplayStatus,
} from "./job-display";

/** Per-batch numbers, kept so speed over time can be drawn. */
export interface BatchRecord {
  index: number;
  size: number;
  succeeded: number;
  failed: number;
  deduplicated: number;
  /** What the plugin reported. Null when the batch died before answering. */
  elapsedMs: number | null;
  /** Worker-side wall clock. Always present. */
  wallMs: number;
  at: string;
}

/**
 * Snapshot of the whole queue, shared by the SSE stream and first paint.
 *
 * `scheduled` is its own bucket rather than part of `queued`, and the difference
 * is not cosmetic: "waiting to be picked up" and "waiting for Tuesday" answer
 * different questions on the status bar, and a queue of 40 scheduled runs would
 * otherwise read as a worker that has fallen 40 runs behind.
 */
export interface JobsSnapshot {
  running: JobState[];
  queued: JobState[];
  scheduled: JobState[];
  history: JobState[];
  at: string;
}

declare global {
  var __gopQueue: Queue | undefined;
}

/**
 * The queue uses its OWN connection, not the shared one.
 *
 * BullMQ holds a blocking command open; sharing would put every ordinary query
 * behind it.
 */
export const importQueue: Queue =
  globalThis.__gopQueue ??
  new Queue(QUEUE_NAME, {
    connection: createConnection(),
    defaultJobOptions: {
      // Runs write to a real database. Retrying a half-finished run risks
      // duplicates; the idempotency key catches most of it, but the decision to
      // resend belongs to a human.
      //
      // Still 1 now that batches retry themselves. The two are not alternatives:
      // a transient failure belongs to ONE batch of at most 50, and `runBatches`
      // sends that batch again with the run's progress, log and cancel record
      // intact. Re-delivering the whole job would re-send everything that already
      // succeeded and would restart the run's own accounting to do it.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__gopQueue = importQueue;
}

/* --------------------------------------------------------------- mapping */

type Row = typeof jobsTable.$inferSelect;

function toState(row: Row): JobState {
  return {
    id: row.id,
    kind: row.kind,
    storeId: row.storeId ?? "",
    storeUrl: row.storeUrl,
    storeLabel: row.storeLabel,
    sourceLabel: row.sourceLabel,
    status: row.status,
    createdBy: row.createdBy,
    total: row.total,
    processed: row.processed,
    succeeded: row.succeeded,
    failed: row.failed,
    deduplicated: row.deduplicated,
    batches: row.batches,
    batchesDone: row.batchesDone,
    pluginElapsedMs: row.pluginElapsedMs,
    groupId: row.groupId,
    retryOf: row.retryOf,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    cancelMode: row.cancelMode,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    scheduleId: row.scheduleId ?? null,
    error: row.error,
    options: row.options as unknown as JobOptions,
  };
}

/* -------------------------------------------------------------- creating */

export interface EnqueueInput {
  storeId: string;
  storeUrl: string;
  sourceLabel: string;
  options: JobOptions;
  /** Products for an import; product ids for a purge. */
  items: unknown[];
  /**
   * The account the run belongs to. Required, not optional.
   *
   * Every read of the run list filters on this, so a run created without one
   * would be a run every account can see. Making it required means a creation
   * path that forgets it does not compile — which is the only reason the four
   * paths that previously forgot it were findable at all.
   */
  createdBy: string;
  kind?: JobKind;
  storeLabel?: string;
  groupId?: string | null;
  retryOf?: string | null;
  /**
   * Fire at this time instead of as soon as a worker is free.
   *
   * The staged payload is what makes this safe: `job_item` is written in the same
   * transaction as the run row below, so a run scheduled for tomorrow carries its
   * own products and does not depend on the preview — which expires after an hour
   * (`PREVIEW_TTL_MS`). A scheduled run whose payload lived in the preview would
   * simply be gone by morning.
   */
  scheduledFor?: Date | null;
  /** Set only by `lib/schedules.ts`, when staging one occurrence of a series. */
  scheduleId?: string | null;
}

/**
 * Create a run and hand it to the queue.
 *
 * Both kinds go through here, and both go through the same queue: the worker
 * reads `kind` and picks its path. Two queues would have meant two workers, two
 * cancel mechanisms and two progress screens for what is the same shape of job.
 */
export async function enqueueJob(input: EnqueueInput): Promise<JobState> {
  const id = randomUUID();
  const batchSize = Math.max(1, Math.min(input.options.batchSize ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE));

  // The payload lives in its own table so listing the queue does not drag
  // megabytes of product JSON along with every row.
  const state = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(jobsTable)
      .values({
        id,
        kind: input.kind ?? "import",
        storeId: input.storeId,
        storeUrl: input.storeUrl,
        storeLabel: input.storeLabel ?? input.storeUrl,
        createdBy: input.createdBy,
        sourceLabel: input.sourceLabel,
        status: "queued",
        total: input.items.length,
        batches: Math.ceil(input.items.length / batchSize),
        groupId: input.groupId ?? null,
        retryOf: input.retryOf ?? null,
        scheduledFor: input.scheduledFor ?? null,
        scheduleId: input.scheduleId ?? null,
        options: input.options as unknown as Record<string, unknown>,
      })
      .returning();

    await tx.insert(jobItems).values({ jobId: id, items: input.items });

    return toState(row);
  });

  await importQueue.add("run", { jobId: id }, { jobId: id, delay: delayFor(input.scheduledFor) });

  return state;
}

/**
 * How long BullMQ should hold the job before offering it to a worker.
 *
 * A due time already in the past becomes zero rather than an error: the operator
 * asked for "now or as soon as possible", and refusing a schedule because the
 * clock moved between choosing and pressing would be pedantry. Clamped rather
 * than rejected, and the run still records the time that was asked for.
 */
function delayFor(scheduledFor: Date | null | undefined): number | undefined {
  if (scheduledFor == null) {
    return undefined;
  }

  return Math.max(0, scheduledFor.getTime() - Date.now());
}

/** Import-specific wrapper, so callers keep passing products rather than `unknown[]`. */
export async function enqueueImport(
  input: Omit<EnqueueInput, "items" | "options" | "kind"> & {
    options: ImportOptions;
    products: Product[];
  },
): Promise<JobState> {
  const { products, ...rest } = input;
  return enqueueJob({ ...rest, kind: "import", items: products });
}

/**
 * Purge-specific wrapper.
 *
 * The payload is the exact rows the operator confirmed, name and SKU included:
 * once the products are gone these rows are the only record of what they were.
 */
export async function enqueuePurge(
  input: Omit<EnqueueInput, "items" | "options" | "kind"> & {
    options: PurgeOptions;
    products: PurgeItem[];
  },
): Promise<JobState> {
  const { products, ...rest } = input;
  return enqueueJob({ ...rest, kind: "purge", items: products });
}

/**
 * Bulk-edit wrapper.
 *
 * The payload is the RESOLVED list the operator confirmed, each row carrying the
 * absolute value to write and what the product was when they looked. Not the filter
 * and not the rule — see `EditItem`. Once the site is written, these rows are the
 * only surviving record of the old values.
 */
export async function enqueueEdit(
  input: Omit<EnqueueInput, "items" | "options" | "kind"> & {
    options: EditOptions;
    products: EditItem[];
  },
): Promise<JobState> {
  const { products, ...rest } = input;
  return enqueueJob({ ...rest, kind: "update", items: products });
}

/* --------------------------------------------------------------- reading */

/**
 * One run, whoever it belongs to.
 *
 * Unscoped on purpose, and only two kinds of caller are outside the
 * customer-to-customer boundary rather than exceptions to it: the worker, which
 * has no session, and `lib/ownership.ts`, whose job is to compare this run's
 * owner against the caller. Every route reaches a run through the guard, never
 * through this directly.
 */
export async function getJobState(id: string): Promise<JobState | null> {
  const [row] = await db.select().from(jobsTable).where(eq(jobsTable.id, id)).limit(1);
  return row ? toState(row) : null;
}

export async function getJobItems(id: string): Promise<unknown[]> {
  const [row] = await db
    .select({ items: jobItems.items })
    .from(jobItems)
    .where(eq(jobItems.jobId, id))
    .limit(1);
  return row?.items ?? [];
}

export async function getJobProducts(id: string): Promise<Product[]> {
  return (await getJobItems(id)) as Product[];
}

/** A bulk edit's staged list, read back by the worker. */
export async function getEditItems(id: string): Promise<EditItem[]> {
  const items = await getJobItems(id);

  return items.filter((item): item is EditItem => {
    if (item === null || typeof item !== "object") {
      return false;
    }
    const record = item as Record<string, unknown>;
    return Number.isInteger(record.product_id) && Number(record.product_id) > 0;
  });
}

/** One account's runs, newest first. */
export async function listJobs(ownerId: string, limit = 200): Promise<JobState[]> {
  const rows = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.createdBy, ownerId))
    .orderBy(desc(jobsTable.createdAt))
    .limit(limit);
  return rows.map(toState);
}

/**
 * Snapshot for the Activity screen and the status bar — ONE ACCOUNT's.
 *
 * `running` is an ARRAY, not one job: the worker runs WORKER_CONCURRENCY runs
 * at a time, and one click aimed at several sites creates several at once.
 */
export async function jobsSnapshot(ownerId: string, limit = 200): Promise<JobsSnapshot> {
  return partition(await listJobs(ownerId, limit));
}

/** A run plus the account it belongs to — the administrator's list. */
export interface OwnedJobState extends JobState {
  ownerEmail: string;
  ownerName: string;
}

export interface AllJobsSnapshot {
  running: OwnedJobState[];
  queued: OwnedJobState[];
  scheduled: OwnedJobState[];
  history: OwnedJobState[];
  at: string;
}

/**
 * Every account's runs, with the owning account on every row.
 *
 * The administrator's oversight view, and the reason it is a separate function
 * rather than `jobsSnapshot(ownerId?)`: a widening flag threaded through the
 * ordinary path is one missing argument away from showing every customer's runs
 * on an ordinary customer's status bar. This one cannot be reached by accident.
 */
export async function allJobsSnapshot(limit = 500): Promise<AllJobsSnapshot> {
  const rows = await db
    .select({ job: jobsTable, email: users.email, name: users.name })
    .from(jobsTable)
    .innerJoin(users, eq(users.id, jobsTable.createdBy))
    .orderBy(desc(jobsTable.createdAt))
    .limit(limit);

  const all: OwnedJobState[] = rows.map((row) => ({
    ...toState(row.job),
    ownerEmail: row.email,
    ownerName: row.name,
  }));

  return partition(all);
}

function partition<T extends JobState>(all: T[]) {
  return {
    running: all.filter((job) => job.status === "running"),
    // Scheduled runs are `queued` in the database and must not appear in both:
    // the status bar would double-count them and the Activity tabs would show
    // the same row twice.
    queued: all.filter((job) => job.status === "queued" && !isScheduled(job)),
    scheduled: all.filter((job) => isScheduled(job)),
    history: all.filter((job) => job.status !== "running" && job.status !== "queued"),
    at: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------- updating */

export async function markRunning(id: string): Promise<void> {
  await db
    .update(jobsTable)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(jobsTable.id, id));
}

/**
 * Fold one finished batch into the run's counters.
 *
 * Done with a single UPDATE using SQL arithmetic rather than read-modify-write,
 * so parallel lanes finishing at the same instant cannot lose each other's
 * increments.
 */
export async function applyBatch(
  id: string,
  delta: {
    processed: number;
    succeeded: number;
    failed: number;
    deduplicated: number;
    pluginElapsedMs: number;
  },
): Promise<JobState | null> {
  const [row] = await db
    .update(jobsTable)
    .set({
      processed: sql`${jobsTable.processed} + ${delta.processed}`,
      succeeded: sql`${jobsTable.succeeded} + ${delta.succeeded}`,
      failed: sql`${jobsTable.failed} + ${delta.failed}`,
      deduplicated: sql`${jobsTable.deduplicated} + ${delta.deduplicated}`,
      batchesDone: sql`${jobsTable.batchesDone} + 1`,
      pluginElapsedMs: sql`${jobsTable.pluginElapsedMs} + ${delta.pluginElapsedMs}`,
    })
    .where(eq(jobsTable.id, id))
    .returning();

  return row ? toState(row) : null;
}

/**
 * Settle a run's final status.
 *
 * This used to end by deleting the Redis cancel flag, which was the worst
 * possible moment to do it: the instant a cancelled run finished, the only record
 * that anyone had asked it to stop disappeared, so a redelivery afterwards found
 * nothing and ran the entire payload to completion. Nothing deletes the cancel
 * record now — `cancel_requested_at` is a column on the run and cascades with
 * it, so the reason the run stopped survives exactly as long as the run does.
 */
export async function finishJob(
  id: string,
  status: JobStatus,
  error: string | null,
): Promise<void> {
  await db
    .update(jobsTable)
    .set({ status, error, finishedAt: new Date() })
    .where(eq(jobsTable.id, id));
}

/* --------------------------------------------------------------- results */

/**
 * Results are written after EVERY batch, not gathered until the end — if the
 * worker dies mid-run, what already happened is still on record.
 */
export async function appendResults(id: string, results: RunResult[]): Promise<void> {
  if (results.length === 0) {
    return;
  }

  await db
    .insert(jobResults)
    .values(
      results.map((result) => ({
        jobId: id,
        index: result.index,
        ok: result.ok,
        productId: result.product_id ?? null,
        sku: result.sku ?? null,
        name: result.name ?? null,
        variationIds: result.variation_ids ?? null,
        deduplicated: result.deduplicated ?? false,
        removed: result.removed ?? null,
        // An empty map is stored as null: "succeeded and changed nothing" is
        // already carried by `deduplicated`, and an empty object per row across a
        // 14,000-row run is bytes for nothing.
        changed:
          result.changed === undefined || Object.keys(result.changed).length === 0
            ? null
            : result.changed,
        action: result.action ?? null,
        errorCode: result.error?.code ?? null,
        errorMessage: result.error?.message ?? null,
      })),
    )
    // A retried batch must not explode on the primary key.
    .onConflictDoNothing();
}

/**
 * One row of a run, whichever kind it was.
 *
 * An import fills in `sku`/`variation_ids`/`deduplicated`; a purge fills in
 * `name` and `removed`. Both share the row identity and the error shape, which
 * is what lets one results table and one results screen serve both.
 */
export interface RunResult extends ImportResult {
  /** Purge runs only: the product's name, since the product itself is gone. */
  name?: string;
  /** Purge runs only: rows removed per table. */
  removed?: Record<string, number>;
  /**
   * Update rows only: which fields moved, and what they moved FROM.
   *
   * The `from` half is the reason this is stored rather than merely counted. A run
   * that changes 3,000 prices leaves no other trace of what those prices were, so
   * this column IS the record — readable on the run's page, and already carried
   * out by the CSV export. Nothing else on the site or in this app remembers.
   */
  changed?: Record<string, { from: string | string[]; to: string | string[] }>;
  /**
   * Did this row create the product, or change one already there?
   *
   * Absent for a plain import or a purge, where there is nothing to tell apart.
   * Set by the write modes, and `createdProductIds()` depends on it — see the
   * column comment in `db/schema.ts` for the destructive selection it protects.
   */
  action?: "created" | "updated";
}

export async function getResults(id: string, offset = 0, limit = 500): Promise<RunResult[]> {
  const rows = await db
    .select()
    .from(jobResults)
    .where(eq(jobResults.jobId, id))
    .orderBy(jobResults.index)
    .offset(offset)
    .limit(limit);

  return rows.map((row) => ({
    index: row.index,
    ok: row.ok,
    product_id: row.productId ?? undefined,
    sku: row.sku ?? undefined,
    name: row.name ?? undefined,
    variation_ids: row.variationIds ?? undefined,
    deduplicated: row.deduplicated,
    removed: row.removed ?? undefined,
    changed: row.changed ?? undefined,
    action: row.action ?? undefined,
    error:
      row.errorCode === null
        ? undefined
        : { code: row.errorCode, message: row.errorMessage ?? "" },
  }));
}

/**
 * Product ids an import run actually created.
 *
 * This is what makes "remove everything that run created" possible without the
 * plugin having to remember anything: the app already recorded every id it was
 * given back. Deduplicated rows are included — the run is why that product is
 * on the site, even if a previous run is what created it.
 *
 * ROWS THAT ONLY UPDATED A PRODUCT ARE EXCLUDED, and that exclusion is the
 * difference between a correct feature and a destructive one. A `create_or_update`
 * run answers with a `product_id` for every row, including the ones that were
 * already on the site and merely had their price changed. Feeding those to the
 * removal screen's "Everything one import run created" would delete a customer's
 * existing catalogue under a label promising it would not.
 *
 * `action IS NULL` counts as created: every row written before that column existed
 * came from an import that could only create, which is exactly what null meant.
 */
export async function createdProductIds(id: string): Promise<number[]> {
  const rows = await db
    .select({ productId: jobResults.productId, action: jobResults.action })
    .from(jobResults)
    .where(and(eq(jobResults.jobId, id), eq(jobResults.ok, true)))
    .orderBy(jobResults.index);

  const ids = rows
    .filter((row) => row.action !== "updated")
    .map((row) => row.productId)
    .filter((productId): productId is number => productId !== null && productId > 0);

  return [...new Set(ids)];
}

/**
 * Product ids a run CHANGED without creating them.
 *
 * The other half of the pair, and worth having for the same reason the first half
 * is narrowed: "this run repriced 340 products that already existed" is a fact the
 * run's own screen should be able to state, and it is not a fact about what the run
 * created.
 */
export async function updatedProductIds(id: string): Promise<number[]> {
  const rows = await db
    .select({ productId: jobResults.productId })
    .from(jobResults)
    .where(
      and(
        eq(jobResults.jobId, id),
        eq(jobResults.ok, true),
        eq(jobResults.action, "updated"),
      ),
    )
    .orderBy(jobResults.index);

  const ids = rows
    .map((row) => row.productId)
    .filter((productId): productId is number => productId !== null && productId > 0);

  return [...new Set(ids)];
}

export async function countResults(id: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobResults)
    .where(eq(jobResults.jobId, id));
  return row?.count ?? 0;
}

/* --------------------------------------------------------------- batches */

export async function appendBatchRecord(id: string, record: BatchRecord): Promise<void> {
  await db
    .insert(jobBatches)
    .values({
      jobId: id,
      index: record.index,
      size: record.size,
      succeeded: record.succeeded,
      failed: record.failed,
      deduplicated: record.deduplicated,
      elapsedMs: record.elapsedMs,
      wallMs: record.wallMs,
      at: new Date(record.at),
    })
    .onConflictDoNothing();
}

export async function getBatchRecords(id: string): Promise<BatchRecord[]> {
  const rows = await db
    .select()
    .from(jobBatches)
    .where(eq(jobBatches.jobId, id))
    .orderBy(jobBatches.index);

  return rows.map((row) => ({
    index: row.index,
    size: row.size,
    succeeded: row.succeeded,
    failed: row.failed,
    deduplicated: row.deduplicated,
    elapsedMs: row.elapsedMs,
    wallMs: row.wallMs,
    at: row.at.toISOString(),
  }));
}

/* -------------------------------------------------------------- cancelling */

/**
 * The message a Stop leaves on the run.
 *
 * Said in full on the run, not only on the button that caused it: the operator
 * who reads this a week later is not the one who pressed it, and "cancelled" with
 * no further detail would let them believe the results table is the whole story.
 */
export const STOP_WARNING =
  "Stopped immediately, so requests already in flight were abandoned rather than " +
  "waited for. Any batch that had already been sent may have been committed by the " +
  "site before the connection was cut — this site can hold products that are not " +
  "listed in the results below. Check the site before importing the same file again.";

/**
 * Ask a run to stop. `mode` is the whole difference between the two buttons.
 *
 * Both write the same durable record, and that record — not a Redis flag — is
 * what a lane reads between batches. `stop` additionally publishes the run id, so
 * the worker holding it can abort the request that is in flight instead of
 * waiting out its deadline.
 *
 * Idempotent in the way that matters: asking twice does not move
 * `cancelRequestedAt`, so "when was this asked to stop" stays the first answer,
 * but a `cancel` may be UPGRADED to a `stop` — which is exactly what an operator
 * does when the graceful one is visibly not working.
 */
export async function requestCancel(id: string, mode: CancelMode = "cancel"): Promise<void> {
  const [row] = await db
    .update(jobsTable)
    .set({
      cancelRequestedAt: sql`coalesce(${jobsTable.cancelRequestedAt}, now())`,
      // A stop always wins; a cancel never downgrades one.
      cancelMode: mode === "stop" ? "stop" : sql`coalesce(${jobsTable.cancelMode}, 'cancel')`,
    })
    /*
     * ONLY a live run. This is the fix for a stale cancel outliving its run.
     *
     * The old flag was set unconditionally, so a cancel that raced a finishing
     * run — status read as `running`, run finished before the write landed —
     * left a flag behind for its full 24-hour TTL, ready to cancel an unrelated
     * redelivery of that id. Narrowing the UPDATE closes the race in the database
     * rather than in the caller: if the run has already settled, zero rows change
     * and there is nothing left over to go stale.
     */
    .where(and(eq(jobsTable.id, id), inArray(jobsTable.status, ["queued", "running"])))
    .returning();

  if (row === undefined) {
    return;
  }

  if (mode === "stop") {
    // Best effort, and deliberately so: this only affects how FAST the run
    // stops. The durable record above is what makes it stop at all, so a
    // publish that reaches no subscriber costs responsiveness, not correctness.
    await redis.publish(STOP_CHANNEL, id).catch(() => undefined);
  }

  await releaseQueuedJob(id, mode);
}

/**
 * Drop the queue entry when the run has not started, and settle the status.
 *
 * `job.remove()` throws if a worker took the job between reading its state and
 * removing it — BullMQ answers "could not be removed because it is locked". That
 * exception used to escape all the way out of the cancel route, so the operator
 * got a 500 telling them the cancel had failed when in fact the record was
 * already written and the run WOULD stop. The catch is the honest shape: losing
 * this race means the run is running, which is the case the durable record and
 * the Stop broadcast already handle.
 */
async function releaseQueuedJob(id: string, mode: CancelMode): Promise<void> {
  try {
    const job = await importQueue.getJob(id);

    if (job === undefined) {
      return;
    }

    const state = await job.getState();

    // `delayed` is a scheduled run that has not fired. Removing it is what makes
    // cancelling a scheduled run work, and that path is kept intact.
    if (state !== "waiting" && state !== "delayed") {
      return;
    }

    await job.remove();

    // It never started, so there is nothing in flight and nothing uncertain:
    // no stop warning, whichever button was pressed.
    await finishJob(id, "cancelled", null);
  } catch {
    /*
     * The worker won the race and holds the job. Nothing to do and nothing
     * wrong: `cancel_requested_at` is written, so the lane stops at its next
     * boundary, and a `stop` has already been broadcast.
     */
    void mode;
  }
}

/**
 * Stop a run NOW, abandoning whatever is in flight.
 *
 * The action Cancel cannot serve. Named separately from `requestCancel` rather
 * than reached by passing an argument, because the two make different promises to
 * the operator and a default argument is a poor place to keep that distinction.
 */
export async function requestStop(id: string): Promise<void> {
  return requestCancel(id, "stop");
}

/**
 * Has a stop been asked for? Read from POSTGRES, once per batch.
 *
 * One indexed primary-key lookup, selecting a single column, on a connection
 * that is already open — against a batch that sends up to 50 products over HTTP
 * and is measured in seconds. The comment this replaces called that "pure
 * waste"; the two bugs caused by keeping the same fact in Redis instead cost
 * considerably more than a round trip.
 */
export async function cancelRequest(
  id: string,
): Promise<{ requested: boolean; mode: CancelMode | null }> {
  const [row] = await db
    .select({ at: jobsTable.cancelRequestedAt, mode: jobsTable.cancelMode })
    .from(jobsTable)
    .where(eq(jobsTable.id, id))
    .limit(1);

  return { requested: row?.at != null, mode: row?.mode ?? null };
}

export async function isCancelled(id: string): Promise<boolean> {
  return (await cancelRequest(id)).requested;
}

/* ------------------------------------------------------------- scheduling */

export type RescheduleOutcome =
  | { ok: true; scheduledFor: string }
  | { ok: false; reason: "not_found" | "already_started" | "not_delayed" };

/**
 * Move a scheduled run to a different time.
 *
 * Two records have to agree — the run row and the BullMQ delay — and the queue is
 * changed FIRST. If `changeDelay` fails, the database still says the original
 * time, which is the truth; doing it the other way round would leave a run
 * claiming Tuesday while the queue still fires it on Monday.
 *
 * `already_started` and `not_delayed` are kept apart because they mean different
 * things to the operator: the first is "too late, it is running", the second is
 * "the queue has already promoted it and it is about to run".
 */
export async function rescheduleJob(id: string, scheduledFor: Date): Promise<RescheduleOutcome> {
  const state = await getJobState(id);

  if (state === null) {
    return { ok: false, reason: "not_found" };
  }

  if (state.status !== "queued") {
    return { ok: false, reason: "already_started" };
  }

  const job = await importQueue.getJob(id);

  if (job === undefined) {
    return { ok: false, reason: "not_found" };
  }

  if ((await job.getState()) !== "delayed") {
    return { ok: false, reason: "not_delayed" };
  }

  await job.changeDelay(Math.max(0, scheduledFor.getTime() - Date.now()));

  await db.update(jobsTable).set({ scheduledFor }).where(eq(jobsTable.id, id));

  return { ok: true, scheduledFor: scheduledFor.toISOString() };
}

/**
 * Cancel many.
 *
 * Sequential on purpose: each cancel touches the BullMQ queue, and firing
 * thirty concurrent `remove()` calls at one Redis to save a few hundred
 * milliseconds trades correctness risk for nothing.
 */
export async function cancelMany(
  ids: ReadonlyArray<string>,
  ownerId: string,
  mode: CancelMode = "cancel",
): Promise<string[]> {
  return cancelWhere(ids, (state) => state.createdBy === ownerId, mode);
}

/**
 * Every unfinished run of one group — the runs one click created.
 *
 * `POST /api/import` with several sites creates one run per site sharing a
 * `groupId`, and the per-run Cancel acts on a single id, so "I cancelled the
 * import and it kept importing" was a completely fair description of cancelling
 * one of five. Listing the siblings is what lets the interface offer the whole
 * group and, more importantly, SAY that is what it is offering: "cancel 5 runs"
 * and "cancel this run" are different promises and must not share a button.
 */
export async function groupSiblings(id: string): Promise<JobState[]> {
  const state = await getJobState(id);

  if (state === null || state.groupId === null) {
    return state === null ? [] : [state];
  }

  const rows = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.groupId, state.groupId))
    .orderBy(desc(jobsTable.createdAt));

  return rows.map(toState);
}

/**
 * Cancel many, whoever they belong to. The administrator's bulk cancel.
 *
 * Separate function rather than `cancelMany(ids, ownerId?)`: leaving an
 * argument out must never be the difference between stopping your own runs and
 * stopping every customer's.
 */
export async function cancelManyUnscoped(
  ids: ReadonlyArray<string>,
  mode: CancelMode = "cancel",
): Promise<string[]> {
  return cancelWhere(ids, () => true, mode);
}

async function cancelWhere(
  ids: ReadonlyArray<string>,
  allowed: (state: JobState) => boolean,
  mode: CancelMode,
): Promise<string[]> {
  const cancelled: string[] = [];

  for (const id of ids) {
    const state = await getJobState(id);
    if (state === null || !allowed(state)) {
      continue;
    }
    if (state.status !== "queued" && state.status !== "running") {
      continue;
    }
    await requestCancel(id, mode);
    cancelled.push(id);
  }

  return cancelled;
}

/**
 * What deleting a run would actually take with it.
 *
 * Asked BEFORE the confirmation, not after, because "delete this run" and
 * "delete this run and 5,000 result rows, 100 batch records and the staged
 * payload" are the same click and very different acts. For a large run this
 * cascade is the only way to reclaim the space, which is a reason to make it
 * available and a better reason to quote the number first.
 */
export interface JobFootprint {
  id: string;
  results: number;
  batches: number;
  /**
   * Log lines. Counted because they cascade too, and because for a long run they
   * are a real share of what deleting reclaims — a figure on screen that quietly
   * omitted them would be a promise that does not add up.
   */
  logs: number;
  /** The staged payload — one row holding every product as JSON. */
  items: number;
  /** Every row that would go, the run row included. */
  total: number;
  /** False when the run is still queued or running, so it cannot be deleted. */
  deletable: boolean;
  status: JobStatus;
}

export async function jobFootprint(id: string): Promise<JobFootprint | null> {
  const state = await getJobState(id);

  if (state === null) {
    return null;
  }

  const [[results], [batches], [items], [logs]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobResults)
      .where(eq(jobResults.jobId, id)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobBatches)
      .where(eq(jobBatches.jobId, id)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobItems)
      .where(eq(jobItems.jobId, id)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobLogs)
      .where(eq(jobLogs.jobId, id)),
  ]);

  const counts = {
    results: results?.count ?? 0,
    batches: batches?.count ?? 0,
    items: items?.count ?? 0,
    logs: logs?.count ?? 0,
  };

  return {
    id,
    ...counts,
    total: 1 + counts.results + counts.batches + counts.items + counts.logs,
    deletable: !(state.status === "running" || state.status === "queued"),
    status: state.status,
  };
}

/**
 * Several runs' footprints at once — ONE ACCOUNT's — for the bulk confirmation.
 *
 * The owner filter is in the query rather than applied afterwards, and it is not
 * decoration: a row count for another customer's run is still a fact about
 * another customer, so an id that is not theirs has to disappear before any
 * number is computed from it, not after.
 */
export async function jobFootprintsFor(
  ids: ReadonlyArray<string>,
  ownerId: string,
): Promise<JobFootprint[]> {
  if (ids.length === 0) {
    return [];
  }

  const mine = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(inArray(jobsTable.id, [...ids]), eq(jobsTable.createdBy, ownerId)));

  const all = await Promise.all(mine.map((row) => jobFootprint(row.id)));

  return all.filter((footprint): footprint is JobFootprint => footprint !== null);
}

/** Remove a finished run from history, with everything hanging off it. */
export async function forgetJob(id: string): Promise<boolean> {
  const state = await getJobState(id);
  if (state === null) {
    return false;
  }

  // Deleting the row of a live run would leave the worker with nowhere to
  // write progress. This refusal is deliberate and stays: Cancel or Stop it
  // first, then delete it.
  if (state.status === "running" || state.status === "queued") {
    return false;
  }

  // job_item, job_result, job_batch and job_log all cascade from job — and so does
  // the cancel record, which is a column rather than a key in another store.
  await db.delete(jobsTable).where(eq(jobsTable.id, id));

  return true;
}

/**
 * Drop a staged occurrence of a repeating series that has not begun — §6 C2.
 *
 * Narrow ON PURPOSE, and the narrowness is the point. `forgetJob` refuses a queued
 * run and that refusal stays: deleting the row of a live run leaves the worker with
 * nowhere to write progress. But pausing or deleting a SERIES has to take its
 * pending occurrence with it, and leaving that behind would mean a series somebody
 * paused still publishes tonight — which is the worst surprise this feature could
 * produce.
 *
 * So this accepts only a run that belongs to a series, is still queued, and has
 * never started. Nothing else can reach it. A `cancelled` row would have been the
 * lazier option and it would be a lie in the history: nothing happened, and the
 * operator asked for quiet rather than for a record of a non-event.
 *
 * The race it cannot win, stated rather than hidden: if the worker claims the job in
 * the same instant, the removal fails, this returns false, and that one occurrence
 * runs. Same race Cancel has, for the same reason, and the caller carries on
 * pausing the series either way.
 */
export async function dropStagedRun(id: string): Promise<boolean> {
  const state = await getJobState(id);

  if (state === null || state.scheduleId === null) {
    return false;
  }

  if (state.status !== "queued" || state.startedAt !== null || state.processed > 0) {
    return false;
  }

  const queued = await importQueue.getJob(id);
  const removed = queued === undefined ? true : await queued.remove().then(
    () => true,
    () => false,
  );

  // Re-read: `remove()` losing to the worker's lock is exactly the case this has to
  // notice, and the database is what says whether the run has begun.
  const fresh = await getJobState(id);

  if (!removed || fresh === null || fresh.status !== "queued" || fresh.startedAt !== null) {
    return false;
  }

  await db.delete(jobsTable).where(eq(jobsTable.id, id));

  return true;
}

/**
 * Delete many, and only the ones this account owns.
 *
 * Shaped like `cancelMany`: filtered per id rather than in one statement, so a
 * single id belonging to someone else is skipped instead of turning the whole
 * request into an error that says which ids were real.
 */
export async function forgetMany(
  ids: ReadonlyArray<string>,
  ownerId: string,
): Promise<string[]> {
  return forgetWhere(ids, (state) => state.createdBy === ownerId);
}

/** Delete many, whoever they belong to. The administrator's bulk delete. */
export async function forgetManyUnscoped(ids: ReadonlyArray<string>): Promise<string[]> {
  return forgetWhere(ids, () => true);
}

async function forgetWhere(
  ids: ReadonlyArray<string>,
  allowed: (state: JobState) => boolean,
): Promise<string[]> {
  const deleted: string[] = [];

  for (const id of ids) {
    const state = await getJobState(id);
    if (state === null || !allowed(state)) {
      continue;
    }
    if (await forgetJob(id)) {
      deleted.push(id);
    }
  }

  return deleted;
}

export { and, eq, inArray };
