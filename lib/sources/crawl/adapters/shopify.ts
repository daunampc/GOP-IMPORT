/*
 * Shopify.
 *
 * The fast path is `/products.json`, which most storefronts leave open. Paging is
 * `?limit=250&page=N` until the array comes back empty — 250 is Shopify's hard
 * maximum, not a suggestion.
 *
 * Do NOT import "server-only": the test suite reads this under plain tsx.
 */

import type { Product, ProductVariation } from "../../../gop-client";
import { convert, fromDecimal, fromMinorUnits, lessThan } from "../money";
import { CrawlError, type CrawlAdapter, type CrawlContext, type DetectInput } from "../types";

/** Shopify's hard maximum per page. Asking for more silently returns 250. */
const PAGE_SIZE = 250;

/** A runaway guard: 250 x 200 is 50,000 products, far past any real limit. */
const MAX_PAGES = 200;

export interface ShopifyImage {
  id: number;
  src: string;
  position: number;
}

export interface ShopifyVariant {
  id: number;
  title: string;
  sku: string | null;
  price: string;
  compare_at_price: string | null;
  available: boolean;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  featured_image: { src: string } | null;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  vendor: string | null;
  product_type: string | null;
  tags: string[];
  options: Array<{ name: string; values: string[] }>;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
}

export interface ShopifyMapOptions {
  imagesPerProduct: number;
  minorUnit: number;
  fxRate: number | null;
}

/**
 * Shopify has no "this product has no options" state, so it invents one: a single
 * option called `Title` whose only value is `Default Title`.
 *
 * Reading that as a real option would publish a variable product with one
 * variation named "Default Title" into the customer's shop — visible on the
 * product page, in the cart and on the invoice. So it is stripped here, once,
 * rather than left for `applyOptions` to flatten by luck.
 */
function hasRealOptions(product: ShopifyProduct): boolean {
  if (product.options.length === 0) {
    return false;
  }

  if (product.options.length === 1 && product.options[0].name === "Title") {
    const values = product.options[0].values;
    return !(values.length === 1 && values[0] === "Default Title");
  }

  return true;
}

/**
 * Shopify's CDN encodes a resize into the FILENAME, before the extension.
 *
 * `mug_400x.jpg` and `mug.jpg` are the same asset at different sizes, so the
 * suffix is stripped to get the original — the largest available. The query
 * string is kept: `?v=` is the cache buster, and dropping it can serve a stale
 * image after the shop replaces one.
 */
export function fullSizeImage(url: string): string {
  const cut = url.indexOf("?");
  const base = cut === -1 ? url : url.slice(0, cut);
  const query = cut === -1 ? "" : url.slice(cut);

  const stripped = base.replace(
    /_(?:\d+x\d*|x\d+|pico|icon|thumb|small|compact|medium|large|grande|master)(?=\.[a-z0-9]+$)/i,
    "",
  );

  return `${stripped}${query}`;
}

/** A price string from Shopify, in the source currency, optionally converted. */
function price(value: string, options: ShopifyMapOptions): string {
  /*
   * `/products.json` sends a DECIMAL string ("18.00"), unlike the AJAX
   * `/products/{handle}.js` endpoint, which sends integer cents. Parsing it as
   * minor units directly would multiply every price by a hundred.
   *
   * Both steps live in money.ts so there is one place that knows how a currency's
   * decimals work — and so a price this crawler cannot read exactly becomes a
   * skipped product with a warning, rather than a wrong number in a shop.
   */
  const decimal = fromMinorUnits(fromDecimal(value, options.minorUnit), options.minorUnit);

  return options.fxRate === null ? decimal : convert(decimal, options.fxRate, options.minorUnit);
}

function variationOf(
  variant: ShopifyVariant,
  product: ShopifyProduct,
  options: ShopifyMapOptions,
): ProductVariation {
  const names = product.options.map((option) => option.name);
  const values = [variant.option1, variant.option2, variant.option3];

  const attributes = names
    .map((name, index) => ({ name, value: values[index] ?? "" }))
    .filter((pair) => pair.value !== "");

  return {
    sku: variant.sku ?? undefined,
    ...prices(variant, options),
    instock: variant.available,
    attributes,
    image: variant.featured_image === null ? undefined : fullSizeImage(variant.featured_image.src),
  };
}

/**
 * `compare_at_price` is the ORIGINAL price, and `price` is what is charged today.
 *
 * So a product on sale maps the other way round from how it reads: Shopify's
 * `price` becomes WooCommerce's `sale_price`, and `compare_at_price` becomes the
 * `regular_price`. Mapping them straight across would publish the sale price as
 * the regular one and silently make every discount permanent.
 */
function prices(
  variant: ShopifyVariant,
  options: ShopifyMapOptions,
): { regular_price: string; sale_price?: string } {
  const charged = price(variant.price, options);

  if (variant.compare_at_price === null || variant.compare_at_price === "") {
    return { regular_price: charged };
  }

  const original = price(variant.compare_at_price, options);

  // A compare-at at or below the charged price is not a sale; some themes leave
  // a stale value there. Publishing it would show a "discount" of zero or less.
  if (!lessThan(charged, original, options.minorUnit)) {
    return { regular_price: charged };
  }

  return { regular_price: original, sale_price: charged };
}

export function toProduct(raw: ShopifyProduct, options: ShopifyMapOptions): Product {
  if (raw.variants.length === 0) {
    throw new CrawlError(`Shopify product ${raw.id} ("${raw.title}") has no variants.`);
  }

  const images = raw.images
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((image) => fullSizeImage(image.src))
    .slice(0, options.imagesPerProduct);

  const base: Product = {
    name: raw.title,
    slug: raw.handle,
    description: raw.body_html ?? undefined,
    categories: raw.product_type === null || raw.product_type === "" ? [] : [raw.product_type],
    tags: raw.tags,
    images,
    mode_import: "full_data",
  };

  if (raw.vendor !== null && raw.vendor !== "") {
    // The plugin has no first-class brand field; meta is where it can survive.
    base.custom_meta = { brand: raw.vendor };
  }

  if (!hasRealOptions(raw)) {
    const only = raw.variants[0];

    return {
      ...base,
      type: "simple",
      sku: only.sku ?? undefined,
      ...prices(only, options),
      instock: only.available,
      variations: [],
      attributes: [],
    };
  }

  return {
    ...base,
    type: "variable",
    attributes: raw.options.map((option) => ({
      name: option.name,
      values: option.values,
      visible: true,
      used_for_variation: true,
    })),
    variations: raw.variants.map((variant) => variationOf(variant, raw, options)),
  };
}

export const shopifyAdapter: CrawlAdapter = {
  name: "shopify",

  robotsPaths: ["/products.json"],

  detect(input: DetectInput): number {
    let score = 0;

    if (/\.myshopify\.com$/i.test(input.url.hostname)) {
      return 1;
    }
    if (/cdn\.shopify\.com/i.test(input.html)) {
      score += 0.6;
    }
    if (input.headers["x-shopify-stage"] !== undefined) {
      score += 0.4;
    }
    if (/Shopify\.theme/.test(input.html)) {
      score += 0.3;
    }

    return Math.min(1, score);
  },

  async *fetchProducts(ctx: CrawlContext) {
    let sent = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (ctx.signal.aborted) {
        return;
      }

      const url = new URL("/products.json", ctx.shopUrl);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("page", String(page));

      const response = await ctx.transport.fetchText(url.toString());

      if (response.status === 404) {
        throw new CrawlError(
          "This Shopify store has /products.json turned off. Reading it another way needs the " +
            "browser crawler, which is not part of this build.",
        );
      }

      if (response.status !== 200) {
        throw new CrawlError(`Shopify answered ${response.status} for ${url.pathname}.`);
      }

      if (!response.contentType.includes("json")) {
        // A password-protected store answers the HTML login page with a 200.
        throw new CrawlError(
          "This Shopify store answered with a web page instead of product data — it is most " +
            "likely password protected.",
        );
      }

      let parsed: { products?: ShopifyProduct[] };
      try {
        parsed = JSON.parse(response.body) as { products?: ShopifyProduct[] };
      } catch {
        throw new CrawlError("Shopify's answer was not valid JSON.");
      }

      const products = parsed.products ?? [];
      if (products.length === 0) {
        return;
      }

      for (const raw of products) {
        if (sent >= ctx.limit) {
          return;
        }

        try {
          yield toProduct(raw, {
            imagesPerProduct: ctx.imagesPerProduct,
            minorUnit: ctx.minorUnit,
            fxRate: ctx.fxRate,
          });
          sent++;
        } catch (error) {
          // One unreadable product must not end a crawl of nine hundred.
          ctx.log({
            level: "warn",
            message: `Skipped "${raw.title}": ${error instanceof Error ? error.message : String(error)}`,
            detail: { shopifyId: raw.id, handle: raw.handle },
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
