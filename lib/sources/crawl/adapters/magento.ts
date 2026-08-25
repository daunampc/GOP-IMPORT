/*
 * Magento 2, through the storefront GraphQL endpoint.
 *
 * `/graphql` is public on a stock Magento install; the REST catalogue at
 * `/rest/V1/products` needs an integration token, which is the same credential
 * problem the WooCommerce adapter avoids by using the Store API.
 *
 * The query goes over GET rather than POST, because `CrawlTransport` exposes one
 * verb on purpose — it is the seam the customer's own browser will later stand
 * in for, and a relay that can be asked to POST arbitrary bodies is a much
 * larger thing to hand somebody. Magento answers queries over GET.
 *
 * Do NOT import "server-only": the test suite reads this under plain tsx.
 */

import type { Product } from "../../../gop-client";
import { convert, fromDecimal, fromMinorUnits, lessThan, minorUnitFor } from "../money";
import { CrawlError, type CrawlAdapter, type CrawlContext, type DetectInput } from "../types";

const PAGE_SIZE = 50;
const MAX_PAGES = 200;

/**
 * Kept on one line deliberately: it travels in a query string, and a pretty
 * printed version would spend the URL length budget on whitespace.
 *
 * `filter: {sku: {like: "%"}}` is Magento's idiom for "everything" — the
 * `products` field refuses a query with neither a filter nor a search term.
 */
export const PRODUCTS_QUERY =
  '{products(filter:{sku:{like:"%"}},pageSize:%PAGE_SIZE%,currentPage:%PAGE%)' +
  "{total_count page_info{current_page total_pages} items{__typename sku name url_key stock_status " +
  "description{html} short_description{html} image{url} media_gallery{url} categories{name} " +
  "price_range{minimum_price{regular_price{value currency} final_price{value currency}}}}}}";

export interface MagentoMoney {
  value: number | null;
  currency: string | null;
}

export interface MagentoItem {
  __typename: string;
  sku: string;
  name: string;
  url_key: string | null;
  stock_status: string | null;
  description: { html: string } | null;
  short_description: { html: string } | null;
  image: { url: string } | null;
  media_gallery: Array<{ url: string }>;
  categories: Array<{ name: string }> | null;
  price_range: {
    minimum_price: { regular_price: MagentoMoney; final_price: MagentoMoney };
  };
}

export interface MagentoMapOptions {
  imagesPerProduct: number;
  fxRate: number | null;
}

/**
 * Magento sends money as a JSON number, so it arrives already parsed as a float.
 *
 * It is turned straight back into a string and handed to `money.ts` rather than
 * being multiplied here: `24.1 * 100` is 2409.9999999999995, and every price in
 * this crawler is a decimal string precisely so that never happens. A value
 * carrying more decimals than its currency allows is refused there, which skips
 * one product rather than publishing a rounded price.
 *
 * `minorUnit` is resolved once by the caller from `regular_price.currency` and
 * passed in here, rather than being read off `money.currency` again — both
 * prices come from the same `price_range.minimum_price`, so there is exactly
 * one currency to resolve, not two.
 */
function price(money: MagentoMoney, minorUnit: number, options: MagentoMapOptions): string {
  if (money.value === null || !Number.isFinite(money.value)) {
    throw new CrawlError(`Magento sent a price this crawler cannot read: ${String(money.value)}.`);
  }

  const decimal = fromMinorUnits(fromDecimal(String(money.value), minorUnit), minorUnit);

  return options.fxRate === null ? decimal : convert(decimal, options.fxRate, minorUnit);
}

export function toProduct(raw: MagentoItem, options: MagentoMapOptions): Product {
  const gallery = raw.media_gallery.map((entry) => entry.url);
  const first = raw.image?.url;

  // `image` repeats the first gallery entry on most stores; a Set keeps order
  // and drops the repeat without a second pass.
  const images = [...new Set([...(first === undefined ? [] : [first]), ...gallery])].slice(
    0,
    options.imagesPerProduct,
  );

  // Magento names the currency on every price, but both prices here come from
  // the same `price_range.minimum_price` — so the exponent is resolved once,
  // from `regular_price`, and reused for `final_price` rather than trusting
  // two potentially different sources for what should be one currency.
  const minorUnit = minorUnitFor(raw.price_range.minimum_price.regular_price.currency);
  const regular = price(raw.price_range.minimum_price.regular_price, minorUnit, options);
  const final = price(raw.price_range.minimum_price.final_price, minorUnit, options);

  const description = raw.description?.html ?? "";
  const shortDescription = raw.short_description?.html ?? "";

  return {
    name: raw.name,
    slug: raw.url_key ?? undefined,
    sku: raw.sku,
    description: description === "" ? undefined : description,
    short_description: shortDescription === "" ? undefined : shortDescription,
    type: "simple",
    ...(lessThan(final, regular, minorUnit)
      ? { regular_price: regular, sale_price: final }
      : { regular_price: regular }),
    instock: raw.stock_status !== "OUT_OF_STOCK",
    categories: (raw.categories ?? []).map((category) => category.name),
    tags: [],
    images,
    attributes: [],
    variations: [],
    mode_import: "full_data",
  };
}

export const magentoAdapter: CrawlAdapter = {
  name: "magento",
  robotsPaths: ["/graphql"],

  detect(input: DetectInput): number {
    let score = 0;

    if (input.headers["x-magento-cache-debug"] !== undefined) {
      return 1;
    }
    if (/\/static\/version\d+\//i.test(input.html)) {
      score += 0.6;
    }
    if (/mage\/|Magento_/i.test(input.html)) {
      score += 0.4;
    }

    return Math.min(1, score);
  },

  async *fetchProducts(ctx: CrawlContext) {
    let sent = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      if (ctx.signal.aborted) {
        return;
      }

      const url = new URL("/graphql", ctx.shopUrl);
      url.searchParams.set(
        "query",
        PRODUCTS_QUERY.replace("%PAGE_SIZE%", String(PAGE_SIZE)).replace("%PAGE%", String(page)),
      );

      const response = await ctx.transport.fetchText(url.toString());

      if (response.status !== 200) {
        throw new CrawlError(
          `This Magento store's /graphql answered ${response.status}. Some installs only accept ` +
            "POST, which this build cannot send.",
        );
      }

      let parsed: {
        data?: { products?: { items?: MagentoItem[] } };
        errors?: Array<{ message: string }>;
      };
      try {
        parsed = JSON.parse(response.body) as typeof parsed;
      } catch {
        throw new CrawlError("Magento's answer was not valid JSON.");
      }

      if (parsed.errors !== undefined && parsed.errors.length > 0) {
        throw new CrawlError(`Magento refused the query: ${parsed.errors[0].message}`);
      }

      const items = parsed.data?.products?.items ?? [];
      if (items.length === 0) {
        return;
      }

      for (const raw of items) {
        if (sent >= ctx.limit) {
          return;
        }

        try {
          yield toProduct(raw, {
            imagesPerProduct: ctx.imagesPerProduct,
            fxRate: ctx.fxRate,
          });
          sent++;
        } catch (error) {
          ctx.log({
            level: "warn",
            message: `Skipped "${raw.name}": ${error instanceof Error ? error.message : String(error)}`,
            detail: { sku: raw.sku },
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
