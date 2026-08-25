/*
 * Any shop, read the way a search engine reads one.
 *
 * Product urls come from `sitemap.xml`; each page is then read for a JSON-LD
 * `Product`, and failing that for Open Graph product tags. Nothing here knows
 * what platform it is talking to, which is the point — it is the answer for the
 * shops the other three adapters do not recognise.
 *
 * A page with no price yields NOTHING rather than a product with a blank price:
 * a catalogue of names with no prices is worse than a short catalogue, because
 * it looks like it worked.
 *
 * Do NOT import "server-only": the test suite reads this under plain tsx.
 */

import type { Product } from "../../../gop-client";
import { jsonLdBlocks, metaContent, sitemapUrls } from "../html";
import { convert, fromDecimal, fromMinorUnits, minorUnitFor } from "../money";
import { CrawlError, type CrawlAdapter, type CrawlContext, type DetectInput } from "../types";

const MAX_SITEMAPS = 25;
const MAX_URLS = 5_000;

export interface GenericMapOptions {
  imagesPerProduct: number;
  fxRate: number | null;
}

function priceOf(raw: unknown, currency: string | null | undefined, options: GenericMapOptions): string {
  const minorUnit = minorUnitFor(currency);
  const decimal = fromMinorUnits(fromDecimal(String(raw), minorUnit), minorUnit);

  return options.fxRate === null ? decimal : convert(decimal, options.fxRate, minorUnit);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

/** Walk a JSON-LD payload, which may be a node, an array, or an `@graph`. */
function findProduct(node: unknown): Record<string, unknown> | null {
  for (const candidate of asArray(node)) {
    if (candidate === null || typeof candidate !== "object") {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const types = asArray(record["@type"]).map((type) => String(type).toLowerCase());

    if (types.includes("product")) {
      return record;
    }

    if (record["@graph"] !== undefined) {
      const nested = findProduct(record["@graph"]);
      if (nested !== null) {
        return nested;
      }
    }
  }

  return null;
}

export function productFromJsonLd(node: unknown, options: GenericMapOptions): Product | null {
  const record = findProduct(node);
  if (record === null) {
    return null;
  }

  const offer = asArray(record.offers)[0] as Record<string, unknown> | undefined;
  if (offer === undefined || offer.price === undefined) {
    return null;
  }

  const currency = typeof offer.priceCurrency === "string" ? offer.priceCurrency : null;
  const availability = String(offer.availability ?? "").toLowerCase();

  const brand =
    typeof record.brand === "object" && record.brand !== null
      ? String((record.brand as Record<string, unknown>).name ?? "")
      : typeof record.brand === "string"
        ? record.brand
        : "";

  const images = asArray(record.image)
    .map((image) =>
      typeof image === "string"
        ? image
        : String((image as Record<string, unknown>)?.url ?? ""),
    )
    .filter((image) => image !== "")
    .slice(0, options.imagesPerProduct);

  const product: Product = {
    name: String(record.name ?? "").trim(),
    sku: typeof record.sku === "string" ? record.sku : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
    type: "simple",
    regular_price: priceOf(offer.price, currency, options),
    instock: availability === "" ? true : !availability.includes("outofstock"),
    categories: [],
    tags: [],
    images,
    attributes: [],
    variations: [],
    mode_import: "full_data",
  };

  if (product.name === "") {
    return null;
  }

  if (brand !== "") {
    product.custom_meta = { brand };
  }

  return product;
}

export function productFromMeta(
  html: string,
  url: string,
  options: GenericMapOptions,
): Product | null {
  const name = metaContent(html, "og:title");
  const amount = metaContent(html, "product:price:amount");

  if (name === null || amount === null) {
    return null;
  }

  const image = metaContent(html, "og:image");
  const currency = metaContent(html, "product:price:currency");

  return {
    name,
    slug: new URL(url).pathname.split("/").filter(Boolean).pop(),
    type: "simple",
    regular_price: priceOf(amount, currency, options),
    description: metaContent(html, "og:description") ?? undefined,
    instock: true,
    categories: [],
    tags: [],
    images: image === null ? [] : [image].slice(0, options.imagesPerProduct),
    attributes: [],
    variations: [],
    mode_import: "full_data",
  };
}

export const genericAdapter: CrawlAdapter = {
  name: "generic",
  robotsPaths: ["/sitemap.xml"],

  // Always last, and never chosen by score: it is the fallback the orchestrator
  // reaches for when nothing else recognised the site.
  detect(_input: DetectInput): number {
    return 0;
  },

  async *fetchProducts(ctx: CrawlContext) {
    const urls = await discover(ctx);

    if (urls.length === 0) {
      throw new CrawlError(
        `No product pages were found in ${ctx.shopUrl.host}'s sitemap. This crawler needs a ` +
          "sitemap.xml to find its way around a shop it does not recognise.",
      );
    }

    let sent = 0;

    for (const url of urls) {
      if (ctx.signal.aborted || sent >= ctx.limit) {
        return;
      }

      const path = new URL(url).pathname;
      if (!ctx.isAllowed(path)) {
        ctx.log({ level: "warn", message: `robots.txt disallows ${path}; skipped.` });
        continue;
      }

      const response = await ctx.transport.fetchText(url);
      if (response.status !== 200 || !response.contentType.includes("html")) {
        continue;
      }

      const options = { imagesPerProduct: ctx.imagesPerProduct, fxRate: ctx.fxRate };

      let product: Product | null = null;
      try {
        for (const block of jsonLdBlocks(response.body)) {
          product = productFromJsonLd(block, options);
          if (product !== null) {
            break;
          }
        }

        product ??= productFromMeta(response.body, url, options);
      } catch (error) {
        ctx.log({
          level: "warn",
          message: `Skipped ${path}: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (product === null) {
        continue;
      }

      yield product;
      sent++;
    }
  },
};

/** Sitemap, then any sitemaps it indexes. Exported so the test suite can drive it directly. */
export async function discover(ctx: CrawlContext): Promise<string[]> {
  const root = new URL("/sitemap.xml", ctx.shopUrl);
  const response = await ctx.transport.fetchText(root.toString());

  if (response.status !== 200) {
    return [];
  }

  const first = sitemapUrls(response.body);
  const looksLikeIndex = /<sitemapindex/i.test(response.body);

  if (!looksLikeIndex) {
    return first.slice(0, MAX_URLS);
  }

  const out: string[] = [];

  for (const child of first.slice(0, MAX_SITEMAPS)) {
    if (ctx.signal.aborted || out.length >= MAX_URLS) {
      break;
    }

    // A child sitemap is a discovered url exactly like a product page, and
    // `ctx.isAllowed` exists for exactly this case — only the top-level
    // `/sitemap.xml` is checked against `robotsPaths` before this adapter
    // starts, so a site that disallows one of its own child sitemaps (say
    // `/sitemap_drafts.xml`) would otherwise never have that rule consulted.
    const childPath = new URL(child).pathname;
    if (!ctx.isAllowed(childPath)) {
      ctx.log({ level: "warn", message: `robots.txt disallows ${childPath}; skipped.` });
      continue;
    }

    const childResponse = await ctx.transport.fetchText(child);
    if (childResponse.status === 200) {
      out.push(...sitemapUrls(childResponse.body));
    }
  }

  return out.slice(0, MAX_URLS);
}
