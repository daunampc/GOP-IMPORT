/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import { ImageDownloadError } from "./image-download";

/**
 * How an image that would not copy is treated: which failures are worth another go,
 * how long to wait, and how to stop sixteen lanes from hammering a host that has just
 * said "slow down".
 *
 * Three kinds of failure, because they want three different answers:
 *
 *  - `throttled` — the source (HTTP 429) or the bucket (S3 `SlowDown`, 503) is telling
 *    this process to go slower. Nothing is wrong with the image. Try again, for a long
 *    time if need be, and slow EVERYONE down while doing it.
 *  - `transient` — a timeout, a dropped connection, a 5xx. Probably over in seconds.
 *    A few attempts.
 *  - `permanent` — a 404, a login page served as an image, a file over the limit. Asking
 *    again changes nothing, so nobody asks.
 */

export type FailureKind = "throttled" | "transient" | "permanent";

export interface Classified {
  kind: FailureKind;
  /** Which side said so — decides whose pace is cut. `source` is the image's host. */
  origin: "source" | "bucket";
  /** What the server asked for, when it asked. */
  retryAfterMs: number | null;
}

/** Throttled attempts per image before it is parked for the end of the run. */
export const THROTTLE_ATTEMPTS = 10;

/** Plain failures: attempts in all is this plus one. One pause per retry. */
export const TRANSIENT_DELAYS_MS = [1_000, 4_000];

/** Longest a backoff grows to, and so the longest one throttled attempt waits. */
export const MAX_BACKOFF_MS = 30_000;

/** A `Retry-After` is honoured, but not past this. A host does not set our queue. */
export const MAX_RETRY_AFTER_MS = 60_000;

const THROTTLE_NAMES = new Set([
  "SlowDown",
  "ThrottlingException",
  "Throttling",
  "RequestLimitExceeded",
  "TooManyRequestsException",
  "RequestThrottled",
]);

export function classifyImageError(error: unknown): Classified {
  if (error instanceof ImageDownloadError) {
    const status = error.status;

    if (status === 429) {
      return { kind: "throttled", origin: "source", retryAfterMs: error.retryAfterMs ?? null };
    }

    if (status === undefined) {
      // This app's own refusal (internal address, HTML page, too large, empty).
      return { kind: "permanent", origin: "source", retryAfterMs: null };
    }

    if (status === 408 || status === 425 || status >= 500) {
      return { kind: "transient", origin: "source", retryAfterMs: null };
    }

    // 404, 403, 410, 401 …: the source has answered, and the answer is no.
    return { kind: "permanent", origin: "source", retryAfterMs: null };
  }

  // The AWS SDK: `$metadata.httpStatusCode`, a `name`, and `$retryable.throttling`.
  const aws = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
    $retryable?: { throttling?: boolean };
  } | null;

  if (aws !== null && typeof aws === "object") {
    const status = aws.$metadata?.httpStatusCode;

    if (
      aws.$retryable?.throttling === true ||
      (aws.name !== undefined && THROTTLE_NAMES.has(aws.name)) ||
      status === 429 ||
      status === 503
    ) {
      return { kind: "throttled", origin: "bucket", retryAfterMs: null };
    }
  }

  // Anything else — a network error, an abort on the deadline — is worth a few goes.
  return { kind: "transient", origin: "bucket", retryAfterMs: null };
}

/**
 * How long to wait after the Nth throttled answer.
 *
 * The server's own `Retry-After` wins when there is one. Otherwise 1s, 2s, 4s, 8s …
 * up to `MAX_BACKOFF_MS`, with ±25% jitter: without it every lane that was refused
 * together comes back together, and is refused together again.
 */
export function backoffMs(
  throttledSoFar: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }

  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, throttledSoFar - 1));

  return Math.round(base * (0.75 + random() * 0.5));
}

/* ------------------------------------------------------------------ the gate */

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Aborted"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

interface HostState {
  cooldownUntil: number;
  /** Most requests allowed in flight against this host right now. */
  limit: number;
  inFlight: number;
  /** Successes since the last throttle — how many it takes to earn a lane back. */
  okStreak: number;
  lastDecreaseAt: number;
}

/** Successes in a row that give one lane back. */
const SUCCESSES_PER_LANE = 10;

/** How often a waiting lane re-checks for a free slot. */
const SLOT_POLL_MS = 20;

/**
 * A shared pause and a shared pace for each host.
 *
 * WHY IT IS SHARED. A retry loop per image is not enough: sixteen lanes against one
 * host each back off on their own, the host keeps being asked sixteen times a moment,
 * and keeps answering 429. The first throttled answer therefore sets a COOLDOWN that
 * every lane reaching that host waits out, and CUTS the number of lanes allowed on it
 * by half; each run of ten successes gives one back. Other hosts are untouched — a
 * catalogue's images usually come from one or two, and one being slow is no reason to
 * slow the rest.
 *
 * Keys are free-form strings: the source's `host`, and `"bucket"` for S3 itself.
 */
export class HostGate {
  private readonly hosts = new Map<string, HostState>();

  constructor(
    /** The most lanes any host ever gets — the process-wide download ceiling. */
    private readonly ceiling: number,
    readonly clock: Clock = realClock,
  ) {}

  /**
   * Wait until every key is out of cooldown and has a free lane, then hold one lane on
   * each. Returns the release; call it when the request has finished, BEFORE waiting
   * anything out, so a lane asleep on a backoff does not also occupy a slot.
   */
  async acquire(keys: string[], signal?: AbortSignal): Promise<() => void> {
    const sorted = [...new Set(keys)].sort();
    const held: string[] = [];

    try {
      for (const key of sorted) {
        await this.enter(key, signal);
        held.push(key);
      }
    } catch (error) {
      for (const key of held) {
        this.leave(key);
      }
      throw error;
    }

    let released = false;

    return () => {
      if (!released) {
        released = true;
        for (const key of held) {
          this.leave(key);
        }
      }
    };
  }

  /**
   * The host said slow down. Returns true when this started a new pause — the caller
   * logs once per pause rather than once per lane that heard about it.
   */
  throttled(key: string, waitMs: number): boolean {
    const state = this.state(key);
    const now = this.clock.now();
    const fresh = now >= state.cooldownUntil;

    state.cooldownUntil = Math.max(state.cooldownUntil, now + waitMs);
    state.okStreak = 0;

    // Halved once per pause. Sixteen lanes refused in the same second are ONE signal,
    // not sixteen, and halving for each would drop a healthy host to a single lane.
    if (now - state.lastDecreaseAt >= waitMs) {
      state.limit = Math.max(1, Math.floor(state.limit / 2));
      state.lastDecreaseAt = now;
    }

    return fresh;
  }

  succeeded(keys: string[]): void {
    for (const key of keys) {
      const state = this.state(key);

      state.okStreak++;

      if (state.okStreak >= SUCCESSES_PER_LANE && state.limit < this.ceiling) {
        state.limit++;
        state.okStreak = 0;
      }
    }
  }

  /** For the log and the tests. */
  snapshot(key: string): { limit: number; cooldownMs: number } {
    const state = this.state(key);
    return { limit: state.limit, cooldownMs: Math.max(0, state.cooldownUntil - this.clock.now()) };
  }

  private state(key: string): HostState {
    let state = this.hosts.get(key);

    if (state === undefined) {
      state = { cooldownUntil: 0, limit: this.ceiling, inFlight: 0, okStreak: 0, lastDecreaseAt: 0 };
      this.hosts.set(key, state);
    }

    return state;
  }

  private async enter(key: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      // Checked on every pass, not only when a wait happens to be asleep: a Stop that
      // arrives while no host is paused must still end the work, not wait for a 429.
      if (signal?.aborted === true) {
        throw signal.reason ?? new Error("Aborted");
      }

      const state = this.state(key);
      const wait = state.cooldownUntil - this.clock.now();

      if (wait > 0) {
        await this.clock.sleep(wait, signal);
        continue;
      }

      if (state.inFlight >= state.limit) {
        await this.clock.sleep(SLOT_POLL_MS, signal);
        continue;
      }

      state.inFlight++;
      return;
    }
  }

  private leave(key: string): void {
    const state = this.state(key);
    state.inFlight = Math.max(0, state.inFlight - 1);
  }
}
