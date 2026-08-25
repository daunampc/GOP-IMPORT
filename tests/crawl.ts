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

import { CrawlMoneyError, convert, fromDecimal, fromMinorUnits } from "../lib/sources/crawl/money";
import { CRAWLER_USER_AGENT, parseRobots } from "../lib/sources/crawl/robots";
import { fullSizeImage, toProduct, type ShopifyProduct } from "../lib/sources/crawl/adapters/shopify";
import { serverTransport } from "../lib/sources/crawl/transport";
import { crawlShop } from "../lib/sources/crawl";

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

  check("convert rounds to 2dp", convert("10.00", 25400) === "254000.00", convert("10.00", 25400));
  check("convert keeps precision", convert("19.99", 0.5) === "10.00", convert("19.99", 0.5));
  refuses("a zero rate", () => convert("10.00", 0), /rate/i);

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

async function transportTests(): Promise<void> {
  console.log("\nTransport");

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

    return {
      asked,
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
}

async function main(): Promise<void> {
  moneyTests();
  robotsTests();
  shopifyTests();
  await transportTests();
  await orchestratorTests();

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
