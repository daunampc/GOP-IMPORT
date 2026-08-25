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

async function main(): Promise<void> {
  moneyTests();
  robotsTests();
  shopifyTests();

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
