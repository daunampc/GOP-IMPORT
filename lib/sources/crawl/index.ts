/*
 * The crawl, start to finish.
 *
 * Order matters and is the point of this file: robots.txt is read BEFORE any
 * product request goes out, so a disallowed store costs it one request and
 * nothing else. Everything after that is the adapter's business.
 *
 * Do NOT import "server-only" — the worker imports this.
 */

import type { Product } from "../../gop-client";
import { shopifyAdapter } from "./adapters/shopify";
import { CRAWLER_USER_AGENT, parseRobots } from "./robots";
import { serverTransport, type ServerTransport } from "./transport";
import {
  CrawlError,
  type CrawlAdapter,
  type CrawlLogLine,
  type CrawlTransport,
  type PlatformName,
} from "./types";

/**
 * Only Shopify, on purpose.
 *
 * The other four adapters are plan 2. An `auto` detection that can only ever
 * answer "shopify" would be a lie told by a lookup table, so `pickAdapter`
 * refuses a store it cannot serve rather than guessing.
 */
const ADAPTERS: ReadonlyArray<CrawlAdapter> = [shopifyAdapter];

/** How long to leave between two requests to the same host, unless robots says more. */
const DEFAULT_DELAY_MS = 300;

/**
 * The most a site's `Crawl-delay` can slow this crawler down.
 *
 * Honoured, but not without limit. The worker runs four job slots for the whole
 * installation, so a shop declaring a delay of an hour would hold one of them
 * against every other account's imports — a site gets to ask for room, not to
 * decide how long somebody else's queue waits.
 */
const MAX_CRAWL_DELAY_MS = 10_000;

/**
 * A wall-clock ceiling on one crawl, for the same reason `MAX_PAGES` exists.
 *
 * The page cap alone does not bound the time: pages multiplied by a large delay,
 * or by a shop that answers very slowly, still runs indefinitely.
 */
const MAX_CRAWL_MS = 30 * 60_000;

export interface CrawlInput {
  shopUrl: string;
  platform: PlatformName | "auto";
  limit: number;
  imagesPerProduct: number;
  minorUnit: number;
  fxRate: number | null;
  signal: AbortSignal;
  log: (line: CrawlLogLine) => void;
  /** Substituted by the tests. Production leaves it unset. */
  transport?: CrawlTransport;
}

export interface CrawlOutcome {
  platform: PlatformName;
  products: Product[];
  warnings: string[];
}

export async function crawlShop(input: CrawlInput): Promise<CrawlOutcome> {
  let shopUrl: URL;
  try {
    shopUrl = new URL(input.shopUrl);
  } catch {
    throw new CrawlError(`Not a web address: ${input.shopUrl}`);
  }

  if (shopUrl.protocol !== "https:" && shopUrl.protocol !== "http:") {
    throw new CrawlError("A shop address has to start with http:// or https://.");
  }

  const warnings: string[] = [];

  /*
   * A wall-clock ceiling, combined with whatever the caller already passed.
   *
   * `deadline` is kept as its own signal, separately from `signal`, so that
   * later — in the catch below — this crawl can tell "the cap fired" apart
   * from "the operator pressed Stop": both abort `signal`, but only one of
   * them also aborts `deadline`. Passed into the transport and the adapter
   * context in place of `input.signal`, so a run that has gone on too long
   * aborts in flight the same way a Stop does, rather than only being noticed
   * after the fact.
   */
  const deadline = AbortSignal.timeout(MAX_CRAWL_MS);
  const signal = AbortSignal.any([input.signal, deadline]);

  const transport = input.transport ?? serverTransport({ signal, delayMs: DEFAULT_DELAY_MS });

  try {
    /*
     * robots.txt FIRST, before a single product request.
     *
     * A missing or unreadable robots.txt means "no rules", which is what the
     * standard says — not "block everything". Treating a 404 as a refusal would
     * make the crawler unable to read the majority of small shops.
     */
    const robotsUrl = new URL("/robots.txt", shopUrl);
    let rules = parseRobots("", CRAWLER_USER_AGENT);

    try {
      const response = await transport.fetchText(robotsUrl.toString());
      if (response.status === 200) {
        rules = parseRobots(response.body, CRAWLER_USER_AGENT);
      } else {
        input.log({
          level: "info",
          message: `No robots.txt (${response.status}), so no rules to follow.`,
        });
      }
    } catch (error) {
      warnings.push(
        `Could not read robots.txt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!rules.isAllowed("/products.json")) {
      throw new CrawlError(
        `${shopUrl.host} asks crawlers not to read its product list in robots.txt, so this run was ` +
          "refused. There is no way to override that here.",
      );
    }

    /*
     * One transport for the whole crawl, and its floor is raised rather than a
     * second one being built.
     *
     * robots.txt is itself a request to this host, so a fresh transport for the
     * products would start a fresh per-host clock and let the first product
     * request follow robots.txt instantly — the one gap the delay is least
     * entitled to skip, since it is the gap the site just told us about.
     */
    if (rules.crawlDelayMs !== null && "raiseDelayTo" in transport) {
      const cappedDelayMs = Math.min(MAX_CRAWL_DELAY_MS, rules.crawlDelayMs);

      if (rules.crawlDelayMs > MAX_CRAWL_DELAY_MS) {
        input.log({
          level: "warn",
          message:
            `${shopUrl.host} asked for a ${rules.crawlDelayMs}ms Crawl-delay; capped at ` +
            `${MAX_CRAWL_DELAY_MS}ms so it cannot hold one of this worker's four job slots ` +
            "against every other account's imports.",
          detail: { requestedMs: rules.crawlDelayMs, cappedMs: cappedDelayMs },
        });
      }

      (transport as ServerTransport).raiseDelayTo(cappedDelayMs);
    }

    const adapter = pickAdapter(input.platform);

    input.log({
      level: "info",
      message: `Reading ${shopUrl.host} as ${adapter.name}.`,
      detail: { platform: adapter.name, crawlDelayMs: rules.crawlDelayMs },
    });

    const products: Product[] = [];

    for await (const product of adapter.fetchProducts({
      shopUrl,
      transport,
      limit: input.limit,
      imagesPerProduct: input.imagesPerProduct,
      minorUnit: input.minorUnit,
      fxRate: input.fxRate,
      log: input.log,
      signal,
    })) {
      products.push(product);
    }

    return { platform: adapter.name, products, warnings };
  } catch (error) {
    /*
     * The cap firing is not the operator pressing Stop, and must not read like
     * it: `input.signal` — the caller's own signal — is what a Stop aborts, so
     * if THAT is still unaborted, whatever threw did so because of `deadline`
     * alone. Reported as its own sentence rather than whatever generic "the run
     * was stopped" message the transport happened to throw.
     */
    if (deadline.aborted && !input.signal.aborted) {
      throw new CrawlError(
        `This crawl ran for more than ${Math.round(MAX_CRAWL_MS / 60_000)} minutes and was stopped ` +
          "automatically, so it could not go on holding up every other account's imports. Try again " +
          "with a smaller limit.",
      );
    }

    throw error;
  }
}

function pickAdapter(platform: PlatformName | "auto"): CrawlAdapter {
  if (platform === "auto") {
    /*
     * Detection needs the homepage, and with one adapter in the list it could
     * only ever answer "shopify". Rather than dress that up as a decision, this
     * build asks. Plan 2 replaces this with a real scored detect().
     */
    throw new CrawlError(
      "Automatic platform detection arrives with the other adapters. Choose Shopify for now.",
    );
  }

  const adapter = ADAPTERS.find((candidate) => candidate.name === platform);

  if (adapter === undefined) {
    throw new CrawlError(
      `This build can only read Shopify stores. ${platform} support is not in it yet.`,
    );
  }

  return adapter;
}

export { CrawlError } from "./types";
export type { CrawlLogLine, PlatformName } from "./types";

// Read by the tests, so the delay-cap assertion checks the real ceiling rather
// than a number copied into tests/crawl.ts by hand.
export { MAX_CRAWL_DELAY_MS };
