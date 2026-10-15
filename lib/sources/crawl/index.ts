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
import { wooAdapter } from "./adapters/woocommerce";
import { magentoAdapter } from "./adapters/magento";
import { genericAdapter } from "./adapters/generic";
import { CRAWLER_USER_AGENT, parseRobots } from "./robots";
import { serverTransport, type ServerTransport } from "./transport";
import {
  CrawlError,
  type CrawlAdapter,
  type CrawlLogLine,
  type CrawlTransport,
  type DetectInput,
  type PlatformName,
} from "./types";

/**
 * Every adapter this build can read. `etsy` is in `PlatformName` but not here:
 * it needs the browser crawler, which is plan 3.
 */
const ADAPTERS: ReadonlyArray<CrawlAdapter> = [
  shopifyAdapter,
  wooAdapter,
  magentoAdapter,
  genericAdapter,
];

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

    /*
     * One transport for the whole crawl, and its floor is raised rather than a
     * second one being built.
     *
     * robots.txt is itself a request to this host, so a fresh transport for the
     * products would start a fresh per-host clock and let the first product
     * request follow robots.txt instantly — the one gap the delay is least
     * entitled to skip, since it is the gap the site just told us about.
     *
     * Raised HERE, before an adapter is even chosen — not after. Detection
     * fetches `/` for a `platform: "auto"` run, and that fetch is itself a
     * request to this host, made right after robots.txt. Raising the floor
     * after adapter selection would let that request go out at the default
     * floor instead of the site's declared `Crawl-delay`, reopening on the
     * detection fetch the exact gap this raise exists to close on the first
     * product request.
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

    // Detection fetches `/`, so it faces the same robots.txt check as every
    // other request this crawler makes — a site that disallows its own home
    // page cannot be auto-detected, and the operator is told to choose by hand.
    if (input.platform === "auto" && !rules.isAllowed("/")) {
      throw new CrawlError(
        `${shopUrl.host} disallows its own home page in robots.txt, so this crawler cannot work ` +
          "out what it is. Choose the platform by hand.",
      );
    }

    const adapter =
      input.platform === "auto"
        ? await detectPlatform(shopUrl, transport, input.log)
        : adapterNamed(input.platform);

    for (const path of adapter.robotsPaths) {
      if (!rules.isAllowed(path)) {
        throw new CrawlError(
          `${shopUrl.host} asks crawlers not to fetch \`${path}\` in its robots.txt, and that is ` +
            `where a ${adapter.name} crawl has to start. This run was refused, and there is no way ` +
            "to override that here.",
        );
      }
    }

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
      isAllowed: (pathname: string) => rules.isAllowed(pathname),
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

/** Below this, a score is a coincidence rather than a recognition. */
const DETECT_THRESHOLD = 0.5;

/**
 * Which platform is this?
 *
 * One request for the homepage, scored by every adapter, highest wins. Scored
 * rather than decided by a single signal because every individual signal lies
 * somewhere: a Shopify theme can be served from a custom domain with no
 * `myshopify.com` in sight, and plenty of sites mention `wp-content` while
 * running no shop at all.
 *
 * Nothing recognisable falls back to `generic`, which reads a sitemap and
 * schema.org — that is what it is for, and refusing outright would turn every
 * unfamiliar shop into a dead end.
 */
async function detectPlatform(
  shopUrl: URL,
  transport: CrawlTransport,
  log: (line: CrawlLogLine) => void,
): Promise<CrawlAdapter> {
  const response = await transport.fetchText(shopUrl.toString());

  const input: DetectInput = {
    url: shopUrl,
    headers: response.headers,
    html: response.status === 200 ? response.body : "",
  };

  const scored = ADAPTERS.map((adapter) => ({ adapter, score: adapter.detect(input) })).sort(
    (a, b) => b.score - a.score,
  );

  const best = scored[0];

  log({
    level: "info",
    message:
      best.score >= DETECT_THRESHOLD
        ? `Detected ${best.adapter.name} (score ${best.score.toFixed(2)}).`
        : "Nothing recognised this shop, so it will be read as a generic schema.org site.",
    detail: Object.fromEntries(scored.map((entry) => [entry.adapter.name, entry.score])),
  });

  if (best.score < DETECT_THRESHOLD) {
    const generic = ADAPTERS.find((adapter) => adapter.name === "generic");
    // Unreachable today — `ADAPTERS` above statically includes `genericAdapter`.
    // Kept as a guard against a future edit to `ADAPTERS` that drops it (or
    // renames it) without updating this fallback, which would otherwise fail
    // with a `find` returning `undefined` deep inside `.name` access instead of
    // a message that says what actually went wrong.
    if (generic === undefined) {
      throw new CrawlError("No adapter could read this shop.");
    }
    return generic;
  }

  return best.adapter;
}

function adapterNamed(platform: PlatformName): CrawlAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.name === platform);

  if (adapter === undefined) {
    throw new CrawlError(
      `${platform} support is not in this build yet. Etsy needs the browser crawler.`,
    );
  }

  return adapter;
}

export { CrawlError } from "./types";
export type { CrawlLogLine, PlatformName } from "./types";

// Read by the tests, so the delay-cap assertion checks the real ceiling rather
// than a number copied into tests/crawl.ts by hand.
export { MAX_CRAWL_DELAY_MS };
