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
  const transport =
    input.transport ?? serverTransport({ signal: input.signal, delayMs: DEFAULT_DELAY_MS });

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
    (transport as ServerTransport).raiseDelayTo(rules.crawlDelayMs);
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
    signal: input.signal,
  })) {
    products.push(product);
  }

  return { platform: adapter.name, products, warnings };
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
