/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

/**
 * How many image downloads this PROCESS may have in flight, across every run.
 *
 * WHY A GLOBAL LIMIT AND NOT A PER-BATCH ONE, which is what there was:
 *
 * `lib/images.ts` ran its downloads eight at a time, and that number is per CALL —
 * once per batch. Batches fly in `threads` lanes, so the real figure was
 * `threads × 8`: at the maximum the option allows, 32 lanes, **256 concurrent
 * downloads**. Nothing anywhere said so, and nobody chose it.
 *
 * That number is not fast, it is slow. Past the point where the link is saturated,
 * every extra download makes all the others slower, and the ones that tip over the
 * 30 second deadline are not merely late — they fail, and their images fall back to
 * the original URL. So the operator's remedy for a slow run ("raise the threads")
 * made image staging worse while appearing to address it.
 *
 * A ceiling on the process makes throughput a property of the machine and its link
 * rather than an accident of two unrelated numbers multiplied together. `threads`
 * goes back to meaning what the UI says it means: how many batches of PRODUCTS are
 * in flight.
 */

/** In flight at once, when nothing is configured. */
export const DEFAULT_DOWNLOAD_LANES = 16;

/** Nobody's link is served by more than this, and the deadline starts biting. */
const MAX_DOWNLOAD_LANES = 64;

export function downloadLanes(): number {
  const raw = Number.parseInt(process.env.GOP_IMAGE_DOWNLOAD_LANES ?? "", 10);

  if (!Number.isFinite(raw) || raw < 1) {
    return DEFAULT_DOWNLOAD_LANES;
  }

  return Math.min(raw, MAX_DOWNLOAD_LANES);
}

/** What the limiter has been asked to do, for the run log. See `downloadStats`. */
export interface DownloadStats {
  /** Downloads that had to wait for a slot, rather than starting at once. */
  queued: number;
  /** Total time spent waiting for a slot, in milliseconds. */
  waitedMs: number;
  /** The most that were ever in flight together. */
  peak: number;
}

let inFlight = 0;
let peak = 0;
let queued = 0;
let waitedMs = 0;

const waiting: Array<() => void> = [];

/**
 * Run `work` with a slot held, waiting for one if the process is at its ceiling.
 *
 * Deliberately a function wrapper rather than acquire/release calls: a `release` that
 * can be forgotten on a throw is a deadlock, and every caller here downloads inside a
 * `try` that can throw.
 */
export async function withDownloadSlot<T>(work: () => Promise<T>): Promise<T> {
  const limit = downloadLanes();

  if (inFlight >= limit) {
    const startedWaiting = Date.now();
    queued++;

    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });

    waitedMs += Date.now() - startedWaiting;
  }

  inFlight++;
  peak = Math.max(peak, inFlight);

  try {
    return await work();
  } finally {
    inFlight--;

    // Hand the slot to whoever has been waiting longest, so a lane cannot be starved
    // by later arrivals.
    const next = waiting.shift();
    if (next !== undefined) {
      next();
    }
  }
}

/**
 * The counters, so a run can log what the limit actually did.
 *
 * Without this the ceiling is untunable: an operator asking "is 16 too low?" needs to
 * know whether anything ever waited, and for how long. `queued: 0` means the limit was
 * never reached and raising it would change nothing.
 */
export function downloadStats(): DownloadStats {
  return { queued, waitedMs, peak };
}

/** Process-wide, so a run reads the delta rather than the total. */
export function resetDownloadStats(): void {
  queued = 0;
  waitedMs = 0;
  peak = inFlight;
}
