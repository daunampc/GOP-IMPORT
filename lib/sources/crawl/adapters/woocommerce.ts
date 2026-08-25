/*
 * WooCommerce, through the Store API.
 *
 * `/wp-json/wc/store/v1/products` is public and needs no authentication, which
 * is the whole reason this adapter uses it rather than the credentialed v3 REST
 * API: reading a shop should not require the shop owner to hand over a key that
 * this app would then have to store, encrypt and be trusted with.
 *
 * Do NOT import "server-only": the test suite reads this under plain tsx.
 */

import type { Product, ProductVariation } from "../../../gop-client";
import { convert, fromMinorUnits, lessThan } from "../money";
import {
  CrawlError,
  type CrawlAdapter,
  type CrawlContext,
  type CrawlLogLine,
  type DetectInput,
} from "../types";

/** The Store API's own maximum. Asking for more silently returns 100. */
const PAGE_SIZE = 100;

/** A runaway guard: 100 x 200 is 20,000 products, past any real limit. */
const MAX_PAGES = 200;

/**
 * How many variation records one product may cost.
 *
 * Each is its own request, so a product with two hundred variations would spend
 * a minute of the crawl's politeness budget on one row. Past this the product is
 * still published, with the variations it did read.
 */
const MAX_VARIATIONS = 50;

export interface WooPrices {
  price: string;
  regular_price: string;
  sale_price: string;
  currency_code: string;
  currency_minor_unit: number;
}

export interface WooProduct {
  id: number;
  name: string;
  slug: string;
  type: string;
  sku: string | null;
  description: string;
  short_description: string;
  prices: WooPrices;
  is_in_stock: boolean;
  images: Array<{ id: number; src: string }>;
  categories: Array<{ name: string }>;
  tags: Array<{ name: string }>;
  attributes: Array<{
    name: string;
    taxonomy?: string | null;
    has_variations?: boolean;
    terms: Array<{ name: string }>;
  }>;
  variations: Array<{ id: number; attributes: Array<{ name: string; value: string }> }>;
}

/**
 * One variation record, fetched from `/wp-json/wc/store/v1/products/{id}`.
 *
 * A different wire shape from `WooProduct`, not the same one reused: a parent
 * listing's `attributes` carries `terms` (every value the attribute can take
 * across the whole product), while a variation's `attributes` carries the single
 * `{name, value}` pair this variation actually is. They used to share
 * `WooProduct`'s interface, coerced at the one place they were told apart with a
 * double cast — which hid the fact that they are not interchangeable from the
 * compiler exactly where that distinction mattered.
 */
export interface WooVariation {
  id: number;
  sku: string | null;
  prices: WooPrices;
  is_in_stock: boolean;
  images: Array<{ id: number; src: string }>;
  attributes: Array<{ name: string; value: string }>;
}

export interface WooMapOptions {
  imagesPerProduct: number;
  fxRate: number | null;
}

/**
 * A price from the Store API, which states its own exponent.
 *
 * `currency_minor_unit` is read from the PRODUCT, not from the crawl's configured
 * currency: a shop quoting VND says `0` here, and dividing that by a hundred
 * would report a 25,400 đ product as 254 đ.
 */
function price(minor: string, prices: WooPrices, options: WooMapOptions): string {
  const decimal = fromMinorUnits(minor, prices.currency_minor_unit);

  return options.fxRate === null
    ? decimal
    : convert(decimal, options.fxRate, prices.currency_minor_unit);
}

/**
 * Woo states `regular_price` and `sale_price` separately and honestly, unlike
 * Shopify's `compare_at_price` inversion — so they map straight across. The one
 * rule is that a sale equal to the regular price is not a sale.
 */
function priceFields(
  prices: WooPrices,
  options: WooMapOptions,
): { regular_price: string; sale_price?: string } {
  const regular = price(prices.regular_price, prices, options);
  const sale = price(prices.sale_price, prices, options);

  return lessThan(sale, regular, prices.currency_minor_unit)
    ? { regular_price: regular, sale_price: sale }
    : { regular_price: regular };
}

function imagesOf(raw: WooProduct, options: WooMapOptions): string[] {
  return raw.images.map((image) => image.src).slice(0, options.imagesPerProduct);
}

function variationOf(raw: WooVariation, options: WooMapOptions): ProductVariation {
  return {
    sku: raw.sku ?? undefined,
    ...priceFields(raw.prices, options),
    instock: raw.is_in_stock,
    attributes: raw.attributes.map((attribute) => ({
      name: attribute.name,
      value: attribute.value,
    })),
    image: raw.images[0]?.src,
  };
}

/**
 * Every variation that can actually be priced, in the same order they were
 * given.
 *
 * `readVariations` already skips a variation gracefully when its request fails
 * or its JSON is malformed — this is the same treatment for the failure that
 * surfaces later: `variationOf` → `priceFields` → `fromMinorUnits` can throw
 * `CrawlMoneyError` for a variation whose price this crawler cannot represent.
 * Without this, one unrepresentable variation price would escape from inside
 * `variations.map(...)` and take the whole product down with it, dropping every
 * OTHER variation that read just fine.
 */
function readableVariations(
  variations: WooVariation[],
  parentName: string,
  options: WooMapOptions,
  log?: (line: CrawlLogLine) => void,
): ProductVariation[] {
  const out: ProductVariation[] = [];

  for (const variation of variations) {
    try {
      out.push(variationOf(variation, options));
    } catch (error) {
      log?.({
        level: "warn",
        message:
          `Variation ${variation.id} of "${parentName}" has a price this crawler cannot ` +
          `represent, and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        detail: { wooId: variation.id },
      });
    }
  }

  return out;
}

export function toProduct(
  raw: WooProduct,
  variations: WooVariation[],
  options: WooMapOptions,
  log?: (line: CrawlLogLine) => void,
): Product {
  const base: Product = {
    name: raw.name,
    slug: raw.slug,
    description: raw.description === "" ? undefined : raw.description,
    short_description: raw.short_description === "" ? undefined : raw.short_description,
    categories: raw.categories.map((category) => category.name),
    tags: raw.tags.map((tag) => tag.name),
    images: imagesOf(raw, options),
    mode_import: "full_data",
  };

  const readable = raw.type === "variable" ? readableVariations(variations, raw.name, options, log) : [];

  // A variable product whose variations could not be read is published as a
  // simple one at the parent's price, rather than as a variable product with no
  // variations — which WooCommerce shows as unbuyable. That includes a product
  // left with none of its variations readable, exactly as if none had ever
  // been fetched.
  if (raw.type !== "variable" || readable.length === 0) {
    return {
      ...base,
      type: "simple",
      sku: raw.sku ?? undefined,
      ...priceFields(raw.prices, options),
      instock: raw.is_in_stock,
      attributes: [],
      variations: [],
    };
  }

  return {
    ...base,
    type: "variable",
    attributes: raw.attributes
      .filter((attribute) => attribute.has_variations !== false)
      .map((attribute) => ({
        name: attribute.name,
        values: attribute.terms.map((term) => term.name),
        visible: true,
        used_for_variation: true,
      })),
    variations: readable,
  };
}

export const wooAdapter: CrawlAdapter = {
  name: "woocommerce",
  robotsPaths: ["/wp-json/wc/store/v1/products"],

  detect(input: DetectInput): number {
    let score = 0;

    if (/wp-content|wp-includes/i.test(input.html)) {
      score += 0.4;
    }

    /*
     * Structural, not a prose mention. A bare case-insensitive `/woocommerce/`
     * anywhere in the html used to be worth 0.5 on its own — enough by itself
     * to cross DETECT_THRESHOLD — so a page that merely TALKS about WooCommerce
     * (a platform-comparison article, a migration blog post) classified as a
     * WooCommerce shop. A request into the plugin's own asset directory only
     * appears when the page is actually running WooCommerce's front-end code,
     * the same kind of shape Magento's detector already requires.
     */
    if (/wp-content\/plugins\/woocommerce\//i.test(input.html)) {
      score += 0.5;
    }
    if (/<meta name="generator" content="WooCommerce/i.test(input.html)) {
      score += 0.5;
    }

    return Math.min(1, score);
  },

  async *fetchProducts(ctx: CrawlContext) {
    let sent = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (ctx.signal.aborted) {
        return;
      }

      const url = new URL("/wp-json/wc/store/v1/products", ctx.shopUrl);
      url.searchParams.set("per_page", String(PAGE_SIZE));
      url.searchParams.set("page", String(page));

      const response = await ctx.transport.fetchText(url.toString());

      if (response.status === 404) {
        throw new CrawlError(
          "This WooCommerce store has the Store API turned off, so there is no public product " +
            "list to read.",
        );
      }

      if (response.status !== 200) {
        throw new CrawlError(`The Store API answered ${response.status}.`);
      }

      let parsed: WooProduct[];
      try {
        parsed = JSON.parse(response.body) as WooProduct[];
      } catch {
        throw new CrawlError("The Store API's answer was not valid JSON.");
      }

      if (!Array.isArray(parsed) || parsed.length === 0) {
        return;
      }

      for (const raw of parsed) {
        if (sent >= ctx.limit) {
          return;
        }

        try {
          const variations =
            raw.type === "variable" ? await readVariations(raw, ctx) : ([] as WooVariation[]);

          yield toProduct(
            raw,
            variations,
            {
              imagesPerProduct: ctx.imagesPerProduct,
              fxRate: ctx.fxRate,
            },
            ctx.log,
          );
          sent++;
        } catch (error) {
          ctx.log({
            level: "warn",
            message: `Skipped "${raw.name}": ${error instanceof Error ? error.message : String(error)}`,
            detail: { wooId: raw.id, slug: raw.slug },
          });
        }
      }
    }

    ctx.log({
      level: "warn",
      message: `Stopped after ${MAX_PAGES} pages. If the shop really is this large, raise MAX_PAGES.`,
    });
  },
};

/**
 * One request per variation, because the Store API's product record carries only
 * the variation's id and its option values — never its price.
 *
 * A variation that cannot be read is dropped with a warning rather than
 * published at the parent's price, which would be a made-up number.
 */
async function readVariations(raw: WooProduct, ctx: CrawlContext): Promise<WooVariation[]> {
  const wanted = raw.variations.slice(0, MAX_VARIATIONS);

  if (raw.variations.length > MAX_VARIATIONS) {
    ctx.log({
      level: "warn",
      message: `"${raw.name}" has ${raw.variations.length} variations; reading the first ${MAX_VARIATIONS}.`,
      detail: { wooId: raw.id, total: raw.variations.length },
    });
  }

  const out: WooVariation[] = [];

  for (const entry of wanted) {
    if (ctx.signal.aborted) {
      break;
    }

    const url = new URL(`/wp-json/wc/store/v1/products/${entry.id}`, ctx.shopUrl);
    const response = await ctx.transport.fetchText(url.toString());

    if (response.status !== 200) {
      ctx.log({
        level: "warn",
        message: `Variation ${entry.id} of "${raw.name}" answered ${response.status} and was skipped.`,
      });
      continue;
    }

    try {
      out.push(JSON.parse(response.body) as WooVariation);
    } catch {
      ctx.log({
        level: "warn",
        message: `Variation ${entry.id} of "${raw.name}" was not valid JSON and was skipped.`,
      });
    }
  }

  return out;
}
