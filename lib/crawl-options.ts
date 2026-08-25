import { z } from "zod";

/*
 * What one crawl was asked to do.
 *
 * Beside `lib/import-options.ts` and shaped like it, including the reason every
 * field uses `.default()` rather than `.optional()`: a run's options are stored
 * as JSON and parsed back months later, so a field added today has to have a
 * defined meaning for every row already in Postgres.
 */

export const CRAWL_PLATFORMS = ["shopify", "woocommerce", "magento", "etsy", "generic"] as const;

export const CRAWL_PLATFORM_LABELS: Record<(typeof CRAWL_PLATFORMS)[number], string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  magento: "Magento",
  etsy: "Etsy",
  generic: "Other (schema.org)",
};

/**
 * Where the requests come from.
 *
 * `server` is this machine. `browser` routes them through the customer's own
 * Chrome and is not built yet — it is §12 of the design and plan 3. The value
 * exists now so a run stored today still parses when it arrives.
 */
export const CRAWL_TRANSPORTS = ["server", "browser"] as const;

export const crawlOptionsSchema = z.object({
  shopUrl: z.string().trim().url("That is not a web address."),

  /*
   * No "auto" yet. With one adapter, a detector could only answer "shopify", and
   * an automatic answer that is really a constant is worse than a question.
   */
  platform: z.enum(CRAWL_PLATFORMS).default("shopify"),

  transport: z.enum(CRAWL_TRANSPORTS).default("server"),

  limit: z.coerce.number().int().min(1).max(10_000).default(500),
  imagesPerProduct: z.coerce.number().int().min(0).max(50).default(10),

  /**
   * The currency the SHOP quotes, which decides how many decimals a price has.
   * Getting this wrong by one is a price wrong by a factor of ten.
   */
  sourceCurrency: z.string().trim().length(3).toUpperCase().default("USD"),

  /**
   * Multiply every price by this. `null` publishes the shop's own numbers.
   *
   * Typed by the operator, never fetched. A rates API would add a network
   * dependency to every crawl, and a stale or failed lookup would print wrong
   * prices into a customer's shop with nothing on screen to say so. Stored on
   * the run so the arithmetic can be re-derived later.
   */
  fxRate: z.coerce.number().positive().nullable().default(null),
  fxTarget: z.string().trim().max(3).toUpperCase().default(""),

  /**
   * Unused by a crawl, and present only because `EnqueueInput.options` is a
   * union and `enqueueJob` reads `options.batchSize` to size its batches. A
   * crawl has no batches; this keeps the union readable without a cast.
   */
  batchSize: z.coerce.number().int().min(1).max(50).default(50),
});

export type CrawlOptions = z.infer<typeof crawlOptionsSchema>;

export const DEFAULT_CRAWL_OPTIONS: Omit<CrawlOptions, "shopUrl"> = {
  platform: "shopify",
  transport: "server",
  limit: 500,
  imagesPerProduct: 10,
  sourceCurrency: "USD",
  fxRate: null,
  fxTarget: "",
  batchSize: 50,
};

export { minorUnitFor } from "./sources/crawl/money";
