/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import { GopAbortError, GopApiError } from "./gop-client";

/**
 * How the worker behaves towards a site that is struggling.
 *
 * Two reactions, one subject. Sending a batch AGAIN when the site failed to
 * answer, and standing a lane DOWN when it is answering but slowly. They belong
 * together because they read the same evidence — this site is not coping — and
 * because the two failure modes they guard against are the same shop on a bad day.
 *
 * Neither one ever changes WHAT a run does. Every product still goes; a reduced
 * lane count only changes how many go at once, and a resend only repeats what was
 * already sent. That distinction is why this is not the "refuse rather than
 * silently trim" rule being broken: nothing is trimmed, and every adjustment is
 * logged with the number that caused it.
 *
 * ---
 *
 * Whether a batch that failed is worth sending again, and how long to wait.
 *
 * The whole feature turns on one distinction, and getting it wrong is worse than
 * not having retry at all:
 *
 *   the site did not ANSWER   → often over by the next attempt, so send it again
 *   the site did not ACCEPT   → the same answer however many times it is sent
 *
 * A row with no name, a SKU matching two products, a slug already taken, a SKU
 * that is not on the site: every one of those fails identically for ever. Sending
 * them again makes a doomed run take three times as long to reach the same
 * conclusion, with every batch of it sitting out a backoff nobody benefits from —
 * so the classification reads the error CODE the client produced, never the fact
 * that something went wrong and never the wording of a message.
 *
 * It is deliberately NARROW. A code that is not named here is not retried, which
 * means a new plugin error code costs an operator nothing while a wrongly
 * optimistic guess costs every run that hits it.
 */

/** Times a batch is sent before its failure is recorded. Initial try included. */
export const DEFAULT_BATCH_ATTEMPTS = 3;

/** Wait after the first failed attempt. Doubles for each one after that. */
export const DEFAULT_RETRY_BACKOFF_MS = 2000;

/**
 * Read from the environment for the same reason `GOP_REQUEST_TIMEOUT_MS` is: the
 * numbers that decide how long a wedged site can hold a run have to be reachable
 * without a deploy, and the test suite needs to set them to values a person can
 * watch.
 */
export function batchAttempts(): number {
  const raw = Number.parseInt(process.env.GOP_BATCH_ATTEMPTS ?? "", 10);

  // Capped: "retry for ever" is not a setting. A site that has failed ten times
  // is a site somebody needs to look at, not one to keep hammering.
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 10) : DEFAULT_BATCH_ATTEMPTS;
}

export function retryBackoffMs(): number {
  const raw = Number.parseInt(process.env.GOP_RETRY_BACKOFF_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RETRY_BACKOFF_MS;
}

/**
 * How long to wait after `attempt` has just failed: 2s, then 4s at the default.
 *
 * Backoff rather than an immediate resend because the failure this exists for is
 * a site under load, and answering an overloaded shop by hitting it again
 * straight away is how one slow batch becomes a run of them.
 */
export function retryDelayMs(attempt: number): number {
  return retryBackoffMs() * 2 ** Math.max(0, attempt - 1);
}

/**
 * How slow one batch has to be before the run keeps one fewer lane flying.
 *
 * Half the default request deadline. A batch is at most 50 products, so over a
 * minute for one of them means the shop is suffering — and 32 lanes of that is how
 * a small shop gets taken down by a tool that was only asked to import a file.
 *
 * A heavy batch on a slow shared host can legitimately cross this, and standing a
 * lane down there is the RIGHT answer rather than a false positive: the run still
 * completes, still sends every product, and stops leaning on a host that is
 * visibly straining. Which is also why the reduction is one lane at a time and
 * never goes below one.
 *
 * A batch that hits its request deadline is by definition over this threshold, so
 * a timing rule covers the timeout case without a second rule for it.
 */
export const DEFAULT_SLOW_BATCH_MS = 60_000;

export function slowBatchMs(): number {
  const raw = Number.parseInt(process.env.GOP_SLOW_BATCH_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SLOW_BATCH_MS;
}

/**
 * HTTP statuses that mean "not now" rather than "no".
 *
 * 500 is deliberately absent. A PHP fatal error is the ordinary cause of a 500
 * from a WordPress site and it is perfectly deterministic — its message is the
 * actionable thing, and burying it under three attempts helps nobody. A shop that
 * is genuinely overwhelmed answers 502/503/504 from its front end, or does not
 * answer at all.
 */
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

/**
 * Network-layer failures, which reach the client as a plain Error rather than as
 * a `GopApiError` — undici wraps the real cause, so the chain is what carries it.
 *
 * `ENOTFOUND` and `ECONNREFUSED` are NOT here, and that is the interesting half.
 * They are what a mistyped site URL or a wrong "plugin base URL override" looks
 * like: permanent, immediate, and identical every time. Retrying them turns a run
 * that fails fast with an obvious cause into one that spends its backoffs proving
 * the same thing over and over.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  // DNS saying "ask again", as opposed to ENOTFOUND's "there is no such name".
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export function isTransientFailure(error: unknown): boolean {
  /*
   * A Stop is NEVER transient, and this is the single most important line here.
   *
   * It is the operator ending the run, not the site misbehaving. Retrying it
   * would make Stop stop nothing at exactly the moment it matters most — the
   * caller returns on this class instead, and this guard exists so a future
   * reordering there cannot quietly turn a press of Stop into three more
   * requests.
   */
  if (error instanceof GopAbortError) {
    return false;
  }

  if (error instanceof GopApiError) {
    return error.code === "request_timeout" || TRANSIENT_STATUS.has(error.status);
  }

  return hasTransientNetworkCode(error);
}

function hasTransientNetworkCode(error: unknown): boolean {
  // Bounded walk: `cause` is a chain of unknown depth and a cyclic one would
  // otherwise hang the worker inside its own error handling.
  let current: unknown = error;

  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;

    if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
      return true;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}
