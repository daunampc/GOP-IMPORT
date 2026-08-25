/**
 * The crawler's pure parts: money arithmetic, robots.txt, and the Shopify mapping.
 *
 * Run through tests/crawl.sh. Deliberately the LIGHT suite, for the same reason
 * tests/images-staging.ts is one: nothing here touches Postgres, Redis or a
 * `next build`, so folding it into tests/isolation.sh would make a millisecond
 * assertion cost fifteen minutes — and a test that takes minutes is a test that
 * stops being run.
 *
 * NO NETWORK. Every adapter assertion reads a saved fixture, because the thing
 * most likely to break here is a platform changing its payload, and a suite that
 * needs a live shop cannot tell that apart from a shop being down.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CrawlMoneyError,
  convert,
  fromDecimal,
  fromMinorUnits,
  lessThan,
} from "../lib/sources/crawl/money";
import { CRAWLER_USER_AGENT, parseRobots } from "../lib/sources/crawl/robots";
import { fullSizeImage, toProduct, type ShopifyProduct } from "../lib/sources/crawl/adapters/shopify";
import { toProduct as wooToProduct, type WooProduct } from "../lib/sources/crawl/adapters/woocommerce";
import { toProduct as magentoToProduct, type MagentoItem } from "../lib/sources/crawl/adapters/magento";
import { serverTransport, sleep } from "../lib/sources/crawl/transport";
import { crawlShop, MAX_CRAWL_DELAY_MS } from "../lib/sources/crawl";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail === "" ? "" : `\n       ${detail}`}`);
  }
}

/** Run `body`, and report what it threw rather than letting it end the suite. */
function refuses(name: string, body: () => unknown, expect: RegExp): void {
  try {
    body();
    check(name, false, "it did not refuse at all");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, expect.test(message), `refused, but with: ${message}`);
  }
}

/** The async twin of `refuses`. */
async function refusesAsync(
  name: string,
  body: () => Promise<unknown>,
  expect: RegExp,
): Promise<void> {
  try {
    await body();
    check(name, false, "it did not refuse at all");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, expect.test(message), `refused, but with: ${message}`);
  }
}

export function fixture(name: string): string {
  // `__dirname`, not `import.meta.dirname`: this project is CJS — see the
  // `tsx --env-file` comment in ecosystem.config.js, which was verified the hard way.
  return readFileSync(join(__dirname, "fixtures", "crawl", name), "utf8");
}

function moneyTests(): void {
  console.log("\nMoney");

  check("Shopify cents", fromMinorUnits(1999, 2) === "19.99", fromMinorUnits(1999, 2));
  check("cents, round number", fromMinorUnits(2000, 2) === "20.00", fromMinorUnits(2000, 2));
  check("cents under a unit", fromMinorUnits(5, 2) === "0.05", fromMinorUnits(5, 2));
  check("zero", fromMinorUnits(0, 2) === "0.00", fromMinorUnits(0, 2));

  // The whole reason this function exists rather than a division by 100.
  check("VND has no minor unit", fromMinorUnits(25400, 0) === "25400", fromMinorUnits(25400, 0));
  check("JPY has no minor unit", fromMinorUnits(980, 0) === "980", fromMinorUnits(980, 0));
  check("three-decimal dinar", fromMinorUnits(1999, 3) === "1.999", fromMinorUnits(1999, 3));

  // Woo's Store API sends the integer as a string.
  check("string input", fromMinorUnits("1999", 2) === "19.99", fromMinorUnits("1999", 2));

  refuses("a non-integer minor amount", () => fromMinorUnits(19.99, 2), /whole number/i);
  refuses("a negative minor unit", () => fromMinorUnits(1999, -1), /minor unit/i);
  refuses("nonsense", () => fromMinorUnits("abc", 2), /whole number/i);

  check(
    "convert rounds to 2dp",
    convert("10.00", 25400, 2) === "254000.00",
    convert("10.00", 25400, 2),
  );
  check(
    "convert keeps precision",
    convert("19.99", 0.5, 2) === "10.00",
    convert("19.99", 0.5, 2),
  );
  refuses("a zero rate", () => convert("10.00", 0, 2), /rate/i);

  /*
   * The bug this exists to catch: a hardcoded x100 dropped the third digit of a
   * three-decimal currency (KWD, BHD, OMR) before the rate was even applied.
   */
  check(
    "convert preserves a 3-decimal currency at rate 1",
    convert("19.995", 1, 3) === "19.995",
    convert("19.995", 1, 3),
  );
  check(
    "convert applies a rate to a 3-decimal currency",
    convert("10.000", 2, 3) === "20.000",
    convert("10.000", 2, 3),
  );
  refuses(
    "convert refuses more precision than the minor unit holds",
    () => convert("19.9999", 1, 3),
    /decimal place/i,
  );

  check("decimal to cents", fromDecimal("18.00", 2) === 1800, String(fromDecimal("18.00", 2)));
  check("one decimal place", fromDecimal("18.5", 2) === 1850, String(fromDecimal("18.5", 2)));
  check("no decimal point", fromDecimal("18", 2) === 1800, String(fromDecimal("18", 2)));

  /*
   * The case that makes trailing zeros worth stripping: Shopify quotes VND with
   * two decimals even though the currency has none.
   */
  check("VND quoted with decimals", fromDecimal("25400.00", 0) === 25400, String(fromDecimal("25400.00", 0)));
  check("JPY quoted with decimals", fromDecimal("980.00", 0) === 980, String(fromDecimal("980.00", 0)));
  check("three-decimal currency", fromDecimal("1.999", 3) === 1999, String(fromDecimal("1.999", 3)));
  check("negative", fromDecimal("-18.00", 2) === -1800, String(fromDecimal("-18.00", 2)));

  // The whole point of the change: precision loss is an error, not a rounding.
  refuses("more decimals than the currency holds", () => fromDecimal("18.005", 2), /decimal place/i);
  refuses("a decimal on a zero-decimal currency", () => fromDecimal("25400.50", 0), /decimal place/i);
  refuses("not a number at all", () => fromDecimal("abc", 2), /not a price/i);

  // Round trip, since the two functions have to agree.
  check("round trip", fromMinorUnits(fromDecimal("64.00", 2), 2) === "64.00");

  check("lessThan, ordinary comparison", lessThan("49.00", "59.00", 2) === true);
  // A sale price equal to the regular price is not a sale.
  check("lessThan, equal values is false", lessThan("59.00", "59.00", 2) === false);
}

function robotsTests(): void {
  console.log("\nrobots.txt");

  const rules = parseRobots(fixture("robots.txt"), CRAWLER_USER_AGENT);

  check("a plain path is allowed", rules.isAllowed("/collections/all"));
  check("the root is allowed", rules.isAllowed("/"));
  check("a disallowed prefix is refused", !rules.isAllowed("/admin/settings"));
  check("an exact disallow is refused", !rules.isAllowed("/cart"));
  check("a disallowed directory is refused", !rules.isAllowed("/products/shoe"));

  /*
   * The rule that makes this worth writing rather than string-matching: the
   * LONGEST match wins, and Allow beats Disallow at equal length. A crawler that
   * simply scanned for a Disallow prefix would refuse this path.
   */
  check("a longer Allow beats a shorter Disallow", rules.isAllowed("/products/allowed-anyway"));

  check("crawl delay is read", rules.crawlDelayMs === 2000, String(rules.crawlDelayMs));

  // The group for another agent must not leak into ours.
  check("another agent's group is ignored", rules.isAllowed("/anything"));

  // An empty Disallow means "nothing is disallowed", not "everything is".
  const permissive = parseRobots("User-agent: *\nDisallow:", CRAWLER_USER_AGENT);
  check("an empty Disallow allows everything", permissive.isAllowed("/admin"));

  // No robots.txt at all, or an unreadable one, must not become a silent block.
  const empty = parseRobots("", CRAWLER_USER_AGENT);
  check("an empty file allows everything", empty.isAllowed("/products/x"));
  check("an empty file has no delay", empty.crawlDelayMs === null);

  const blocked = parseRobots("User-agent: *\nDisallow: /", CRAWLER_USER_AGENT);
  check("a site-wide block is honoured", !blocked.isAllowed("/products/x"));

  /*
   * Wildcards. Shopify's own robots.txt uses them, and a parser that treats
   * `/*` as a literal silently ignores every such rule — the failure this
   * whole translation exists to prevent.
   */
  const wild = parseRobots(
    "User-agent: *\nDisallow: /*/checkouts/\nDisallow: /*.json$\nDisallow: /a*b",
    CRAWLER_USER_AGENT,
  );

  check("a * matches a path segment", !wild.isAllowed("/en/checkouts/abc"));
  check("a * matches an empty run", !wild.isAllowed("//checkouts/abc"));
  check("a plain path is unaffected by wildcards", wild.isAllowed("/collections/all"));
  check("a $ anchors the end", !wild.isAllowed("/products.json"));
  check("a $ does not match past the end", wild.isAllowed("/products.json?page=2"));
  check("a * matches in the middle", !wild.isAllowed("/axxxb"));
  check("a rule still has to match at the start", wild.isAllowed("/z/axxxb"));

  // A dot in a rule is a dot, not "any character".
  const dotted = parseRobots("User-agent: *\nDisallow: /a.b", CRAWLER_USER_AGENT);
  check("a . in a rule is literal", dotted.isAllowed("/axb"));
  check("a . in a rule still matches itself", !dotted.isAllowed("/a.b"));
}

function shopifyTests(): void {
  console.log("\nShopify mapping");

  const payload = JSON.parse(fixture("shopify-products.json")) as { products: ShopifyProduct[] };
  const opts = { imagesPerProduct: 10, minorUnit: 2, fxRate: null };

  const mug = toProduct(payload.products[0], opts);
  const shirt = toProduct(payload.products[1], opts);

  check("name", mug.name === "Enamel Mug", mug.name);
  check("slug from the handle", mug.slug === "enamel-mug", String(mug.slug));
  check("description", mug.description === "<p>Holds coffee.</p>", String(mug.description));
  check("sku from the only variant", mug.sku === "MUG-01", String(mug.sku));
  check("price", mug.regular_price === "18.00", String(mug.regular_price));
  check("no sale price when compare_at is null", mug.sale_price === undefined);
  check("in stock", mug.instock === true);
  check("category from product_type", JSON.stringify(mug.categories) === '["Drinkware"]');
  check("tags", JSON.stringify(mug.tags) === '["kitchen","gift"]');
  check("vendor kept as meta", mug.custom_meta?.brand === "Northbound", JSON.stringify(mug.custom_meta));

  /*
   * The Shopify quirk that decides simple vs variable. A one-variant product
   * whose only option is the literal placeholder `Title: Default Title` is a
   * SIMPLE product — Shopify has no "no options" state, so it invents one.
   * Reading that as a variable product would publish a variation named
   * "Default Title" into the customer's shop.
   */
  check("placeholder options mean simple", mug.type === "simple", String(mug.type));
  check("simple has no variations", (mug.variations ?? []).length === 0);
  check("simple has no attributes", (mug.attributes ?? []).length === 0);

  check("real options mean variable", shirt.type === "variable", String(shirt.type));
  check("two attributes", (shirt.attributes ?? []).length === 2);
  check("attribute name", shirt.attributes?.[0].name === "Size", JSON.stringify(shirt.attributes));
  check(
    "attribute values",
    JSON.stringify(shirt.attributes?.[0].values) === '["S","M"]',
    JSON.stringify(shirt.attributes?.[0].values),
  );
  check("attributes drive variations", shirt.attributes?.[0].used_for_variation === true);
  check("two variations", (shirt.variations ?? []).length === 2);
  check("variation sku", shirt.variations?.[0].sku === "SHIRT-S", String(shirt.variations?.[0].sku));
  check(
    "variation attributes",
    JSON.stringify(shirt.variations?.[0].attributes) ===
      '[{"name":"Size","value":"S"},{"name":"Colour","value":"Sand"}]',
    JSON.stringify(shirt.variations?.[0].attributes),
  );
  check("sale price from compare_at", shirt.variations?.[0].sale_price === "64.00");
  check("regular price from compare_at", shirt.variations?.[0].regular_price === "80.00");
  check("sold-out variation", shirt.variations?.[1].instock === false);

  // Shopify's CDN suffixes are a thumbnail request, not part of the filename.
  check("strips _400x", fullSizeImage("https://cdn.shopify.com/a/mug_400x.jpg") === "https://cdn.shopify.com/a/mug.jpg");
  check("strips _grande", fullSizeImage("https://cdn.shopify.com/a/m_grande.jpg") === "https://cdn.shopify.com/a/m.jpg");
  check("strips _1024x1024", fullSizeImage("https://cdn.shopify.com/a/s_1024x1024.jpg") === "https://cdn.shopify.com/a/s.jpg");
  check("keeps a query string", fullSizeImage("https://cdn.shopify.com/a/m_400x.jpg?v=2") === "https://cdn.shopify.com/a/m.jpg?v=2");
  check("leaves an unsuffixed url alone", fullSizeImage("https://cdn.shopify.com/a/m.jpg") === "https://cdn.shopify.com/a/m.jpg");
  check("images are full size and ordered", JSON.stringify(mug.images) ===
    '["https://cdn.shopify.com/s/files/1/mug.jpg","https://cdn.shopify.com/s/files/1/mug-side.jpg"]',
    JSON.stringify(mug.images));

  const capped = toProduct(payload.products[0], { ...opts, imagesPerProduct: 1 });
  check("image cap applies", (capped.images ?? []).length === 1);

  const converted = toProduct(payload.products[0], { ...opts, fxRate: 25400 });
  check("fx applies to the price", converted.regular_price === "457200.00", String(converted.regular_price));
}

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

async function transportTests(): Promise<void> {
  console.log("\nTransport");

  /*
   * The abort-already-fired fix, direct: a signal aborted BEFORE `sleep` is
   * called must not wait for an 'abort' event that already happened. Asserted
   * on elapsed time against a delay long enough that the old bug would have
   * made this test itself slow.
   */
  {
    const already = new AbortController();
    already.abort();

    const start = Date.now();
    await sleep(5000, already.signal);
    const elapsed = Date.now() - start;

    check(
      "sleep on an already-aborted signal returns promptly",
      elapsed < 100,
      `elapsed ${elapsed}ms, expected well under the 5000ms requested`,
    );
  }

  const transport = serverTransport({ signal: new AbortController().signal, delayMs: 0 });

  /*
   * The SSRF guard, live. This is the assertion that must never be softened: the
   * crawler follows links out of a stranger's HTML, so "make the server fetch
   * this" is the whole attack, and 169.254.169.254 is the cloud metadata endpoint
   * that makes it worth doing.
   */
  await refusesAsync(
    "a loopback address",
    () => transport.fetchText("http://127.0.0.1:3000/products.json"),
    /private|loopback|refuse|not fetch/i,
  );
  await refusesAsync(
    "the cloud metadata endpoint",
    () => transport.fetchText("http://169.254.169.254/latest/meta-data/"),
    /private|link-local|refuse|not fetch/i,
  );
  await refusesAsync(
    "a private range",
    () => transport.fetchText("http://10.0.0.5/products.json"),
    /private|refuse|not fetch/i,
  );
  await refusesAsync(
    "a non-http scheme",
    () => transport.fetchText("file:///etc/passwd"),
    /http|scheme|refuse|not fetch/i,
  );

  /** A fetch that replays scripted responses and records what was asked for. */
  function scripted(steps: Array<{ status: number; location?: string; body?: string }>) {
    const asked: string[] = [];
    let index = 0;

    const impl = async (input: unknown): Promise<Response> => {
      asked.push(String(input));
      const step = steps[Math.min(index, steps.length - 1)];
      index++;

      const headers = new Headers({ "content-type": "application/json" });
      if (step.location !== undefined) {
        headers.set("location", step.location);
      }

      return new Response(step.body ?? "{}", { status: step.status, headers });
    };

    return { asked, impl: impl as unknown as typeof fetch };
  }

  /*
   * THE second-hop test. lib/outbound-url.ts calls refusing this the reason the
   * resolving guard exists, and following redirects inside fetch would skip it.
   */
  const hop = scripted([{ status: 302, location: "http://169.254.169.254/latest/meta-data/" }]);
  await refusesAsync(
    "a redirect to the metadata endpoint",
    () =>
      serverTransport({
        signal: new AbortController().signal,
        delayMs: 0,
        fetchImpl: hop.impl,
      }).fetchText("http://93.184.216.34/products.json"),
    /private|link-local|refuse|not fetch/i,
  );
  check("the blocked hop was never fetched", hop.asked.length === 1, JSON.stringify(hop.asked));

  const priv = scripted([{ status: 301, location: "http://10.0.0.5/products.json" }]);
  await refusesAsync(
    "a redirect into a private range",
    () =>
      serverTransport({
        signal: new AbortController().signal,
        delayMs: 0,
        fetchImpl: priv.impl,
      }).fetchText("http://93.184.216.34/products.json"),
    /private|refuse|not fetch/i,
  );

  const ok = scripted([
    { status: 302, location: "http://203.0.113.9/products.json" },
    { status: 200, body: '{"products":[]}' },
  ]);
  const followed = await serverTransport({
    signal: new AbortController().signal,
    delayMs: 0,
    fetchImpl: ok.impl,
  }).fetchText("http://93.184.216.34/products.json");
  check("an allowed redirect is followed", followed.status === 200, String(followed.status));
  check("the redirect body is returned", followed.body === '{"products":[]}', followed.body);
  check("both hops were fetched", ok.asked.length === 2, JSON.stringify(ok.asked));

  const loop = scripted([{ status: 302, location: "http://203.0.113.9/again" }]);
  await refusesAsync(
    "a redirect loop stops",
    () =>
      serverTransport({
        signal: new AbortController().signal,
        delayMs: 0,
        fetchImpl: loop.impl,
      }).fetchText("http://93.184.216.34/products.json"),
    /redirected more than/i,
  );

  // 404 has to reach the adapter: Shopify's adapter reads it as "products.json is off".
  const missing = scripted([{ status: 404, body: "not found" }]);
  const gone = await serverTransport({
    signal: new AbortController().signal,
    delayMs: 0,
    fetchImpl: missing.impl,
  }).fetchText("http://93.184.216.34/products.json");
  check("404 is returned, not retried", gone.status === 404, String(gone.status));
  check("404 was fetched once", missing.asked.length === 1, JSON.stringify(missing.asked));

  // The size ceiling, with a body deliberately past a tiny limit.
  const big = scripted([{ status: 200, body: "x".repeat(5000) }]);
  await refusesAsync(
    "a body past the ceiling",
    () =>
      serverTransport({
        signal: new AbortController().signal,
        delayMs: 0,
        maxBytes: 1000,
        fetchImpl: big.impl,
      }).fetchText("http://93.184.216.34/products.json"),
    /MB|more than/i,
  );

  /*
   * A 429 must back off and retry, and it must do so even when the error page
   * the site returns is larger than the size ceiling — reading the body before
   * looking at the status once made that case fail instantly.
   */
  const throttled = scripted([{ status: 429, body: "x".repeat(5000) }]);
  await refusesAsync(
    "a 429 is retried, then given up on",
    () =>
      serverTransport({
        signal: new AbortController().signal,
        delayMs: 0,
        maxBytes: 1000,
        backoffMs: [0, 0, 0],
        fetchImpl: throttled.impl,
      }).fetchText("http://93.184.216.34/products.json"),
    /429/,
  );
  check(
    "a 429 was retried, not failed on the first try",
    throttled.asked.length === 4,
    `fetched ${throttled.asked.length} time(s)`,
  );

  const recovers = scripted([
    { status: 503, body: "busy" },
    { status: 200, body: '{"products":[]}' },
  ]);
  const recovered = await serverTransport({
    signal: new AbortController().signal,
    delayMs: 0,
    backoffMs: [0, 0, 0],
    fetchImpl: recovers.impl,
  }).fetchText("http://93.184.216.34/products.json");
  check("a 503 that clears is followed by the real answer", recovered.status === 200, String(recovered.status));
  check("the recovered body is returned", recovered.body === '{"products":[]}', recovered.body);

  // A blocked address is deterministic: retrying it is pointless and slow.
  const blockedHop = scripted([{ status: 302, location: "http://10.0.0.5/x" }]);
  await refusesAsync(
    "a blocked redirect is not retried",
    () =>
      serverTransport({
        signal: new AbortController().signal,
        delayMs: 0,
        backoffMs: [0, 0, 0],
        fetchImpl: blockedHop.impl,
      }).fetchText("http://93.184.216.34/products.json"),
    /private|refuse|not fetch/i,
  );
  check(
    "the blocked redirect was attempted once",
    blockedHop.asked.length === 1,
    `fetched ${blockedHop.asked.length} time(s)`,
  );

  const timed = scripted([{ status: 200, body: "{}" }, { status: 200, body: "{}" }]);
  const raisable = serverTransport({
    signal: new AbortController().signal,
    delayMs: 10,
    fetchImpl: timed.impl,
  });
  check("a transport exposes its floor", typeof raisable.raiseDelayTo === "function");
  raisable.raiseDelayTo(150);
  raisable.raiseDelayTo(10);
  /*
   * Asserted through the actual wait rather than a getter: after being asked
   * for 150ms and then for 10ms, the floor must still be 150ms. Two requests to
   * the same host are timed end to end, so a lowering that slipped through
   * would show up as a ~10ms gap instead of a ~150ms one — the bug this guards
   * against would make this test pass in a fifteenth of the time.
   */
  const start = Date.now();
  await raisable.fetchText("http://93.184.216.34/products.json");
  await raisable.fetchText("http://93.184.216.34/products.json");
  const elapsed = Date.now() - start;
  check(
    "raising then lowering keeps the higher floor",
    elapsed >= 140,
    `elapsed ${elapsed}ms, expected at least 140ms`,
  );
}

async function orchestratorTests(): Promise<void> {
  console.log("\nOrchestrator");

  /** A transport that answers from the fixtures and records what was asked for. */
  function fakeTransport(robots: string) {
    const asked: string[] = [];
    const raisedTo: number[] = [];

    return {
      asked,
      raisedTo,
      transport: {
        async fetchText(url: string) {
          asked.push(url);
          const path = new URL(url).pathname;

          if (path === "/robots.txt") {
            return { status: 200, contentType: "text/plain", body: robots };
          }
          if (path === "/products.json") {
            const page = new URL(url).searchParams.get("page");
            return {
              status: 200,
              contentType: "application/json",
              body: page === "1" ? fixture("shopify-products.json") : '{"products":[]}',
            };
          }
          return { status: 200, contentType: "text/html", body: "<html>cdn.shopify.com</html>" };
        },
        // Present so `crawlShop`'s `"raiseDelayTo" in transport` check finds it,
        // and recording rather than acting on it so the delay-cap test below can
        // prove what was asked for without any real waiting.
        raiseDelayTo(ms: number) {
          raisedTo.push(ms);
        },
      },
    };
  }

  const open = fakeTransport("User-agent: *\nDisallow: /admin");

  const outcome = await crawlShop({
    shopUrl: "https://example.myshopify.com",
    platform: "shopify",
    limit: 100,
    imagesPerProduct: 10,
    minorUnit: 2,
    fxRate: null,
    signal: new AbortController().signal,
    log: () => {},
    transport: open.transport,
  });

  check("platform reported", outcome.platform === "shopify", outcome.platform);
  check("both products", outcome.products.length === 2, String(outcome.products.length));
  check("robots.txt was read first", open.asked[0].endsWith("/robots.txt"), open.asked[0]);
  check("paging stopped on the empty page", open.asked.length === 3, JSON.stringify(open.asked));

  const capped = await crawlShop({
    shopUrl: "https://example.myshopify.com",
    platform: "shopify",
    limit: 1,
    imagesPerProduct: 10,
    minorUnit: 2,
    fxRate: null,
    signal: new AbortController().signal,
    log: () => {},
    transport: fakeTransport("").transport,
  });
  check("the limit is a hard ceiling", capped.products.length === 1, String(capped.products.length));

  // The refusal that has no override. Spec §7.2.
  const blocked = fakeTransport("User-agent: *\nDisallow: /");
  await refusesAsync(
    "robots.txt disallow stops the crawl",
    () =>
      crawlShop({
        shopUrl: "https://example.myshopify.com",
        platform: "shopify",
        limit: 100,
        imagesPerProduct: 10,
        minorUnit: 2,
        fxRate: null,
        signal: new AbortController().signal,
        log: () => {},
        transport: blocked.transport,
      }),
    /robots\.txt/i,
  );

  /*
   * The claim is "one request and stop", not merely "it throws". Without this
   * the test would still pass if the crawl fetched every product first and only
   * then noticed the refusal.
   */
  check(
    "a disallowed store costs exactly one request",
    blocked.asked.length === 1,
    `fetched: ${JSON.stringify(blocked.asked)}`,
  );
  check(
    "no product request was made",
    !blocked.asked.some((url) => url.includes("products.json")),
    `fetched: ${JSON.stringify(blocked.asked)}`,
  );

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

  /*
   * The time-cap finding: a site can ask for a `Crawl-delay` of any size, and
   * this crawl must not adopt it wholesale — the worker has only four job slots
   * for the whole installation, and honouring an hour-long delay would hold one
   * of them hostage for every other account. Asserted through the injected
   * transport's `raiseDelayTo` spy, so nothing here actually sleeps.
   */
  const huge = fakeTransport("User-agent: *\nCrawl-delay: 999999");
  await crawlShop({
    shopUrl: "https://example.myshopify.com",
    platform: "shopify",
    limit: 100,
    imagesPerProduct: 10,
    minorUnit: 2,
    fxRate: null,
    signal: new AbortController().signal,
    log: () => {},
    transport: huge.transport,
  });
  check(
    "an extreme Crawl-delay is capped, not adopted",
    huge.raisedTo.length === 1 && huge.raisedTo[0] === MAX_CRAWL_DELAY_MS,
    `raiseDelayTo was called with: ${JSON.stringify(huge.raisedTo)}`,
  );
}

async function wooOrchestratorTests(): Promise<void> {
  console.log("\nWooCommerce orchestrator");

  interface WooScript {
    /** Fixed status to return for every products-list request, overriding `pages`. */
    productsStatus?: number;
    /** Per-page product arrays; index 0 is page 1. Missing/exhausted pages answer `[]`. */
    pages?: WooProduct[][];
    /** Per-variation-id overrides. A ready-to-serve variation is looked up by id otherwise. */
    variations?: Record<number, { status: number; body?: string }>;
  }

  const knownVariations: Record<number, WooProduct> = {};

  /** A transport that answers Store API requests from a script and records what was asked for. */
  function fakeWooTransport(script: WooScript) {
    const asked: string[] = [];
    const pages = script.pages ?? [];

    return {
      asked,
      transport: {
        async fetchText(url: string) {
          asked.push(url);
          const parsed = new URL(url);

          if (parsed.pathname === "/robots.txt") {
            return { status: 200, contentType: "text/plain", body: "" };
          }

          if (parsed.pathname === "/wp-json/wc/store/v1/products") {
            if (script.productsStatus !== undefined) {
              return { status: script.productsStatus, contentType: "application/json", body: "" };
            }
            const page = Number(parsed.searchParams.get("page") ?? "1");
            return {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(pages[page - 1] ?? []),
            };
          }

          const variationMatch = /\/wp-json\/wc\/store\/v1\/products\/(\d+)$/.exec(parsed.pathname);
          if (variationMatch !== null) {
            const id = Number(variationMatch[1]);
            const override = script.variations?.[id];
            if (override !== undefined) {
              return {
                status: override.status,
                contentType: "application/json",
                body: override.body ?? "",
              };
            }
            const known = knownVariations[id];
            if (known !== undefined) {
              return { status: 200, contentType: "application/json", body: JSON.stringify(known) };
            }
            return { status: 404, contentType: "application/json", body: "" };
          }

          return { status: 404, contentType: "text/plain", body: "not found" };
        },
      },
    };
  }

  const wooProducts = JSON.parse(fixture("woo-store-api.json")) as WooProduct[];
  const tote = wooProducts[0];
  const linenShirt = wooProducts[1];

  const variation45 = JSON.parse(fixture("woo-variation.json")) as WooProduct;
  const variation46: WooProduct = {
    ...variation45,
    id: 46,
    name: "Linen Shirt - M",
    sku: "SHIRT-M",
    // `attributes` on a variation record is actually `{ name, value }[]`, not the
    // product-level `{ name, terms }[]` shape `WooProduct` declares — the same
    // mismatch `variationOf` in the adapter itself casts through.
    attributes: [{ name: "Size", value: "M" }] as unknown as WooProduct["attributes"],
  };
  knownVariations[45] = variation45;
  knownVariations[46] = variation46;

  const baseInput = {
    shopUrl: "https://shop.example",
    platform: "woocommerce" as const,
    imagesPerProduct: 10,
    minorUnit: 2,
    fxRate: null,
    signal: new AbortController().signal,
    log: () => {},
  };

  // 1. A successful two-page crawl: page 1 has both products, page 2 is empty.
  const twoPage = fakeWooTransport({ pages: [[tote, linenShirt], []] });
  const outcome = await crawlShop({ ...baseInput, limit: 100, transport: twoPage.transport });

  check(
    "products come back mapped",
    outcome.products.map((product) => product.slug).sort().join(",") === "cotton-tote,linen-shirt",
    JSON.stringify(outcome.products.map((product) => product.slug)),
  );

  /*
   * Asserted on the recorded requests, not the product count: a crawl that kept
   * paging past the empty page would still yield 2 products, since nothing
   * would be there to add to them.
   */
  check(
    "paging stopped on the empty page",
    twoPage.asked.length === 5 &&
      twoPage.asked[1].includes("page=1") &&
      twoPage.asked[4].includes("page=2"),
    JSON.stringify(twoPage.asked),
  );

  // 3. One request per variation.
  check(
    "one variation request per variation",
    twoPage.asked.some((url) => /\/wp-json\/wc\/store\/v1\/products\/45$/.test(new URL(url).pathname)),
    JSON.stringify(twoPage.asked),
  );

  // 2. ctx.limit stops mid-page: two simple products on one page, limit 1.
  const secondTote: WooProduct = { ...tote, id: 22, slug: "cotton-tote-b", name: "Cotton Tote B" };
  const limited = fakeWooTransport({ pages: [[tote, secondTote]] });
  const cappedOutcome = await crawlShop({ ...baseInput, limit: 1, transport: limited.transport });
  check("ctx.limit stops mid-page", cappedOutcome.products.length === 1, String(cappedOutcome.products.length));

  // 4. A variation that 404s is skipped; the product still publishes.
  const partialFail = fakeWooTransport({
    pages: [[linenShirt], []],
    variations: { 46: { status: 404 } },
  });
  const partialOutcome = await crawlShop({ ...baseInput, limit: 100, transport: partialFail.transport });
  const partialShirt = partialOutcome.products.find((product) => product.slug === "linen-shirt");
  check("the product still publishes despite a failed variation", partialShirt !== undefined);
  check(
    "the failed variation is skipped, one fewer than the raw count",
    (partialShirt?.variations ?? []).length === 1,
    JSON.stringify(partialShirt?.variations),
  );

  // 5. Every variation failing degrades the product to simple, at the parent's price.
  const allFail = fakeWooTransport({
    pages: [[linenShirt], []],
    variations: { 45: { status: 404 }, 46: { status: 404 } },
  });
  const degradedOutcome = await crawlShop({ ...baseInput, limit: 100, transport: allFail.transport });
  const degraded = degradedOutcome.products.find((product) => product.slug === "linen-shirt");
  check("every variation failing degrades the product to simple", degraded?.type === "simple", String(degraded?.type));
  /*
   * "59.00" is not invented: it comes straight from `linenShirt.prices.regular_price`
   * ("5900", the fixture's own Store API answer for the PARENT product), read through
   * the same `variations.length === 0` branch in `toProduct` that a genuinely simple
   * product goes through. Nothing here fabricates a price for a variable product that
   * lost all its variations — the parent's own price is real API data.
   */
  check(
    "the degraded price is the parent's own, not invented",
    degraded?.regular_price === "59.00",
    String(degraded?.regular_price),
  );

  // 6. Distinguish a 404 on the products endpoint from any other status.
  const productsOff = fakeWooTransport({ productsStatus: 404 });
  await refusesAsync(
    "a 404 on the products endpoint says the Store API is off",
    () => crawlShop({ ...baseInput, limit: 100, transport: productsOff.transport }),
    /Store API.*turned off/i,
  );

  const productsBroken = fakeWooTransport({ productsStatus: 500 });
  await refusesAsync(
    "any other status gives the generic message",
    () => crawlShop({ ...baseInput, limit: 100, transport: productsBroken.transport }),
    /Store API answered 500/i,
  );
}

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

async function main(): Promise<void> {
  moneyTests();
  robotsTests();
  shopifyTests();
  wooTests();
  magentoTests();
  await transportTests();
  await orchestratorTests();
  await wooOrchestratorTests();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

export { check, refuses };

main().catch((error) => {
  console.error(error instanceof CrawlMoneyError ? error.message : error);
  process.exitCode = 1;
});
