import type { JobState } from "./jobs";

/**
 * Aggregates run history for the dashboard and for the import estimate.
 *
 * PURE functions taking the run list as an argument: the dashboard and the
 * estimate then share one calculation, and nobody has to work out why two
 * places disagree.
 */

export interface DailyStat {
  /** `YYYY-MM-DD` in the server's local time. */
  date: string;
  jobs: number;
  products: number;
  succeeded: number;
  failed: number;
  deduplicated: number;
}

export interface Stats {
  jobs: number;
  products: number;
  succeeded: number;
  failed: number;
  deduplicated: number;
  /** Success rate from 0 to 1. `null` before anything has run. */
  successRate: number | null;
  /** Products per second, measured against a run's wall clock. */
  productsPerSecond: number | null;
  /** Mean time the plugin spent on one batch, in milliseconds. */
  avgBatchMs: number | null;
  daily: DailyStat[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(iso: string): string {
  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function computeStats(jobs: ReadonlyArray<JobState>, days = 14): Stats {
  // Finished runs only: a running one has `processed` changing every second,
  // and folding it in makes every average jump with it.
  const finished = jobs.filter(
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled",
  );

  const products = finished.reduce((sum, job) => sum + job.processed, 0);
  const succeeded = finished.reduce((sum, job) => sum + job.succeeded, 0);
  const failed = finished.reduce((sum, job) => sum + job.failed, 0);
  const deduplicated = finished.reduce((sum, job) => sum + job.deduplicated, 0);

  const timed = finished.filter(
    (job) => job.startedAt !== null && job.finishedAt !== null && job.processed > 0,
  );

  const wallSeconds = timed.reduce((sum, job) => {
    const span =
      new Date(job.finishedAt as string).getTime() - new Date(job.startedAt as string).getTime();
    return sum + Math.max(span, 1) / 1000;
  }, 0);

  const timedProducts = timed.reduce((sum, job) => sum + job.processed, 0);

  const withBatches = finished.filter((job) => job.batchesDone > 0 && job.pluginElapsedMs > 0);
  const batchMs = withBatches.reduce((sum, job) => sum + job.pluginElapsedMs, 0);
  const batchCount = withBatches.reduce((sum, job) => sum + job.batchesDone, 0);

  // Build all `days` days including empty ones — a chart with gaps reads as
  // "a quiet day" rather than "no runs at all".
  const buckets = new Map<string, DailyStat>();
  const today = new Date();

  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today.getTime() - offset * DAY_MS);
    const key = dayKey(date.toISOString());
    buckets.set(key, {
      date: key,
      jobs: 0,
      products: 0,
      succeeded: 0,
      failed: 0,
      deduplicated: 0,
    });
  }

  for (const job of finished) {
    const key = dayKey(job.finishedAt ?? job.createdAt);
    const bucket = buckets.get(key);
    if (!bucket) {
      continue;
    }
    bucket.jobs += 1;
    bucket.products += job.processed;
    bucket.succeeded += job.succeeded;
    bucket.failed += job.failed;
    bucket.deduplicated += job.deduplicated;
  }

  return {
    jobs: finished.length,
    products,
    succeeded,
    failed,
    deduplicated,
    successRate: products > 0 ? succeeded / products : null,
    productsPerSecond: wallSeconds > 0 && timedProducts > 0 ? timedProducts / wallSeconds : null,
    avgBatchMs: batchCount > 0 ? batchMs / batchCount : null,
    daily: [...buckets.values()],
  };
}

/**
 * Estimating how long a run will take.
 *
 * Uses speeds actually measured from history; with no history it uses a
 * conservative number and SAYS SO, rather than presenting a guess that looks
 * measured.
 */
export interface Estimate {
  batches: number;
  /** Seconds. */
  seconds: number;
  /** `measured` when based on real history, `default` when it is only a guess. */
  basis: "measured" | "default";
}

const FALLBACK_BATCH_MS = 1500;

export function estimateDuration(
  productCount: number,
  threads: number,
  batchSize: number,
  avgBatchMs: number | null,
): Estimate {
  const batches = Math.ceil(productCount / Math.max(1, batchSize));
  const lanes = Math.max(1, threads);
  const perBatch = avgBatchMs ?? FALLBACK_BATCH_MS;

  return {
    batches,
    seconds: Math.round((Math.ceil(batches / lanes) * perBatch) / 1000),
    basis: avgBatchMs === null ? "default" : "measured",
  };
}
