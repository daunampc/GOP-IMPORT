/*
 * The crawler's vocabulary.
 *
 * Types and one error class, no I/O — so an adapter can be unit-tested against a
 * saved fixture without a network, a browser or a database. That is the whole
 * reason `CrawlTransport` is an interface rather than a call to `fetch`.
 *
 * Do NOT import "server-only": the worker and the test suite both read this.
 */

import type { Product } from "../../gop-client";

export type PlatformName = "shopify" | "woocommerce" | "magento" | "etsy" | "generic";

export class CrawlError extends Error {}

export interface CrawlResponse {
  status: number;
  contentType: string;
  body: string;
  /** Lower-cased header names, so an adapter can score on `x-shopify-stage`. */
  headers: Record<string, string>;
}

/**
 * How an adapter reaches the outside world.
 *
 * An interface, not `fetch`, for two reasons that both matter later: the tests
 * substitute a fixture, and §12 of the design substitutes the customer's own
 * Chrome. Neither is possible if an adapter calls `fetch` directly.
 */
export interface CrawlTransport {
  fetchText(url: string): Promise<CrawlResponse>;
}

export interface CrawlLogLine {
  level: "info" | "warn" | "error";
  message: string;
  detail?: Record<string, unknown>;
}

export interface CrawlContext {
  shopUrl: URL;
  transport: CrawlTransport;
  /** Hard ceiling on products. Already the smaller of the form's and the account's. */
  limit: number;
  imagesPerProduct: number;
  /** Decimals in the source currency. 2 for USD, 0 for VND and JPY. */
  minorUnit: number;
  /** Operator-entered exchange rate, or null to publish the source numbers. */
  fxRate: number | null;
  log: (line: CrawlLogLine) => void;
  signal: AbortSignal;
  /**
   * May this path be fetched?
   *
   * For adapters that DISCOVER urls — the generic one reads a sitemap — where
   * the paths are not known until the crawl is running and so cannot be declared
   * up front. A disallowed url is skipped with a warning rather than failing the
   * whole run, because a sitemap listing one blocked path is ordinary.
   */
  isAllowed: (pathname: string) => boolean;
}

export interface DetectInput {
  url: URL;
  headers: Record<string, string>;
  html: string;
}

export interface CrawlAdapter {
  name: PlatformName;
  /**
   * The paths this adapter fetches to get started, checked against robots.txt
   * before it is allowed to run.
   *
   * Declared per adapter because they have nothing in common: Shopify's entry is
   * `/products.json`, WooCommerce's is under `/wp-json/`, Magento's is
   * `/graphql`. Checking one adapter's path on behalf of all four asks the site
   * a question about a request that will never be made, and fails to ask about
   * the one that will.
   */
  robotsPaths: ReadonlyArray<string>;
  /** Confidence from 0 to 1. The orchestrator picks the highest. */
  detect(input: DetectInput): number;
  fetchProducts(ctx: CrawlContext): AsyncGenerator<Product>;
}
