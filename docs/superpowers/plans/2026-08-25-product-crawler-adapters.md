# Product Crawler — WooCommerce, Magento and Generic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Tiếng Việt — phạm vi.** Đây là **kế hoạch 2 trong 3**, ứng với bước 6 ở §10 của
> `docs/superpowers/specs/2026-08-24-product-crawler-source-design.md`. Thêm ba adapter
> **WooCommerce, Magento, Generic** và **nhận diện nền tảng tự động**. **KHÔNG** có
> Playwright, **KHÔNG** có Etsy, **KHÔNG** thêm dependency nào — cả ba adapter này chỉ
> cần `fetch`. Etsy bắt buộc phải render bằng trình duyệt nên thành kế hoạch 3 riêng.
> Bản kế hoạch viết bằng tiếng Anh vì gần như toàn code và lệnh shell.

**Goal:** Read WooCommerce, Magento and unknown storefronts into the same `Product[]` the Shopify adapter already produces, and detect which of the four a URL is.

**Architecture:** Three new adapters behind the existing `CrawlAdapter` interface, each with a fetch-only fast path. The orchestrator gains real scored detection and stops hardcoding one adapter's entry path into the robots check — every adapter declares the paths it needs, and adapters that discover URLs check each one.

**Tech Stack:** TypeScript, plain `fetch` through the existing guarded `CrawlTransport`, no new dependency.

## Global Constraints

- **Code, code comments and all UI copy are English.** Only `docs/` is Vietnamese.
- **No new npm dependency.** JSON-LD and meta-tag extraction are hand-rolled, the same way `lib/sources/crawl/robots.ts` and `lib/sources/csv-dialect.ts` are. A DOM library is not needed for what this plan reads.
- **Every outbound fetch goes through `ctx.transport.fetchText()`.** Never call `fetch` directly — the transport is what applies `assertFetchableUrl`, the per-host delay, the backoff, the size ceiling and the deadline.
- **robots.txt disallow is a hard refuse, no override.** An adapter's declared entry paths are checked before it runs; an adapter that discovers URLs checks each discovered URL and skips the disallowed ones with a warning.
- **No anti-detection of any kind**: no stealth, no fingerprint spoofing, no user-agent rotation, no CAPTCHA solving.
- **Prices are decimal strings, never floats**, and all money arithmetic lives in `lib/sources/crawl/money.ts`. Use `fromDecimal` / `fromMinorUnits` / `convert`; never write new arithmetic.
- **Minor units are never hard-coded to 100.** WooCommerce's Store API states its own exponent in `prices.currency_minor_unit` — use that field, not the crawl's configured currency.
- **Every paging loop has a hard page cap**, like `MAX_PAGES = 200` in the Shopify adapter.
- **Reject rather than round.** A price this crawler cannot represent exactly skips one product with a warning; it never publishes an approximation.
- Run `./node_modules/.bin/tsc --noEmit` and `./tests/crawl.sh` before every commit.
- Node is not on the default PATH: `export PATH="$HOME/.local/share/nvm/v22.22.3/bin:$PATH"`.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `lib/sources/crawl/html.ts` | Hand-rolled extraction from an HTML string: JSON-LD blocks, `<meta>` properties, `<link rel>`. No DOM, no dependency. |
| `lib/sources/crawl/adapters/woocommerce.ts` | Store API paging and the Woo → `Product` mapping, including variation records. |
| `lib/sources/crawl/adapters/magento.ts` | Storefront GraphQL query, paging, and the Magento → `Product` mapping. |
| `lib/sources/crawl/adapters/generic.ts` | Sitemap discovery, then JSON-LD → Open Graph per product page. |
| `tests/fixtures/crawl/woo-store-api.json` | One simple product, one variable parent. |
| `tests/fixtures/crawl/woo-variation.json` | One variation record. |
| `tests/fixtures/crawl/magento-graphql.json` | A `products` response with a simple and a configurable product. |
| `tests/fixtures/crawl/jsonld-product.html` | A product page carrying a JSON-LD `Product` inside an `@graph`. |
| `tests/fixtures/crawl/og-product.html` | A product page with no JSON-LD, only Open Graph tags. |
| `tests/fixtures/crawl/sitemap-index.xml` | A sitemap index pointing at one child sitemap. |
| `tests/fixtures/crawl/sitemap-products.xml` | Product URLs, one of them under a disallowed path. |

**Modify:**

| Path | Change |
|---|---|
| `lib/sources/crawl/types.ts` | `CrawlAdapter` gains `robotsPaths`; `CrawlContext` gains `isAllowed`; `CrawlResponse` gains `headers`. |
| `lib/sources/crawl/transport.ts` | Populate `headers` on the response. |
| `lib/sources/crawl/adapters/shopify.ts` | Declare `robotsPaths`. |
| `lib/sources/crawl/index.ts` | Register the three adapters; robots check driven by `robotsPaths`; real `detectPlatform`; pass `isAllowed` into the context. |
| `lib/crawl-options.ts` | Allow `"auto"` as a platform. |
| `app/(app)/crawl/crawl-form.tsx` | Enable the four platforms and add "Detect automatically". |
| `app/api/crawl/route.ts` | Accept `"auto"`. |
| `tests/crawl.ts` | New sections for html, woo, magento, generic and detection. |
| `README.md`, the design spec | Record what shipped. |

---

## Task 1: Adapters declare what robots.txt must allow

Today `lib/sources/crawl/index.ts` hardcodes `rules.isAllowed("/products.json")` — one adapter's entry path, checked for every adapter. With four adapters that is wrong twice over: it checks a path three of them never fetch, and it fails to check the paths they do.

**Files:**
- Modify: `lib/sources/crawl/types.ts`, `lib/sources/crawl/adapters/shopify.ts`, `lib/sources/crawl/index.ts`
- Test: `tests/crawl.ts`

**Interfaces:**
- Consumes: `CrawlAdapter`, `CrawlContext`, `RobotsRules` from existing code.
- Produces: `CrawlAdapter.robotsPaths: ReadonlyArray<string>`; `CrawlContext.isAllowed(pathname: string): boolean`.

- [ ] **Step 1: Write the failing test**

Add to `orchestratorTests()` in `tests/crawl.ts`, after the existing disallow test:

```ts
  /*
   * The robots check must follow the ADAPTER, not one hardcoded path. A site
   * that blocks Shopify's entry path but not WooCommerce's has said nothing
   * about a WooCommerce crawl, and vice versa.
   */
  const wooBlocked = fakeTransport("User-agent: *\nDisallow: /wp-json/");
  await refusesAsync(
    "a disallowed woocommerce entry path refuses",
    () =>
      crawlShop({
        shopUrl: "https://example.myshopify.com",
        platform: "woocommerce",
        limit: 10,
        imagesPerProduct: 5,
        minorUnit: 2,
        fxRate: null,
        signal: new AbortController().signal,
        log: () => {},
        transport: wooBlocked.transport,
      }),
    /robots\.txt/i,
  );

  // ...and the same file says nothing about Shopify's entry path.
  const shopifyOk = fakeTransport("User-agent: *\nDisallow: /wp-json/");
  const stillFine = await crawlShop({
    shopUrl: "https://example.myshopify.com",
    platform: "shopify",
    limit: 10,
    imagesPerProduct: 5,
    minorUnit: 2,
    fxRate: null,
    signal: new AbortController().signal,
    log: () => {},
    transport: shopifyOk.transport,
  });
  check(
    "a rule about another platform does not block shopify",
    stillFine.products.length === 2,
    String(stillFine.products.length),
  );
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.local/share/nvm/v22.22.3/bin:$PATH" && ./tests/crawl.sh`
Expected: FAIL — the woocommerce case is refused for "This build can only read Shopify stores" rather than for robots.txt, because no `woocommerce` adapter is registered yet. That is the expected RED for this step; Task 2 registers it.

To keep this task self-contained, temporarily assert against the shopify half only if the woocommerce half cannot yet run — but do **not** delete the woocommerce assertion; leave it and let it go green in Task 2. Note this in your report.

- [ ] **Step 3: Add the declarations**

In `lib/sources/crawl/types.ts`, add to `CrawlAdapter` above `detect`:

```ts
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
```

and add to `CrawlContext`:

```ts
  /**
   * May this path be fetched?
   *
   * For adapters that DISCOVER urls — the generic one reads a sitemap — where
   * the paths are not known until the crawl is running and so cannot be declared
   * up front. A disallowed url is skipped with a warning rather than failing the
   * whole run, because a sitemap listing one blocked path is ordinary.
   */
  isAllowed: (pathname: string) => boolean;
```

In `lib/sources/crawl/adapters/shopify.ts`, add to the `shopifyAdapter` object, right after `name`:

```ts
  robotsPaths: ["/products.json"],
```

- [ ] **Step 4: Drive the orchestrator from the declaration**

In `lib/sources/crawl/index.ts`, move the adapter selection **above** the robots check (it currently happens after), then replace the hardcoded check:

```ts
    const adapter = pickAdapter(input.platform);

    for (const path of adapter.robotsPaths) {
      if (!rules.isAllowed(path)) {
        throw new CrawlError(
          `${shopUrl.host} asks crawlers not to fetch \`${path}\` in its robots.txt, and that is ` +
            `where a ${adapter.name} crawl has to start. This run was refused, and there is no way ` +
            "to override that here.",
        );
      }
    }
```

and add `isAllowed` to the context passed to `adapter.fetchProducts`:

```ts
    isAllowed: (pathname: string) => rules.isAllowed(pathname),
```

- [ ] **Step 5: Run tests**

Run: `./tests/crawl.sh`
Expected: the shopify half passes and reports `0 failed` for everything that can run in this task.

- [ ] **Step 6: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add lib/sources/crawl/types.ts lib/sources/crawl/adapters/shopify.ts lib/sources/crawl/index.ts tests/crawl.ts
git commit -m "refactor(crawl): let each adapter say what robots.txt must allow

One hardcoded entry path asked the site about a request three of the four
adapters never make, and failed to ask about the ones they do."
```

---

## Task 2: The WooCommerce adapter

**Files:**
- Create: `lib/sources/crawl/adapters/woocommerce.ts`, `tests/fixtures/crawl/woo-store-api.json`, `tests/fixtures/crawl/woo-variation.json`
- Modify: `tests/crawl.ts`, `lib/sources/crawl/index.ts`

**Interfaces:**
- Consumes: `CrawlAdapter`, `CrawlContext`, `CrawlError` (types.ts); `fromMinorUnits`, `convert` (money.ts).
- Produces: `wooAdapter: CrawlAdapter`, and `toProduct(raw: WooProduct, variations: WooProduct[], options: WooMapOptions): Product` exported for the test.

- [ ] **Step 1: Write the fixtures**

`tests/fixtures/crawl/woo-store-api.json` — trimmed from a real Store API response. Note `prices` are strings in **minor units**, with the exponent stated in the same object.

```json
[
  {
    "id": 21,
    "name": "Cotton Tote",
    "slug": "cotton-tote",
    "type": "simple",
    "sku": "TOTE-01",
    "description": "<p>Roomy.</p>",
    "short_description": "<p>Roomy tote.</p>",
    "prices": {
      "price": "1450",
      "regular_price": "1450",
      "sale_price": "1450",
      "currency_code": "USD",
      "currency_minor_unit": 2
    },
    "is_in_stock": true,
    "images": [{ "id": 9, "src": "https://shop.example/wp-content/uploads/tote.jpg" }],
    "categories": [{ "id": 3, "name": "Bags", "slug": "bags" }],
    "tags": [{ "id": 8, "name": "cotton", "slug": "cotton" }],
    "attributes": [],
    "variations": []
  },
  {
    "id": 44,
    "name": "Linen Shirt",
    "slug": "linen-shirt",
    "type": "variable",
    "sku": "SHIRT",
    "description": "<p>Linen.</p>",
    "short_description": "",
    "prices": {
      "price": "5900",
      "regular_price": "5900",
      "sale_price": "5900",
      "currency_code": "USD",
      "currency_minor_unit": 2
    },
    "is_in_stock": true,
    "images": [{ "id": 12, "src": "https://shop.example/wp-content/uploads/shirt.jpg" }],
    "categories": [{ "id": 4, "name": "Clothing", "slug": "clothing" }],
    "tags": [],
    "attributes": [
      {
        "id": 1,
        "name": "Size",
        "taxonomy": "pa_size",
        "has_variations": true,
        "terms": [{ "id": 5, "name": "S", "slug": "s" }, { "id": 6, "name": "M", "slug": "m" }]
      }
    ],
    "variations": [
      { "id": 45, "attributes": [{ "name": "Size", "value": "S" }] },
      { "id": 46, "attributes": [{ "name": "Size", "value": "M" }] }
    ]
  }
]
```

`tests/fixtures/crawl/woo-variation.json` — one variation record, as `/products/45` returns it:

```json
{
  "id": 45,
  "name": "Linen Shirt - S",
  "sku": "SHIRT-S",
  "type": "variation",
  "prices": {
    "price": "4900",
    "regular_price": "5900",
    "sale_price": "4900",
    "currency_code": "USD",
    "currency_minor_unit": 2
  },
  "is_in_stock": true,
  "images": [{ "id": 13, "src": "https://shop.example/wp-content/uploads/shirt-s.jpg" }],
  "attributes": [{ "name": "Size", "value": "S" }]
}
```

- [ ] **Step 2: Write the failing test**

Add the import to `tests/crawl.ts`:

```ts
import { toProduct as wooToProduct, type WooProduct } from "../lib/sources/crawl/adapters/woocommerce";
```

and this function, called from `main()` after `shopifyTests();`:

```ts
function wooTests(): void {
  console.log("\nWooCommerce mapping");

  const products = JSON.parse(fixture("woo-store-api.json")) as WooProduct[];
  const variation = JSON.parse(fixture("woo-variation.json")) as WooProduct;
  const opts = { imagesPerProduct: 10, fxRate: null };

  const tote = wooToProduct(products[0], [], opts);

  check("name", tote.name === "Cotton Tote", tote.name);
  check("slug", tote.slug === "cotton-tote", String(tote.slug));
  check("sku", tote.sku === "TOTE-01", String(tote.sku));
  check("description", tote.description === "<p>Roomy.</p>", String(tote.description));
  check("short description", tote.short_description === "<p>Roomy tote.</p>");

  /*
   * The Store API states its OWN exponent per product. Reading the crawl's
   * configured currency instead would price a VND shop as if it were USD.
   */
  check("price from minor units", tote.regular_price === "14.50", String(tote.regular_price));
  check("no sale when sale equals regular", tote.sale_price === undefined);
  check("in stock", tote.instock === true);
  check("category name only", JSON.stringify(tote.categories) === '["Bags"]');
  check("tag name only", JSON.stringify(tote.tags) === '["cotton"]');
  check("simple", tote.type === "simple", String(tote.type));

  const shirt = wooToProduct(products[1], [variation], opts);

  check("variable", shirt.type === "variable", String(shirt.type));
  check("attribute name", shirt.attributes?.[0].name === "Size", JSON.stringify(shirt.attributes));
  check(
    "attribute values from terms",
    JSON.stringify(shirt.attributes?.[0].values) === '["S","M"]',
    JSON.stringify(shirt.attributes?.[0].values),
  );
  check("attribute drives variation", shirt.attributes?.[0].used_for_variation === true);
  check("one variation fetched", (shirt.variations ?? []).length === 1);
  check("variation sku", shirt.variations?.[0].sku === "SHIRT-S", String(shirt.variations?.[0].sku));
  check("variation regular price", shirt.variations?.[0].regular_price === "59.00");
  check("variation sale price", shirt.variations?.[0].sale_price === "49.00");
  check(
    "variation attributes",
    JSON.stringify(shirt.variations?.[0].attributes) === '[{"name":"Size","value":"S"}]',
    JSON.stringify(shirt.variations?.[0].attributes),
  );

  // A zero-decimal currency must not be divided by a hundred.
  const vnd = JSON.parse(fixture("woo-store-api.json")) as WooProduct[];
  vnd[0].prices.currency_code = "VND";
  vnd[0].prices.currency_minor_unit = 0;
  vnd[0].prices.price = "25400";
  vnd[0].prices.regular_price = "25400";
  vnd[0].prices.sale_price = "25400";
  const dong = wooToProduct(vnd[0], [], opts);
  check("VND has no minor unit", dong.regular_price === "25400", String(dong.regular_price));
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./tests/crawl.sh`
Expected: FAIL — `Cannot find module '../lib/sources/crawl/adapters/woocommerce'`

- [ ] **Step 4: Write the adapter**

Create `lib/sources/crawl/adapters/woocommerce.ts`:

```ts
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
import { convert, fromMinorUnits } from "../money";
import { CrawlError, type CrawlAdapter, type CrawlContext, type DetectInput } from "../types";

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

  return Number(sale) < Number(regular)
    ? { regular_price: regular, sale_price: sale }
    : { regular_price: regular };
}

function imagesOf(raw: WooProduct, options: WooMapOptions): string[] {
  return raw.images.map((image) => image.src).slice(0, options.imagesPerProduct);
}

function variationOf(raw: WooProduct, options: WooMapOptions): ProductVariation {
  return {
    sku: raw.sku ?? undefined,
    ...priceFields(raw.prices, options),
    instock: raw.is_in_stock,
    attributes: (raw.attributes as unknown as Array<{ name: string; value: string }>).map(
      (attribute) => ({ name: attribute.name, value: attribute.value }),
    ),
    image: raw.images[0]?.src,
  };
}

export function toProduct(
  raw: WooProduct,
  variations: WooProduct[],
  options: WooMapOptions,
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

  // A variable product whose variations could not be read is published as a
  // simple one at the parent's price, rather than as a variable product with no
  // variations — which WooCommerce shows as unbuyable.
  if (raw.type !== "variable" || variations.length === 0) {
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
    variations: variations.map((variation) => variationOf(variation, options)),
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
    if (/woocommerce/i.test(input.html)) {
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
            raw.type === "variable" ? await readVariations(raw, ctx) : ([] as WooProduct[]);

          yield toProduct(raw, variations, {
            imagesPerProduct: ctx.imagesPerProduct,
            fxRate: ctx.fxRate,
          });
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
async function readVariations(raw: WooProduct, ctx: CrawlContext): Promise<WooProduct[]> {
  const wanted = raw.variations.slice(0, MAX_VARIATIONS);

  if (raw.variations.length > MAX_VARIATIONS) {
    ctx.log({
      level: "warn",
      message: `"${raw.name}" has ${raw.variations.length} variations; reading the first ${MAX_VARIATIONS}.`,
      detail: { wooId: raw.id, total: raw.variations.length },
    });
  }

  const out: WooProduct[] = [];

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
      out.push(JSON.parse(response.body) as WooProduct);
    } catch {
      ctx.log({
        level: "warn",
        message: `Variation ${entry.id} of "${raw.name}" was not valid JSON and was skipped.`,
      });
    }
  }

  return out;
}
```

- [ ] **Step 5: Register it**

In `lib/sources/crawl/index.ts`, import `wooAdapter` and add it to `ADAPTERS`:

```ts
const ADAPTERS: ReadonlyArray<CrawlAdapter> = [shopifyAdapter, wooAdapter];
```

- [ ] **Step 6: Run tests**

Run: `./tests/crawl.sh`
Expected: PASS with a `WooCommerce mapping` section, `0 failed`, and the Task 1 woocommerce robots assertion now green too.

- [ ] **Step 7: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add lib/sources/crawl/adapters/woocommerce.ts lib/sources/crawl/index.ts tests/fixtures/crawl/woo-store-api.json tests/fixtures/crawl/woo-variation.json tests/crawl.ts
git commit -m "feat(crawl): read WooCommerce through the public Store API

The Store API needs no key, which is why it is used instead of v3 REST: reading
a shop should not require its owner to hand over a credential this app would
then have to store and be trusted with. Each product states its own currency
exponent, so a VND shop is not divided by a hundred."
```

---

## Task 3: The Magento adapter

**Files:**
- Create: `lib/sources/crawl/adapters/magento.ts`, `tests/fixtures/crawl/magento-graphql.json`
- Modify: `tests/crawl.ts`, `lib/sources/crawl/index.ts`

**Interfaces:**
- Consumes: `CrawlAdapter`, `CrawlContext`, `CrawlError`; `fromDecimal`, `fromMinorUnits`, `convert`.
- Produces: `magentoAdapter: CrawlAdapter`, `toProduct(raw: MagentoItem, options: MagentoMapOptions): Product`, `PRODUCTS_QUERY: string`.

- [ ] **Step 0: Give `minorUnitFor` one home**

Three modules now need "how many decimals does this currency have": `lib/crawl-options.ts`
already has `minorUnitFor`, and the Magento and generic adapters both need it. Three copies
of a currency table is exactly the drift `money.ts` exists to prevent, and a currency added
to one copy and not the others is a price wrong by a factor of ten.

Move it into `lib/sources/crawl/money.ts`, beside the other money rules:

```ts
/**
 * How many decimal places a currency has.
 *
 * Only the exceptions are listed; everything else is two. Wrong by one is a
 * price wrong by ten, so this lives here with the rest of the money rules
 * rather than being copied into each adapter that needs it.
 */
const ZERO_DECIMAL = new Set(["VND", "JPY", "KRW", "CLP", "ISK", "PYG", "RWF", "UGX", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function minorUnitFor(currency: string | null | undefined): number {
  const code = (currency ?? "").trim().toUpperCase();

  if (ZERO_DECIMAL.has(code)) {
    return 0;
  }
  if (THREE_DECIMAL.has(code)) {
    return 3;
  }

  return 2;
}
```

Then in `lib/crawl-options.ts`, delete its own copy and re-export so its callers do not change:

```ts
export { minorUnitFor } from "./sources/crawl/money";
```

Check `lib/crawl-options.ts` stays importable from a Client Component — `money.ts` imports
nothing but its own error class, so it is safe, but confirm `tsc --noEmit` and `next build`
both still pass before moving on.

Run: `./tests/crawl.sh` — expect `0 failed`; the existing money tests cover this function's
behaviour through its callers, and `lib/crawl-options.ts`'s re-export keeps every current
caller working.

- [ ] **Step 1: Write the fixture**

`tests/fixtures/crawl/magento-graphql.json`:

```json
{
  "data": {
    "products": {
      "total_count": 2,
      "page_info": { "current_page": 1, "page_size": 50, "total_pages": 1 },
      "items": [
        {
          "__typename": "SimpleProduct",
          "sku": "MUG-24",
          "name": "Stoneware Mug",
          "url_key": "stoneware-mug",
          "stock_status": "IN_STOCK",
          "description": { "html": "<p>Heavy.</p>" },
          "short_description": { "html": "<p>Heavy mug.</p>" },
          "image": { "url": "https://m2.example/media/catalog/product/mug.jpg" },
          "media_gallery": [
            { "url": "https://m2.example/media/catalog/product/mug.jpg" },
            { "url": "https://m2.example/media/catalog/product/mug-2.jpg" }
          ],
          "categories": [{ "name": "Kitchen" }],
          "price_range": {
            "minimum_price": {
              "regular_price": { "value": 24, "currency": "USD" },
              "final_price": { "value": 19.5, "currency": "USD" }
            }
          }
        },
        {
          "__typename": "SimpleProduct",
          "sku": "PLATE-01",
          "name": "Side Plate",
          "url_key": "side-plate",
          "stock_status": "OUT_OF_STOCK",
          "description": { "html": "" },
          "short_description": { "html": "" },
          "image": null,
          "media_gallery": [],
          "categories": [],
          "price_range": {
            "minimum_price": {
              "regular_price": { "value": 8, "currency": "USD" },
              "final_price": { "value": 8, "currency": "USD" }
            }
          }
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

Add the import to `tests/crawl.ts`:

```ts
import { toProduct as magentoToProduct, type MagentoItem } from "../lib/sources/crawl/adapters/magento";
```

and this, called from `main()` after `wooTests();`:

```ts
function magentoTests(): void {
  console.log("\nMagento mapping");

  const payload = JSON.parse(fixture("magento-graphql.json")) as {
    data: { products: { items: MagentoItem[] } };
  };
  const items = payload.data.products.items;
  const opts = { imagesPerProduct: 10, fxRate: null };

  const mug = magentoToProduct(items[0], opts);

  check("name", mug.name === "Stoneware Mug", mug.name);
  check("slug from url_key", mug.slug === "stoneware-mug", String(mug.slug));
  check("sku", mug.sku === "MUG-24", String(mug.sku));
  check("description html", mug.description === "<p>Heavy.</p>", String(mug.description));
  check("category", JSON.stringify(mug.categories) === '["Kitchen"]');
  check("in stock", mug.instock === true);

  /*
   * Magento sends price as a JSON NUMBER, and `final_price` is what is charged
   * while `regular_price` is the list price — so a discounted product maps the
   * lower one to sale_price, like WooCommerce and unlike Shopify's inversion.
   */
  check("regular price", mug.regular_price === "24.00", String(mug.regular_price));
  check("sale price", mug.sale_price === "19.50", String(mug.sale_price));

  // De-duplicated: `image` repeats the first gallery entry on most stores.
  check(
    "images de-duplicated and ordered",
    JSON.stringify(mug.images) ===
      '["https://m2.example/media/catalog/product/mug.jpg","https://m2.example/media/catalog/product/mug-2.jpg"]',
    JSON.stringify(mug.images),
  );

  const plate = magentoToProduct(items[1], opts);
  check("out of stock", plate.instock === false);
  check("no sale when equal", plate.sale_price === undefined);
  check("empty description omitted", plate.description === undefined);
  check("no images", JSON.stringify(plate.images) === "[]");

  const converted = magentoToProduct(items[0], { ...opts, fxRate: 25400 });
  check("fx applied", converted.regular_price === "609600.00", String(converted.regular_price));
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./tests/crawl.sh`
Expected: FAIL — `Cannot find module '../lib/sources/crawl/adapters/magento'`

- [ ] **Step 4: Write the adapter**

Create `lib/sources/crawl/adapters/magento.ts`:

```ts
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
import { convert, fromDecimal, fromMinorUnits } from "../money";
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
 */
function price(money: MagentoMoney, options: MagentoMapOptions): string {
  if (money.value === null || !Number.isFinite(money.value)) {
    throw new CrawlError(`Magento sent a price this crawler cannot read: ${String(money.value)}.`);
  }

  const minorUnit = minorUnitFor(money.currency);
  const decimal = fromMinorUnits(fromDecimal(String(money.value), minorUnit), minorUnit);

  return options.fxRate === null ? decimal : convert(decimal, options.fxRate, minorUnit);
}

/**
 * Magento names the currency on every price, so the exponent comes from the
 * product rather than from the crawl's setting — the same rule the WooCommerce
 * adapter follows for `currency_minor_unit`.
 */
// `minorUnitFor` is imported from `../money` — see Task 3 Step 0.

export function toProduct(raw: MagentoItem, options: MagentoMapOptions): Product {
  const gallery = raw.media_gallery.map((entry) => entry.url);
  const first = raw.image?.url;

  // `image` repeats the first gallery entry on most stores; a Set keeps order
  // and drops the repeat without a second pass.
  const images = [...new Set([...(first === undefined ? [] : [first]), ...gallery])].slice(
    0,
    options.imagesPerProduct,
  );

  const regular = price(raw.price_range.minimum_price.regular_price, options);
  const final = price(raw.price_range.minimum_price.final_price, options);

  const description = raw.description?.html ?? "";
  const shortDescription = raw.short_description?.html ?? "";

  return {
    name: raw.name,
    slug: raw.url_key ?? undefined,
    sku: raw.sku,
    description: description === "" ? undefined : description,
    short_description: shortDescription === "" ? undefined : shortDescription,
    type: "simple",
    ...(Number(final) < Number(regular)
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
```

- [ ] **Step 5: Register it**

```ts
const ADAPTERS: ReadonlyArray<CrawlAdapter> = [shopifyAdapter, wooAdapter, magentoAdapter];
```

- [ ] **Step 6: Run tests and commit**

Run: `./tests/crawl.sh` — expect a `Magento mapping` section and `0 failed`.

```bash
./node_modules/.bin/tsc --noEmit
git add lib/sources/crawl/adapters/magento.ts lib/sources/crawl/index.ts tests/fixtures/crawl/magento-graphql.json tests/crawl.ts
git commit -m "feat(crawl): read Magento through the storefront GraphQL endpoint

Over GET, not POST: CrawlTransport exposes one verb on purpose, because it is
the seam the customer's own browser stands in for later, and a relay that can
be asked to POST arbitrary bodies is a much larger thing to hand somebody."
```

---

## Task 4: HTML extraction, and the generic adapter

**Files:**
- Create: `lib/sources/crawl/html.ts`, `lib/sources/crawl/adapters/generic.ts`, four fixtures
- Modify: `tests/crawl.ts`, `lib/sources/crawl/index.ts`

**Interfaces:**
- Consumes: `CrawlAdapter`, `CrawlContext`, `CrawlError`; `fromDecimal`, `fromMinorUnits`, `convert`.
- Produces: `jsonLdBlocks(html: string): unknown[]`, `metaContent(html: string, key: string): string | null`, `sitemapUrls(xml: string): string[]`, `genericAdapter: CrawlAdapter`, `productFromJsonLd(node, options)`, `productFromMeta(html, url, options)`.

- [ ] **Step 1: Write the fixtures**

`tests/fixtures/crawl/jsonld-product.html`:

```html
<!doctype html><html><head><title>Wool Scarf</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"BreadcrumbList","itemListElement":[]},
 {"@type":"Product","name":"Wool Scarf","sku":"SCARF-9","description":"Warm.",
  "image":["https://shop.example/scarf-1.jpg","https://shop.example/scarf-2.jpg"],
  "brand":{"@type":"Brand","name":"Northbound"},
  "offers":{"@type":"Offer","price":"42.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
]}
</script></head><body><h1>Wool Scarf</h1></body></html>
```

`tests/fixtures/crawl/og-product.html`:

```html
<!doctype html><html><head>
<meta property="og:title" content="Canvas Belt" />
<meta property="og:image" content="https://shop.example/belt.jpg" />
<meta property="product:price:amount" content="18.5" />
<meta property="product:price:currency" content="USD" />
</head><body><h1>Canvas Belt</h1></body></html>
```

`tests/fixtures/crawl/sitemap-index.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://shop.example/sitemap-products.xml</loc></sitemap>
</sitemapindex>
```

`tests/fixtures/crawl/sitemap-products.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shop.example/product/scarf</loc></url>
  <url><loc>https://shop.example/product/belt</loc></url>
  <url><loc>https://shop.example/private/hidden</loc></url>
</urlset>
```

- [ ] **Step 2: Write the failing test**

Add imports to `tests/crawl.ts`:

```ts
import { jsonLdBlocks, metaContent, sitemapUrls } from "../lib/sources/crawl/html";
import { productFromJsonLd, productFromMeta } from "../lib/sources/crawl/adapters/generic";
```

and this, called from `main()` after `magentoTests();`:

```ts
function genericTests(): void {
  console.log("\nGeneric (schema.org)");

  const productHtml = fixture("jsonld-product.html");
  const blocks = jsonLdBlocks(productHtml);
  check("one json-ld block", blocks.length === 1, String(blocks.length));

  const opts = { imagesPerProduct: 10, fxRate: null };
  const scarf = productFromJsonLd(blocks[0], opts);

  check("found the Product inside @graph", scarf !== null);
  check("name", scarf?.name === "Wool Scarf", String(scarf?.name));
  check("sku", scarf?.sku === "SCARF-9", String(scarf?.sku));
  check("description", scarf?.description === "Warm.", String(scarf?.description));
  check("price from offers", scarf?.regular_price === "42.00", String(scarf?.regular_price));
  check("in stock from availability", scarf?.instock === true);
  check("brand kept as meta", scarf?.custom_meta?.brand === "Northbound");
  check(
    "images",
    JSON.stringify(scarf?.images) ===
      '["https://shop.example/scarf-1.jpg","https://shop.example/scarf-2.jpg"]',
    JSON.stringify(scarf?.images),
  );

  // A block with no Product at all must answer null, not throw.
  check("no Product means null", productFromJsonLd({ "@type": "WebSite" }, opts) === null);

  const ogHtml = fixture("og-product.html");
  check("meta by property", metaContent(ogHtml, "og:title") === "Canvas Belt");
  check("missing meta is null", metaContent(ogHtml, "og:description") === null);

  const belt = productFromMeta(ogHtml, "https://shop.example/belt", opts);
  check("og name", belt?.name === "Canvas Belt", String(belt?.name));
  check("og price", belt?.regular_price === "18.50", String(belt?.regular_price));
  check("og image", JSON.stringify(belt?.images) === '["https://shop.example/belt.jpg"]');

  // Without a price there is nothing worth importing.
  check(
    "no price means null",
    productFromMeta('<meta property="og:title" content="X" />', "https://x.example/x", opts) === null,
  );

  check(
    "sitemap index urls",
    JSON.stringify(sitemapUrls(fixture("sitemap-index.xml"))) ===
      '["https://shop.example/sitemap-products.xml"]',
  );
  check("sitemap product urls", sitemapUrls(fixture("sitemap-products.xml")).length === 3);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./tests/crawl.sh`
Expected: FAIL — `Cannot find module '../lib/sources/crawl/html'`

- [ ] **Step 4: Write the extractor**

Create `lib/sources/crawl/html.ts`:

```ts
/*
 * Reading three things out of an HTML string, without a DOM.
 *
 * Hand-rolled for the same reason `robots.ts` is: a parser dependency would be
 * a supply-chain surface for what amounts to three regular expressions, and this
 * repo keeps its dependency list short on purpose.
 *
 * What this deliberately does NOT do is microdata or DOM heuristics — those need
 * real tree traversal, they belong with the browser path, and pretending to do
 * them with regular expressions is how a crawler starts inventing prices.
 *
 * Do NOT import "server-only": the worker and the test suite both read this.
 */

/** Every parsed `<script type="application/ld+json">` payload, bad ones skipped. */
export function jsonLdBlocks(html: string): unknown[] {
  const pattern =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

  const out: unknown[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    try {
      out.push(JSON.parse(match[1].trim()));
    } catch {
      // A malformed block is one site's mistake, not a reason to stop reading.
    }
  }

  return out;
}

/**
 * The `content` of a `<meta>` whose `property` or `name` is `key`.
 *
 * Both attributes are accepted because Open Graph specifies `property` and a
 * great many pages write `name` anyway.
 */
export function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    new RegExp(
      `<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match !== null) {
      return decodeEntities(match[1]);
    }
  }

  return null;
}

/** Every `<loc>` in a sitemap or a sitemap index — the two have the same shape. */
export function sitemapUrls(xml: string): string[] {
  const pattern = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;

  const out: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(xml)) !== null) {
    out.push(decodeEntities(match[1].trim()));
  }

  return out;
}

/** The five XML entities, which is all a `content` or a `<loc>` may carry. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
```

- [ ] **Step 5: Write the generic adapter**

Create `lib/sources/crawl/adapters/generic.ts`:

```ts
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
import { convert, fromDecimal, fromMinorUnits } from "../money";
import { CrawlError, type CrawlAdapter, type CrawlContext, type DetectInput } from "../types";

const MAX_SITEMAPS = 25;
const MAX_URLS = 5_000;

export interface GenericMapOptions {
  imagesPerProduct: number;
  fxRate: number | null;
}

// `minorUnitFor` is imported from `../money` — see Task 3 Step 0.

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

/** Sitemap, then any sitemaps it indexes. */
async function discover(ctx: CrawlContext): Promise<string[]> {
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

    const childResponse = await ctx.transport.fetchText(child);
    if (childResponse.status === 200) {
      out.push(...sitemapUrls(childResponse.body));
    }
  }

  return out.slice(0, MAX_URLS);
}
```

- [ ] **Step 6: Register, run and commit**

```ts
const ADAPTERS: ReadonlyArray<CrawlAdapter> = [
  shopifyAdapter,
  wooAdapter,
  magentoAdapter,
  genericAdapter,
];
```

Run: `./tests/crawl.sh` — expect a `Generic (schema.org)` section and `0 failed`.

```bash
./node_modules/.bin/tsc --noEmit
git add lib/sources/crawl/html.ts lib/sources/crawl/adapters/generic.ts lib/sources/crawl/index.ts tests/fixtures/crawl tests/crawl.ts
git commit -m "feat(crawl): read an unknown shop from its sitemap and schema.org

JSON-LD first, Open Graph second, and nothing at all when a page has no price:
a catalogue of names with blank prices is worse than a short catalogue, because
it looks like it worked."
```

---

## Task 5: Detecting the platform

**Files:**
- Modify: `lib/sources/crawl/types.ts`, `lib/sources/crawl/transport.ts`, `lib/sources/crawl/index.ts`, `lib/crawl-options.ts`, `app/api/crawl/route.ts`, `app/(app)/crawl/crawl-form.tsx`, `tests/crawl.ts`

**Interfaces:**
- Consumes: every adapter's `detect(input: DetectInput): number`.
- Produces: `detectPlatform(ctx): Promise<PlatformName>` inside the orchestrator; `CrawlResponse.headers: Record<string, string>`.

- [ ] **Step 1: Carry response headers**

`DetectInput` already asks for headers, but `CrawlResponse` does not have them, so no adapter can score on one.

In `lib/sources/crawl/types.ts`, add to `CrawlResponse`:

```ts
  /** Lower-cased header names, so an adapter can score on `x-shopify-stage`. */
  headers: Record<string, string>;
```

In `lib/sources/crawl/transport.ts`, in the two places a `CrawlResponse` is built (the 429/503 short-circuit and the terminal return), add:

```ts
        headers: Object.fromEntries(response.headers),
```

`Headers` iterates as lower-cased name/value pairs, so no normalisation is needed. Fix the scripted test double in `tests/crawl.ts` if it constructs a `CrawlResponse` literal.

- [ ] **Step 2: Write the failing test**

Add to `orchestratorTests()` in `tests/crawl.ts`:

```ts
  /*
   * Detection reads the homepage ONCE and scores every adapter against it. It
   * has to fetch, so it happens after robots.txt like everything else.
   */
  function homepageTransport(html: string, headers: Record<string, string> = {}) {
    const asked: string[] = [];

    return {
      asked,
      transport: {
        async fetchText(url: string) {
          asked.push(url);
          const path = new URL(url).pathname;

          if (path === "/robots.txt") {
            return { status: 200, contentType: "text/plain", body: "", headers: {} };
          }
          if (path === "/") {
            return { status: 200, contentType: "text/html", body: html, headers };
          }
          if (path === "/products.json") {
            const page = new URL(url).searchParams.get("page");
            return {
              status: 200,
              contentType: "application/json",
              body: page === "1" ? fixture("shopify-products.json") : '{"products":[]}',
              headers: {},
            };
          }
          return { status: 404, contentType: "text/plain", body: "", headers: {} };
        },
      },
    };
  }

  const auto = homepageTransport('<html><script src="https://cdn.shopify.com/x.js"></script></html>');
  const detected = await crawlShop({
    shopUrl: "https://example.test",
    platform: "auto",
    limit: 10,
    imagesPerProduct: 5,
    minorUnit: 2,
    fxRate: null,
    signal: new AbortController().signal,
    log: () => {},
    transport: auto.transport,
  });
  check("auto detected shopify", detected.platform === "shopify", detected.platform);
  check("the homepage was read once", auto.asked.filter((u) => u.endsWith("/")).length === 1);

  // Nothing recognisable falls back to the generic adapter rather than refusing.
  const unknown = homepageTransport("<html><body>a shop</body></html>");
  await refusesAsync(
    "an unrecognised site falls back to generic and needs a sitemap",
    () =>
      crawlShop({
        shopUrl: "https://example.test",
        platform: "auto",
        limit: 10,
        imagesPerProduct: 5,
        minorUnit: 2,
        fxRate: null,
        signal: new AbortController().signal,
        log: () => {},
        transport: unknown.transport,
      }),
    /sitemap/i,
  );
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./tests/crawl.sh`
Expected: FAIL — `Automatic platform detection arrives with the other adapters.`

- [ ] **Step 4: Implement detection**

In `lib/sources/crawl/index.ts`, replace `pickAdapter` with:

```ts
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
```

Then in `crawlShop`, after robots.txt is parsed and before the `robotsPaths` check:

```ts
    const adapter =
      input.platform === "auto"
        ? await detectPlatform(shopUrl, transport, input.log)
        : adapterNamed(input.platform);
```

Detection fetches `/`, so check that against robots first:

```ts
    if (input.platform === "auto" && !rules.isAllowed("/")) {
      throw new CrawlError(
        `${shopUrl.host} disallows its own home page in robots.txt, so this crawler cannot work ` +
          "out what it is. Choose the platform by hand.",
      );
    }
```

Import `CrawlTransport`, `CrawlLogLine`, `DetectInput` types as needed.

- [ ] **Step 5: Let the UI ask for it**

In `lib/crawl-options.ts`, change the platform field:

```ts
  /**
   * `auto` reads the home page and scores every adapter against it. Named
   * platforms skip that request entirely, which is why the form still offers
   * them: an operator who knows what the shop runs should not pay for a guess.
   */
  platform: z.enum([...CRAWL_PLATFORMS, "auto"]).default("auto"),
```

In `app/(app)/crawl/crawl-form.tsx`, add an "auto" option labelled **Detect automatically**, make it the default, and remove `disabled` from `woocommerce`, `magento` and `generic`. Leave `etsy` disabled with the hint "Needs the browser crawler". Read the real props of `Segmented` before editing.

In `app/api/crawl/route.ts`, nothing changes — it passes `options.platform` straight through — but confirm by reading it.

- [ ] **Step 6: Run everything and commit**

```bash
./node_modules/.bin/tsc --noEmit
pnpm lint
./tests/crawl.sh
./node_modules/.bin/next build
```

Expect `0 failed` and a successful build.

```bash
git add lib/sources/crawl lib/crawl-options.ts 'app/(app)/crawl/crawl-form.tsx' tests/crawl.ts
git commit -m "feat(crawl): detect the platform from the home page

Scored across every adapter rather than decided by one signal, because every
individual signal lies somewhere. Nothing recognisable falls back to the
generic reader instead of refusing."
```

---

## Task 6: Documentation

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-08-24-product-crawler-source-design.md`

- [ ] **Step 1: Update the spec**

The spec's §4 table and its summary table both say only Shopify shipped. Update them to say plan 2 shipped WooCommerce, Magento and Generic, and that Etsy alone remains. Follow the file's existing `> **Sửa so với bản đầu**` convention for anything that diverged from the design — in particular:

- Woo v3 REST was designed as an option and is **not built**: the Store API needs no credential, and storing a customer's key was judged not worth the surface.
- Magento GraphQL goes over **GET**, not POST, because `CrawlTransport` deliberately exposes one verb.
- The generic adapter does JSON-LD and Open Graph but **not** microdata or DOM heuristics; those need real tree traversal and belong with the browser path.

- [ ] **Step 2: Update the README**

`README.md`'s `## Source data` section describes the crawler as "**Shopify only**, so far". Correct it, and describe what each adapter reads and what makes it fail. Match the surrounding prose style — this README explains *why*, not just *what*. It is written in English.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/
git commit -m "docs: record the WooCommerce, Magento and generic adapters"
```

---

## Self-Review Notes

Spec coverage for §4 (the adapter table), §4.1 (minor units per platform) and §4.2 (paging):

| Spec | Task |
|---|---|
| §4 `woocommerce` fast path (Store API) | 2 |
| §4 `magento` fast path (`/graphql`) | 3 |
| §4 `generic` (JSON-LD → OG → sitemap) | 4 |
| §4 scored detection from headers/generator/assets | 5 |
| §4.1 Woo `currency_minor_unit` read per product | 2 |
| §4.2 paging with a hard cap | 2, 3, 4 |
| §7.2 robots honoured per adapter and per discovered url | 1, 4 |
| §7.4 hard caps on pages, sitemaps and urls | 2, 3, 4 |

**Deliberately not built, and stated in the plan rather than left silent:**

- **Etsy** — needs a browser; plan 3.
- **Woo v3 REST** — the user chose Store API only, so no credential is ever accepted or stored.
- **Microdata and DOM heuristics** in the generic adapter — real tree traversal, and the honest place for them is the browser path.
- **Magento configurable-product variations** — the GraphQL query reads `price_range` and maps every product as `simple`. Reading `ConfigurableProduct` variants needs a second query shape per product; it is worth doing, but it is not this plan, and the plan says so rather than half-building it.
