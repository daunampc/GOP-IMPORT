/*
 * Fetching, from this server.
 *
 * Everything an adapter asks for comes through here, which is what makes the
 * guarantees below true of the whole crawler rather than of whichever adapter
 * remembered them: the SSRF check, the delay between requests to one host, the
 * backoff, the size ceiling and the deadline.
 *
 * Do NOT import "server-only" — the worker imports this.
 */

import { assertFetchableUrl, OutboundUrlError } from "../../outbound-url";
import { CRAWLER_USER_AGENT } from "./robots";
import { CrawlError, type CrawlResponse, type CrawlTransport } from "./types";

export interface ServerTransportOptions {
  signal: AbortSignal;
  /** Minimum gap between two requests to the same host. */
  delayMs: number;
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * Substituted by the tests, so redirect handling can be proven without a
   * network. Production leaves it unset.
   */
  fetchImpl?: typeof fetch;
  /**
   * Substituted by the tests, so the retry schedule can be asserted without
   * waiting it out. Production leaves it unset and gets `BACKOFF_MS`.
   */
  backoffMs?: number[];
}

/**
 * A transport whose politeness floor can be raised after it is built.
 *
 * The crawl has to fetch robots.txt before it can know the site's `Crawl-delay`,
 * and that fetch is itself a request to the same host. Building a second
 * transport once the answer is known would start a fresh per-host clock and let
 * the first product request follow robots.txt with no gap at all, so the one
 * transport learns instead.
 */
export interface ServerTransport extends CrawlTransport {
  /** Raise the floor. Never lowers it: a site asking for room is not negotiable. */
  raiseDelayTo(ms: number): void;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Retried statuses, and how long to wait before each attempt. */
const BACKOFF_MS = [1_000, 4_000, 10_000];

/** Redirect hops allowed before a chain is treated as a loop. */
const MAX_REDIRECTS = 5;

/**
 * A byte ceiling for the error message a caller reads.
 *
 * `Math.round(maxBytes / 1024 / 1024)` reads fine for the 8 MB default, but a
 * test (or a future caller) with a ceiling under half a megabyte rounds to
 * "0 MB", which is not what happened. Pick the unit the value actually fits.
 */
function formatByteCeiling(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / 1024 / 1024)} MB`;
  }

  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${bytes} bytes`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function serverTransport(options: ServerTransportOptions): ServerTransport {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const backoff = options.backoffMs ?? BACKOFF_MS;
  let delayMs = options.delayMs;

  /** When each host may next be asked for something. */
  const nextAllowedAt = new Map<string, number>();

  /*
   * Read with a ceiling rather than calling `.text()`.
   *
   * `.text()` on a response with no `content-length` — a chunked one, which is
   * most of them — will happily buffer a gigabyte into the worker's heap, and
   * the worker is capped at 2G in ecosystem.config.js for every run at once.
   */
  async function readBounded(response: Response, url: URL): Promise<string> {
    const reader = response.body?.getReader();
    let body = "";

    if (reader !== undefined) {
      const decoder = new TextDecoder();
      let size = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new CrawlError(
            `${url.host} sent more than ${formatByteCeiling(maxBytes)} for one request.`,
          );
        }

        body += decoder.decode(value, { stream: true });
      }

      body += decoder.decode();
    }

    return body;
  }

  async function once(start: URL): Promise<CrawlResponse> {
    let target = start;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([options.signal, deadline]);

      /*
       * `manual`, and this is the security property of the whole file.
       *
       * With `follow`, Node's fetch walks the redirect chain internally and
       * consults nothing: a public host that passes the guard and then answers
       * 302 to 169.254.169.254 would have the metadata endpoint read on its
       * behalf. lib/outbound-url.ts calls refusing exactly that at the SECOND
       * hop the reason the resolving check exists, so the chain has to be walked
       * here, where each hop can be checked.
       */
      const response = await doFetch(target, {
        signal,
        redirect: "manual",
        headers: {
          "User-Agent": CRAWLER_USER_AGENT,
          Accept: "application/json, text/html;q=0.9, */*;q=0.5",
        },
      });

      const location = response.headers.get("location");

      /*
       * A rate-limit answer is a signal, not content.
       *
       * Returned before the body is read, and that ordering is the fix for a
       * real bug rather than an optimisation: reading first meant a 429 whose
       * error page happened to exceed the size ceiling threw from in here, and
       * the throw reached the caller's non-retryable branch before anything had
       * looked at the status. A 429 then failed instantly instead of backing
       * off, which is the opposite of what a site asking for room deserves.
       */
      if (response.status === 429 || response.status === 503) {
        await response.body?.cancel();

        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          body: "",
        };
      }

      if (response.status < 300 || response.status >= 400 || location === null) {
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          body: await readBounded(response, target),
        };
      }

      // Nothing downstream wants a redirect's body, and an unread stream holds
      // the socket open.
      await response.body?.cancel();

      // The hop is a URL this app is about to fetch, so it faces the same check
      // the first one did. Relative Locations are resolved against the hop they
      // came from, not against the original.
      target = await assertFetchableUrl(new URL(location, target).toString());
    }

    throw new CrawlError(
      `${start.host} redirected more than ${MAX_REDIRECTS} times without answering.`,
    );
  }

  return {
    raiseDelayTo(ms: number): void {
      delayMs = Math.max(delayMs, ms);
    },

    async fetchText(raw: string): Promise<CrawlResponse> {
      /*
       * THE guard. `assertFetchableUrl` resolves the hostname and inspects every
       * address behind it, which is the check this path needs: a crawler keeps
       * the body and follows redirects, so a public name pointing at 10.0.0.5 is
       * not a theoretical problem. See lib/outbound-url.ts.
       */
      const url = await assertFetchableUrl(raw);

      const wait = (nextAllowedAt.get(url.host) ?? 0) - Date.now();
      if (wait > 0) {
        await sleep(wait, options.signal);
      }

      let lastError: unknown = null;

      for (let attempt = 0; attempt <= backoff.length; attempt++) {
        if (options.signal.aborted) {
          throw new CrawlError("The run was stopped.");
        }

        nextAllowedAt.set(url.host, Date.now() + delayMs);

        try {
          const response = await once(url);

          // 429 and 503 are the site asking for room. Anything else is an answer,
          // including a 404 the adapter needs to see.
          if (response.status !== 429 && response.status !== 503) {
            return response;
          }

          lastError = new CrawlError(`${url.host} answered ${response.status}.`);
        } catch (error) {
          // A blocked hop, a redirect loop, or a body past the ceiling will fail
          // the exact same way next time — retrying only spends the backoff
          // delay for nothing. 429/503 and a dropped connection are the cases
          // this loop exists for, and neither throws here.
          if (error instanceof OutboundUrlError || error instanceof CrawlError) {
            throw error;
          }

          lastError = error;
        }

        if (attempt < backoff.length) {
          await sleep(backoff[attempt], options.signal);
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new CrawlError(`${url.host} could not be read.`);
    },
  };
}
