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

import { CrawlMoneyError, convert, fromMinorUnits } from "../lib/sources/crawl/money";
import { CRAWLER_USER_AGENT, parseRobots } from "../lib/sources/crawl/robots";

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
}

async function main(): Promise<void> {
  moneyTests();
  robotsTests();

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
