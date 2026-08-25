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

import { assertFetchableUrl } from "../../outbound-url";
import { CRAWLER_USER_AGENT } from "./robots";
import { CrawlError, type CrawlResponse, type CrawlTransport } from "./types";

export interface ServerTransportOptions {
  signal: AbortSignal;
  /** Minimum gap between two requests to the same host. */
  delayMs: number;
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Retried statuses, and how long to wait before each attempt. */
const BACKOFF_MS = [1_000, 4_000, 10_000];

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

export function serverTransport(options: ServerTransportOptions): CrawlTransport {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** When each host may next be asked for something. */
  const nextAllowedAt = new Map<string, number>();

  async function once(url: URL): Promise<CrawlResponse> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([options.signal, deadline]);

    const response = await fetch(url, {
      signal,
      redirect: "follow",
      headers: {
        "User-Agent": CRAWLER_USER_AGENT,
        Accept: "application/json, text/html;q=0.9, */*;q=0.5",
      },
    });

    /*
     * Read with a ceiling rather than calling `.text()`.
     *
     * `.text()` on a response with no `content-length` — a chunked one, which is
     * most of them — will happily buffer a gigabyte into the worker's heap, and
     * the worker is capped at 2G in ecosystem.config.js for every run at once.
     */
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
            `${url.host} sent more than ${Math.round(maxBytes / 1024 / 1024)} MB for one request.`,
          );
        }

        body += decoder.decode(value, { stream: true });
      }

      body += decoder.decode();
    }

    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
    };
  }

  return {
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

      for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
        if (options.signal.aborted) {
          throw new CrawlError("The run was stopped.");
        }

        nextAllowedAt.set(url.host, Date.now() + options.delayMs);

        try {
          const response = await once(url);

          // 429 and 503 are the site asking for room. Anything else is an answer,
          // including a 404 the adapter needs to see.
          if (response.status !== 429 && response.status !== 503) {
            return response;
          }

          lastError = new CrawlError(`${url.host} answered ${response.status}.`);
        } catch (error) {
          lastError = error;
        }

        if (attempt < BACKOFF_MS.length) {
          await sleep(BACKOFF_MS[attempt], options.signal);
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new CrawlError(`${url.host} could not be read.`);
    },
  };
}
