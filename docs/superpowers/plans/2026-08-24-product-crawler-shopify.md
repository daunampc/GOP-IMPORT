# Product Crawler (Shopify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Tiếng Việt — phạm vi.** Đây là **kế hoạch thứ nhất trong ba**, ứng với bước 1–5 ở §10
> của `docs/superpowers/specs/2026-08-24-product-crawler-source-design.md`. Làm xong là
> crawl được shop Shopify rồi import thẳng bằng wizard đang có. **KHÔNG** có Playwright,
> **KHÔNG** có Etsy/Magento/generic, **KHÔNG** có extension — ba thứ đó thuộc kế hoạch 2
> và 3. Bản kế hoạch viết bằng tiếng Anh vì nó gần như toàn code và lệnh shell, mà quy ước
> repo là code và comment phải tiếng Anh.

**Goal:** Crawl a Shopify storefront into the existing import pipeline, so a shop URL reaches the same preview → wizard → worker → plugin path that a CSV does.

**Architecture:** A new source under `lib/sources/crawl/` emits `Product[]` (from `lib/gop-client.ts`) exactly as `lib/sources/csv.ts` does. Crawling runs on the worker as a fourth job kind (`"crawl"`), writing its products to `job_item`; `lib/build-products.ts` gains a `fromCrawl` branch that reads them back, so `applyOptions`, the preview, the wizard and the import job are untouched.

**Tech Stack:** TypeScript, Next.js 16.3.1 (App Router), Drizzle + Postgres, BullMQ + Redis, zod, tsx for tests.

## Global Constraints

- **Code, code comments and all UI copy are English.** Only `docs/` is Vietnamese. Copied verbatim from the spec header.
- **Next.js 16.3.1 is not the Next.js you know.** Per `AGENTS.md`, read the relevant guide in `node_modules/next/dist/docs/` before writing route or page code.
- **No new npm dependency in this plan.** robots.txt parsing is hand-rolled (~60 lines, tested) rather than adding `robots-parser`, matching how `lib/sources/csv-dialect.ts` hand-rolls dialect detection.
- **Every outbound crawl fetch goes through `assertFetchableUrl()`** (`lib/outbound-url.ts:286`). No exceptions, including URLs the adapter builds itself. Spec §7.1.
- **robots.txt disallow is a hard refuse.** No override flag. Spec §7.2.
- **No anti-detection of any kind**: no stealth, no fingerprint spoofing, no user-agent rotation, no CAPTCHA solving. Spec §7.3 and §12.7.
- **Minor units are never hard-coded to 100.** VND and JPY have `minor_unit = 0`. Spec §4.1.
- **Prices are carried as decimal strings, never floats.** `Product.regular_price` accepts `number | string`; strings avoid binary-float drift on money.
- **Crawl ceiling** = `min(user's limit, account's maxProductsPerRun)` from `lib/limits.ts:26`. No new limit concept. Spec §7.4.
- Run `pnpm typecheck` before every commit. It is `tsc --noEmit`.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `lib/sources/crawl/types.ts` | `CrawlAdapter`, `CrawlContext`, `CrawlTransport`, `PlatformName`, `CrawlError`. Pure types + one error class. No I/O. |
| `lib/sources/crawl/money.ts` | Minor-unit decoding and optional FX. Pure arithmetic on strings. |
| `lib/sources/crawl/robots.ts` | Fetch + parse robots.txt, answer `isAllowed(path)`. |
| `lib/sources/crawl/transport.ts` | The server-side transport: SSRF guard, per-host delay, backoff, size/time ceilings. |
| `lib/sources/crawl/adapters/shopify.ts` | `/products.json` paging and the Shopify → `Product` mapping. |
| `lib/sources/crawl/index.ts` | Orchestrator: pick adapter, enforce robots, stream products, apply the ceiling. |
| `lib/crawl-options.ts` | `crawlOptionsSchema` + `CrawlOptions`. Sits beside `lib/import-options.ts` and, like it, must stay importable from Client Components. |
| `app/(app)/crawl/page.tsx` | Server Component: permission guard + shell. |
| `app/(app)/crawl/crawl-form.tsx` | Client Component: the form. |
| `app/api/crawl/route.ts` | `POST` — validate, check limits, enqueue the crawl run. |
| `tests/crawl.ts` | Fixture suite. No network, no Postgres, no Redis. |
| `tests/crawl.sh` | Runner for the above. |
| `tests/fixtures/crawl/shopify-products.json` | Two products: one simple, one variable. |
| `tests/fixtures/crawl/robots.txt` | Allow + disallow rules. |
| ~~`db/migrations/0017_*.sql`~~ | **Does not exist — see Task 6.** `kind` and `job_log.stage` are TS-level `text({ enum: [...] })` columns, not Postgres enums or `CHECK`s, so widening them generates no migration. |

**Modify:**

| Path | Change |
|---|---|
| `db/schema.ts:275` | Add `"crawl"` to the `kind` enum. |
| `db/schema.ts:461` | Add `"detect"`, `"discover"`, `"crawl"` to `job_log.stage`. |
| `lib/jobs.ts:33` | `JobKind` gains `"crawl"`. |
| `lib/jobs.ts:72` | `JobOptions` gains `CrawlOptions`. |
| `lib/jobs.ts:75-92` | Add `isCrawlRun`. |
| `lib/jobs.ts:281` | `EnqueueInput.storeId` becomes `string \| null`. |
| `lib/jobs.ts:334` | Insert `storeId` as-is (already nullable in the column). |
| `lib/jobs.ts` (new export) | `enqueueCrawl`. |
| `lib/job-display.ts:30-47` | Add `crawl` to the three `Record<JobKind, …>` maps. |
| `lib/build-products.ts:50,71` | `buildProductsFromRequest(request, ownerId)`; branch to `fromCrawl`. |
| `app/api/import/preview/route.ts:28` | Pass `guard.ownerId`. |
| `worker/index.ts:~250` | Dispatch `runCrawl` **before** the `getStoreUnscoped` lookup. |
| `worker/index.ts:279` | Verdict branch must not treat a crawl as a removal. |
| `app/api/jobs/[id]/schedule/route.ts:73` | Refuse a crawl. |
| `app/api/jobs/[id]/retry-failed/route.ts:69` | Refuse a crawl. |
| `app/(app)/process/[id]/job-detail-view.tsx:175` | Add the crawl branch + "Import these products". |
| `app/(app)/import/import-wizard.tsx:~639` | Step 1 accepts `?crawl=<jobId>`. |
| `components/shell/nav.ts` | Add the Crawl entry. |
| `package.json` | Add `"test:crawl": "./tests/crawl.sh"`. |

---

## Task 1: Money decoding

**Files:**
- Create: `lib/sources/crawl/money.ts`
- Create: `tests/crawl.ts`
- Create: `tests/crawl.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `fromMinorUnits(value: number | string, minorUnit: number): string`, `convert(amount: string, rate: number): string`, `CrawlMoneyError extends Error`.

- [ ] **Step 1: Write the failing test**

Create `tests/crawl.ts`. The `check`/`refuses` harness is copied deliberately from `tests/images-staging.ts:39-63` — this repo has no test framework and hand-rolls one per suite.

```ts
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

async function main(): Promise<void> {
  moneyTests();

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
```

Create `tests/crawl.sh`:

```bash
#!/usr/bin/env bash
#
# The crawler's pure parts: money, robots.txt, and the Shopify mapping.
#
#   ./tests/crawl.sh
#
# No Docker, no Postgres, no Redis, no fake host — unlike every other suite here.
# Everything it tests is a function over a saved fixture, so it runs in under a
# second and there is no reason for it ever to be skipped.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"
exec ./node_modules/.bin/tsx tests/crawl.ts
```

Then make it executable and register it:

```bash
chmod +x tests/crawl.sh
```

In `package.json`, add to `"scripts"` after `"test:cancel"`:

```json
    "test:crawl": "./tests/crawl.sh",
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./tests/crawl.sh`
Expected: FAIL — `Cannot find module '../lib/sources/crawl/money'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/sources/crawl/money.ts`:

```ts
/*
 * Money for the crawler.
 *
 * Do NOT import "server-only" here — the worker imports this, and so does the
 * test suite, which runs under plain tsx.
 */

/**
 * Prices are STRINGS all the way through, and that is not a style preference.
 *
 * `Product.regular_price` accepts `number | string`, and a float cannot hold
 * 19.99 exactly: `1999 / 100` is 19.989999999999998 on some values, and the
 * arithmetic that follows a currency conversion compounds it. A decimal string
 * built from integer arithmetic has no such failure mode, and the plugin parses
 * a string exactly as happily as a number.
 */

export class CrawlMoneyError extends Error {}

/**
 * An integer in a currency's smallest unit, as a decimal string.
 *
 * The `minorUnit` argument is the whole point of this function. Shopify sends
 * cents and dividing by 100 is right for USD, EUR and GBP — and WRONG for VND
 * and JPY, which have no minor unit at all, where it would report a 25,400 đ
 * product as 254 đ. WooCommerce's Store API states its own exponent in
 * `currency_minor_unit`; Shopify does not, so the Shopify adapter passes the
 * exponent for the currency it was told.
 */
export function fromMinorUnits(value: number | string, minorUnit: number): string {
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 4) {
    throw new CrawlMoneyError(`A currency's minor unit must be 0 to 4, not ${minorUnit}.`);
  }

  const raw = typeof value === "string" ? value.trim() : value;
  const amount = typeof raw === "string" ? Number(raw) : raw;

  if (!Number.isInteger(amount)) {
    throw new CrawlMoneyError(
      `A price in minor units must be a whole number, not ${JSON.stringify(value)}.`,
    );
  }

  if (minorUnit === 0) {
    return String(amount);
  }

  const negative = amount < 0;
  const digits = String(Math.abs(amount)).padStart(minorUnit + 1, "0");
  const whole = digits.slice(0, digits.length - minorUnit);
  const fraction = digits.slice(digits.length - minorUnit);

  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Multiply by an operator-entered exchange rate.
 *
 * Two decimal places out, because that is what a shop displays. The rate itself
 * is recorded on the run — see `lib/crawl-options.ts` — so the number here can
 * always be re-derived from what the operator actually typed.
 */
export function convert(amount: string, rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new CrawlMoneyError(`An exchange rate must be a positive number, not ${rate}.`);
  }

  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw new CrawlMoneyError(`Not a price: ${JSON.stringify(amount)}.`);
  }

  return (value * rate).toFixed(2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./tests/crawl.sh`
Expected: PASS, with a `Money` section and `0 failed` on the last line.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add lib/sources/crawl/money.ts tests/crawl.ts tests/crawl.sh package.json
git commit -m "feat(crawl): decode prices from a currency's minor units

Not a division by 100: VND and JPY have no minor unit, and dividing there
reports a 25,400 product as 254."
```

---

## Task 2: robots.txt

**Files:**
- Create: `lib/sources/crawl/robots.ts`
- Create: `tests/fixtures/crawl/robots.txt`
- Modify: `tests/crawl.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseRobots(text: string, userAgent: string): RobotsRules`, `RobotsRules { isAllowed(path: string): boolean; crawlDelayMs: number | null }`, `CRAWLER_USER_AGENT: string`.

- [ ] **Step 1: Write the failing test**

Create `tests/fixtures/crawl/robots.txt`:

```
User-agent: BadBot
Disallow: /

User-agent: *
Crawl-delay: 2
Disallow: /admin
Disallow: /cart
Allow: /products/allowed-anyway
Disallow: /products/
```

Append to `tests/crawl.ts` — add the import at the top:

```ts
import { CRAWLER_USER_AGENT, parseRobots } from "../lib/sources/crawl/robots";
```

and add this function, then call `robotsTests();` inside `main()` after `moneyTests();`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./tests/crawl.sh`
Expected: FAIL — `Cannot find module '../lib/sources/crawl/robots'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/sources/crawl/robots.ts`:

```ts
/*
 * robots.txt, hand-rolled.
 *
 * A dependency was considered and refused. `robots-parser` is 300 lines behind a
 * supply-chain surface, and this file needs exactly one behaviour beyond string
 * matching — longest-match-wins with Allow breaking the tie — which is the loop
 * at the bottom. `lib/sources/csv-dialect.ts` hand-rolls dialect detection for
 * the same reason, and this repo keeps its dependency list short on purpose.
 *
 * Do NOT import "server-only": the worker and the test suite both read this.
 */

/**
 * Honest, and with a way to be contacted.
 *
 * Not configurable, and not rotated. A crawler that lies about who it is cannot
 * be blocked by a site that wants to block it, and being blockable is the whole
 * of the good-citizen bargain. See §7.3 of the design.
 */
export const CRAWLER_USER_AGENT =
  "EasyobotCrawler/1.0 (+https://easyobot.com/crawler; product import on behalf of a site owner)";

export interface RobotsRules {
  isAllowed(path: string): boolean;
  /** From `Crawl-delay`, in milliseconds. `null` when the file does not say. */
  crawlDelayMs: number | null;
}

interface Rule {
  allow: boolean;
  path: string;
}

/**
 * Read the group that applies to `userAgent`, falling back to the `*` group.
 *
 * A specific group WINS OUTRIGHT over `*` — it does not merge with it. That is
 * what the standard says, and merging would let a site's rules for some other
 * crawler silently apply to this one.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const agent = userAgent.split("/")[0].toLowerCase();

  const groups = new Map<string, Rule[]>();
  const delays = new Map<string, number>();

  let active: string[] = [];
  // Consecutive `User-agent:` lines share one group; the first directive after
  // them ends the run of names.
  let namingAgents = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") {
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!namingAgents) {
        active = [];
        namingAgents = true;
      }
      active.push(value.toLowerCase());
      for (const name of active) {
        if (!groups.has(name)) {
          groups.set(name, []);
        }
      }
      continue;
    }

    namingAgents = false;

    if (active.length === 0) {
      continue;
    }

    if (field === "allow" || field === "disallow") {
      // An empty `Disallow:` is the documented way to say "nothing is blocked".
      // Recording it as a zero-length prefix would block the entire site.
      if (value === "") {
        continue;
      }
      for (const name of active) {
        groups.get(name)?.push({ allow: field === "allow", path: value });
      }
      continue;
    }

    if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        for (const name of active) {
          delays.set(name, seconds * 1000);
        }
      }
    }
  }

  const key = groups.has(agent) ? agent : "*";
  const rules = groups.get(key) ?? [];
  const crawlDelayMs = delays.get(key) ?? null;

  return {
    crawlDelayMs,
    isAllowed(path: string): boolean {
      let best: Rule | null = null;

      for (const rule of rules) {
        if (!path.startsWith(rule.path)) {
          continue;
        }
        // Longest match wins; Allow breaks a tie, which is what makes a specific
        // `Allow: /products/x` survive a broad `Disallow: /products/`.
        if (
          best === null ||
          rule.path.length > best.path.length ||
          (rule.path.length === best.path.length && rule.allow)
        ) {
          best = rule;
        }
      }

      return best === null ? true : best.allow;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./tests/crawl.sh`
Expected: PASS, with a `robots.txt` section added and `0 failed` on the last line.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add lib/sources/crawl/robots.ts tests/fixtures/crawl/robots.txt tests/crawl.ts
git commit -m "feat(crawl): parse robots.txt, longest match wins

Hand-rolled rather than a dependency: the only behaviour beyond string
matching is longest-match-wins with Allow breaking the tie."
```

---

## Task 3: Types and the Shopify mapping

**Files:**
- Create: `lib/sources/crawl/types.ts`
- Create: `lib/sources/crawl/adapters/shopify.ts`
- Create: `tests/fixtures/crawl/shopify-products.json`
- Modify: `tests/crawl.ts`

**Interfaces:**
- Consumes: `fromMinorUnits` (Task 1); `Product`, `ProductVariation` from `lib/gop-client.ts:39,53`.
- Produces:
  - `type PlatformName = "shopify" | "woocommerce" | "magento" | "etsy" | "generic"`
  - `interface CrawlTransport { fetchText(url: string): Promise<CrawlResponse> }`
  - `interface CrawlResponse { status: number; contentType: string; body: string }`
  - `interface CrawlContext { shopUrl: URL; transport: CrawlTransport; limit: number; imagesPerProduct: number; minorUnit: number; fxRate: number | null; log: (line: CrawlLogLine) => void; signal: AbortSignal }`
  - `interface CrawlAdapter { name: PlatformName; detect(input: DetectInput): number; fetchProducts(ctx: CrawlContext): AsyncGenerator<Product> }`
  - `class CrawlError extends Error`
  - `shopifyAdapter: CrawlAdapter`, and `toProduct(raw: ShopifyProduct, options: ShopifyMapOptions): Product` exported for the test.

- [ ] **Step 1: Write the failing test**

Create `tests/fixtures/crawl/shopify-products.json`. Trimmed from a real `/products.json` response — one simple product carrying Shopify's `Default Title` placeholder, one two-option variable product.

```json
{
  "products": [
    {
      "id": 1001,
      "title": "Enamel Mug",
      "handle": "enamel-mug",
      "body_html": "<p>Holds coffee.</p>",
      "vendor": "Northbound",
      "product_type": "Drinkware",
      "tags": ["kitchen", "gift"],
      "options": [{ "name": "Title", "values": ["Default Title"] }],
      "variants": [
        {
          "id": 5001,
          "title": "Default Title",
          "sku": "MUG-01",
          "price": "18.00",
          "compare_at_price": null,
          "available": true,
          "option1": "Default Title",
          "option2": null,
          "option3": null,
          "featured_image": null
        }
      ],
      "images": [
        { "id": 9001, "src": "https://cdn.shopify.com/s/files/1/mug_400x.jpg", "position": 1 },
        { "id": 9002, "src": "https://cdn.shopify.com/s/files/1/mug-side_grande.jpg", "position": 2 }
      ]
    },
    {
      "id": 1002,
      "title": "Camp Shirt",
      "handle": "camp-shirt",
      "body_html": "<p>Linen.</p>",
      "vendor": "Northbound",
      "product_type": "Shirts",
      "tags": [],
      "options": [
        { "name": "Size", "values": ["S", "M"] },
        { "name": "Colour", "values": ["Sand"] }
      ],
      "variants": [
        {
          "id": 5002,
          "title": "S / Sand",
          "sku": "SHIRT-S",
          "price": "64.00",
          "compare_at_price": "80.00",
          "available": true,
          "option1": "S",
          "option2": "Sand",
          "option3": null,
          "featured_image": { "src": "https://cdn.shopify.com/s/files/1/shirt-s_1024x1024.jpg" }
        },
        {
          "id": 5003,
          "title": "M / Sand",
          "sku": "SHIRT-M",
          "price": "64.00",
          "compare_at_price": null,
          "available": false,
          "option1": "M",
          "option2": "Sand",
          "option3": null,
          "featured_image": null
        }
      ],
      "images": [
        { "id": 9003, "src": "https://cdn.shopify.com/s/files/1/shirt_2048x2048.jpg", "position": 1 }
      ]
    }
  ]
}
```

Append to `tests/crawl.ts` — add the import:

```ts
import { fullSizeImage, toProduct, type ShopifyProduct } from "../lib/sources/crawl/adapters/shopify";
```

and this function, called from `main()` after `robotsTests();`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./tests/crawl.sh`
Expected: FAIL — `Cannot find module '../lib/sources/crawl/adapters/shopify'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/sources/crawl/types.ts`:

```ts
/*
 * The crawler's vocabulary.
 *
 * Types and one error class, no I/O — so an adapter can be unit-tested against a
 * saved fixture without a network, a browser or a database. That is the whole
 * reason `CrawlTransport` is an interface rather than a call to `fetch`.
 *
 * Do NOT import "server-only": the worker and the test suite both read this.
 */

import type { Product } from "../../gop-client";

export type PlatformName = "shopify" | "woocommerce" | "magento" | "etsy" | "generic";

export class CrawlError extends Error {}

export interface CrawlResponse {
  status: number;
  contentType: string;
  body: string;
}

/**
 * How an adapter reaches the outside world.
 *
 * An interface, not `fetch`, for two reasons that both matter later: the tests
 * substitute a fixture, and §12 of the design substitutes the customer's own
 * Chrome. Neither is possible if an adapter calls `fetch` directly.
 */
export interface CrawlTransport {
  fetchText(url: string): Promise<CrawlResponse>;
}

export interface CrawlLogLine {
  level: "info" | "warn" | "error";
  message: string;
  detail?: Record<string, unknown>;
}

export interface CrawlContext {
  shopUrl: URL;
  transport: CrawlTransport;
  /** Hard ceiling on products. Already the smaller of the form's and the account's. */
  limit: number;
  imagesPerProduct: number;
  /** Decimals in the source currency. 2 for USD, 0 for VND and JPY. */
  minorUnit: number;
  /** Operator-entered exchange rate, or null to publish the source numbers. */
  fxRate: number | null;
  log: (line: CrawlLogLine) => void;
  signal: AbortSignal;
}

export interface DetectInput {
  url: URL;
  headers: Record<string, string>;
  html: string;
}

export interface CrawlAdapter {
  name: PlatformName;
  /** Confidence from 0 to 1. The orchestrator picks the highest. */
  detect(input: DetectInput): number;
  fetchProducts(ctx: CrawlContext): AsyncGenerator<Product>;
}
```

Create `lib/sources/crawl/adapters/shopify.ts`:

```ts
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
import { convert, fromMinorUnits } from "../money";
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
   * Shopify's `/products.json` sends a DECIMAL string ("18.00"), unlike the AJAX
   * `/products/{handle}.js` endpoint, which sends integer cents. Reading the
   * decimal through `fromMinorUnits` would multiply the price by 100.
   *
   * So the decimal is re-encoded to minor units first, and the round trip is
   * deliberate: it is the one place that proves the number really was decimal,
   * and it keeps every price in this file on the same code path.
   */
  const minor = Math.round(Number(value) * 10 ** options.minorUnit);
  if (!Number.isFinite(minor)) {
    throw new CrawlError(`Shopify sent a price this crawler cannot read: ${JSON.stringify(value)}.`);
  }

  const decimal = fromMinorUnits(minor, options.minorUnit);
  return options.fxRate === null ? decimal : convert(decimal, options.fxRate);
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
  if (Number(original) <= Number(charged)) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./tests/crawl.sh`
Expected: PASS, with a `Shopify mapping` section added and `0 failed` on the last line.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add lib/sources/crawl/types.ts lib/sources/crawl/adapters/shopify.ts tests/fixtures/crawl/shopify-products.json tests/crawl.ts
git commit -m "feat(crawl): map Shopify products onto the Product type

Two Shopify quirks are handled here rather than downstream: the invented
'Title: Default Title' option means simple, not variable; and compare_at_price
is the REGULAR price while price is the sale price, so mapping them straight
across would make every discount permanent."
```

---

## Task 4: The server transport

**Files:**
- Create: `lib/sources/crawl/transport.ts`
- Modify: `tests/crawl.ts`

**Interfaces:**
- Consumes: `CrawlTransport`, `CrawlResponse`, `CrawlError` (Task 3); `assertFetchableUrl`, `OutboundUrlError` from `lib/outbound-url.ts:286,96`; `CRAWLER_USER_AGENT` (Task 2).
- Produces: `serverTransport(options: ServerTransportOptions): CrawlTransport`, `ServerTransportOptions { signal: AbortSignal; delayMs: number; maxBytes?: number; timeoutMs?: number }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/crawl.ts` — add the import:

```ts
import { serverTransport } from "../lib/sources/crawl/transport";
```

and this function, called from `main()` with `await transportTests();`:

```ts
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
}
```

and add this helper beside `refuses`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./tests/crawl.sh`
Expected: FAIL — `Cannot find module '../lib/sources/crawl/transport'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/sources/crawl/transport.ts`:

```ts
/*
 * Fetching, from this server.
 *
 * Everything an adapter asks for comes through here, which is what makes the
 * guarantees below true of the whole crawler rather than of whichever adapter
 * remembered them: the SSRF check, the delay between requests to one host, the
 * backoff, the size ceiling and the deadline.
 *
 * Do NOT import "server-only" — the worker imports this.
 */

import { assertFetchableUrl } from "../../outbound-url";
import { CRAWLER_USER_AGENT } from "./robots";
import { CrawlError, type CrawlResponse, type CrawlTransport } from "./types";

export interface ServerTransportOptions {
  signal: AbortSignal;
  /** Minimum gap between two requests to the same host. */
  delayMs: number;
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Retried statuses, and how long to wait before each attempt. */
const BACKOFF_MS = [1_000, 4_000, 10_000];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function serverTransport(options: ServerTransportOptions): CrawlTransport {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** When each host may next be asked for something. */
  const nextAllowedAt = new Map<string, number>();

  async function once(url: URL): Promise<CrawlResponse> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([options.signal, deadline]);

    const response = await fetch(url, {
      signal,
      redirect: "follow",
      headers: {
        "User-Agent": CRAWLER_USER_AGENT,
        Accept: "application/json, text/html;q=0.9, */*;q=0.5",
      },
    });

    /*
     * Read with a ceiling rather than calling `.text()`.
     *
     * `.text()` on a response with no `content-length` — a chunked one, which is
     * most of them — will happily buffer a gigabyte into the worker's heap, and
     * the worker is capped at 2G in ecosystem.config.js for every run at once.
     */
    const reader = response.body?.getReader();
    let body = "";

    if (reader !== undefined) {
      const decoder = new TextDecoder();
      let size = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new CrawlError(
            `${url.host} sent more than ${Math.round(maxBytes / 1024 / 1024)} MB for one request.`,
          );
        }

        body += decoder.decode(value, { stream: true });
      }

      body += decoder.decode();
    }

    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
    };
  }

  return {
    async fetchText(raw: string): Promise<CrawlResponse> {
      /*
       * THE guard. `assertFetchableUrl` resolves the hostname and inspects every
       * address behind it, which is the check this path needs: a crawler keeps
       * the body and follows redirects, so a public name pointing at 10.0.0.5 is
       * not a theoretical problem. See lib/outbound-url.ts.
       */
      const url = await assertFetchableUrl(raw);

      const wait = (nextAllowedAt.get(url.host) ?? 0) - Date.now();
      if (wait > 0) {
        await sleep(wait, options.signal);
      }

      let lastError: unknown = null;

      for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
        if (options.signal.aborted) {
          throw new CrawlError("The run was stopped.");
        }

        nextAllowedAt.set(url.host, Date.now() + options.delayMs);

        try {
          const response = await once(url);

          // 429 and 503 are the site asking for room. Anything else is an answer,
          // including a 404 the adapter needs to see.
          if (response.status !== 429 && response.status !== 503) {
            return response;
          }

          lastError = new CrawlError(`${url.host} answered ${response.status}.`);
        } catch (error) {
          lastError = error;
        }

        if (attempt < BACKOFF_MS.length) {
          await sleep(BACKOFF_MS[attempt], options.signal);
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new CrawlError(`${url.host} could not be read.`);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./tests/crawl.sh`
Expected: PASS, with a `Transport` section added and `0 failed` on the last line.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add lib/sources/crawl/transport.ts tests/crawl.ts
git commit -m "feat(crawl): one guarded transport for every crawl request

Routing every adapter fetch through here is what makes the SSRF check, the
per-host delay, the backoff and the size ceiling properties of the crawler
rather than of whichever adapter remembered them."
```

---

## Task 5: The orchestrator

**Files:**
- Create: `lib/sources/crawl/index.ts`
- Modify: `tests/crawl.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `crawlShop(input: CrawlInput): Promise<CrawlOutcome>`, `CrawlInput { shopUrl: string; platform: PlatformName | "auto"; limit: number; imagesPerProduct: number; minorUnit: number; fxRate: number | null; signal: AbortSignal; log: (line: CrawlLogLine) => void; transport?: CrawlTransport }`, `CrawlOutcome { platform: PlatformName; products: Product[]; warnings: string[] }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/crawl.ts` — add the import:

```ts
import { crawlShop } from "../lib/sources/crawl";
```

and this, called from `main()` with `await orchestratorTests();`:

```ts
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
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./tests/crawl.sh`
Expected: FAIL — `Cannot find module '../lib/sources/crawl'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/sources/crawl/index.ts`:

```ts
/*
 * The crawl, start to finish.
 *
 * Order matters and is the point of this file: robots.txt is read BEFORE any
 * product request goes out, so a disallowed store costs it one request and
 * nothing else. Everything after that is the adapter's business.
 *
 * Do NOT import "server-only" — the worker imports this.
 */

import type { Product } from "../../gop-client";
import { shopifyAdapter } from "./adapters/shopify";
import { CRAWLER_USER_AGENT, parseRobots } from "./robots";
import { serverTransport } from "./transport";
import {
  CrawlError,
  type CrawlAdapter,
  type CrawlLogLine,
  type CrawlTransport,
  type PlatformName,
} from "./types";

/**
 * Only Shopify, on purpose.
 *
 * The other four adapters are plan 2. An `auto` detection that can only ever
 * answer "shopify" would be a lie told by a lookup table, so `pickAdapter`
 * refuses a store it cannot serve rather than guessing.
 */
const ADAPTERS: ReadonlyArray<CrawlAdapter> = [shopifyAdapter];

/** How long to leave between two requests to the same host, unless robots says more. */
const DEFAULT_DELAY_MS = 300;

export interface CrawlInput {
  shopUrl: string;
  platform: PlatformName | "auto";
  limit: number;
  imagesPerProduct: number;
  minorUnit: number;
  fxRate: number | null;
  signal: AbortSignal;
  log: (line: CrawlLogLine) => void;
  /** Substituted by the tests. Production leaves it unset. */
  transport?: CrawlTransport;
}

export interface CrawlOutcome {
  platform: PlatformName;
  products: Product[];
  warnings: string[];
}

export async function crawlShop(input: CrawlInput): Promise<CrawlOutcome> {
  let shopUrl: URL;
  try {
    shopUrl = new URL(input.shopUrl);
  } catch {
    throw new CrawlError(`Not a web address: ${input.shopUrl}`);
  }

  if (shopUrl.protocol !== "https:" && shopUrl.protocol !== "http:") {
    throw new CrawlError("A shop address has to start with http:// or https://.");
  }

  const warnings: string[] = [];
  const transport =
    input.transport ?? serverTransport({ signal: input.signal, delayMs: DEFAULT_DELAY_MS });

  /*
   * robots.txt FIRST, before a single product request.
   *
   * A missing or unreadable robots.txt means "no rules", which is what the
   * standard says — not "block everything". Treating a 404 as a refusal would
   * make the crawler unable to read the majority of small shops.
   */
  const robotsUrl = new URL("/robots.txt", shopUrl);
  let rules = parseRobots("", CRAWLER_USER_AGENT);

  try {
    const response = await transport.fetchText(robotsUrl.toString());
    if (response.status === 200) {
      rules = parseRobots(response.body, CRAWLER_USER_AGENT);
    } else {
      input.log({
        level: "info",
        message: `No robots.txt (${response.status}), so no rules to follow.`,
      });
    }
  } catch (error) {
    warnings.push(
      `Could not read robots.txt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!rules.isAllowed("/products.json")) {
    throw new CrawlError(
      `${shopUrl.host} asks crawlers not to read its product list in robots.txt, so this run was ` +
        "refused. There is no way to override that here.",
    );
  }

  const adapter = pickAdapter(input.platform);

  input.log({
    level: "info",
    message: `Reading ${shopUrl.host} as ${adapter.name}.`,
    detail: { platform: adapter.name, crawlDelayMs: rules.crawlDelayMs },
  });

  const products: Product[] = [];

  for await (const product of adapter.fetchProducts({
    shopUrl,
    transport:
      input.transport ??
      serverTransport({
        signal: input.signal,
        // A site that asks for more room gets it. Never less than our own floor.
        delayMs: Math.max(DEFAULT_DELAY_MS, rules.crawlDelayMs ?? 0),
      }),
    limit: input.limit,
    imagesPerProduct: input.imagesPerProduct,
    minorUnit: input.minorUnit,
    fxRate: input.fxRate,
    log: input.log,
    signal: input.signal,
  })) {
    products.push(product);
  }

  return { platform: adapter.name, products, warnings };
}

function pickAdapter(platform: PlatformName | "auto"): CrawlAdapter {
  if (platform === "auto") {
    /*
     * Detection needs the homepage, and with one adapter in the list it could
     * only ever answer "shopify". Rather than dress that up as a decision, this
     * build asks. Plan 2 replaces this with a real scored detect().
     */
    throw new CrawlError(
      "Automatic platform detection arrives with the other adapters. Choose Shopify for now.",
    );
  }

  const adapter = ADAPTERS.find((candidate) => candidate.name === platform);

  if (adapter === undefined) {
    throw new CrawlError(
      `This build can only read Shopify stores. ${platform} support is not in it yet.`,
    );
  }

  return adapter;
}

export { CrawlError } from "./types";
export type { CrawlLogLine, PlatformName } from "./types";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./tests/crawl.sh`
Expected: PASS, with an `Orchestrator` section added and `0 failed` on the last line.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add lib/sources/crawl/index.ts tests/crawl.ts
git commit -m "feat(crawl): orchestrate a crawl, robots.txt before anything else

A disallowed store costs one request and stops. There is no override, and
pickAdapter refuses a platform this build cannot read rather than guessing."
```

---

## Task 6: Crawl options and the fourth job kind

**Files:**
- Create: `lib/crawl-options.ts`
- Modify: `db/schema.ts:275`, `db/schema.ts:461`
- Modify: `lib/jobs.ts:33,72,92,281,334`
- Modify: `lib/job-display.ts:30-47`
- Modify: `app/api/jobs/[id]/schedule/route.ts:73`
- Modify: `app/api/jobs/[id]/retry-failed/route.ts:69`
- ~~Create: `db/migrations/0017_*.sql` (generated)~~ — does not happen, see Step 6.

**Interfaces:**
- Consumes: `PlatformName` (Task 3).
- Produces: `crawlOptionsSchema`, `type CrawlOptions`, `DEFAULT_CRAWL_OPTIONS`, `isCrawlRun(job: JobState)`, `enqueueCrawl(input)`.

- [ ] **Step 1: Write the crawl options module**

Create `lib/crawl-options.ts`. It mirrors `lib/import-options.ts` and, like it, must stay importable from a Client Component — so no `server-only`, no database import.

```ts
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

/**
 * Decimals in a currency. Wrong by one is a price wrong by ten.
 *
 * Only the zero-decimal currencies need naming; everything else is two. The
 * three-decimal currencies (KWD, BHD, OMR) are listed because a Shopify store
 * quoting them would otherwise be read as a hundredth of its real price.
 */
const ZERO_DECIMAL = new Set(["VND", "JPY", "KRW", "CLP", "ISK", "PYG", "RWF", "UGX", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function minorUnitFor(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL.has(code)) {
    return 0;
  }
  if (THREE_DECIMAL.has(code)) {
    return 3;
  }
  return 2;
}
```

- [ ] **Step 2: Widen the enums**

In `db/schema.ts`, at line 275, change the `kind` column:

```ts
    kind: text("kind", { enum: ["import", "purge", "update", "crawl"] })
      .notNull()
      .default("import"),
```

At line 461, add the three crawl stages to `job_log.stage`:

```ts
    stage: text("stage", {
      enum: [
        "run",
        "limits",
        "s3",
        "images",
        "batch",
        "plugin",
        "cancel",
        "transients",
        "notify",
        "finish",
        "detect",
        "discover",
        "crawl",
      ],
    }).notNull(),
```

Also update the schedules table at `db/schema.ts:757` so its `kind` enum stays a subset — a crawl is never scheduled, so it must NOT gain the member. Leave it exactly as it is, and confirm with:

```bash
sed -n 755,760p db/schema.ts
```

Expected: the enum still reads `["import", "purge", "update"]`.

- [ ] **Step 3: Update the job types**

In `lib/jobs.ts` line 33:

```ts
export type JobKind = "import" | "purge" | "update" | "crawl";
```

Line 72, add `CrawlOptions` to the union and import it at the top of the file:

```ts
import { type CrawlOptions } from "./crawl-options";
```

```ts
export type JobOptions = ImportOptions | PurgeOptions | EditOptions | CrawlOptions;
```

After `isEditRun` (line 90-92), add:

```ts
/**
 * A crawl READS a shop; it does not write to one.
 *
 * Which is why `storeId` is empty on these runs and every screen that resolves a
 * target site has to tolerate that. See `enqueueCrawl`.
 */
export function isCrawlRun(job: JobState): job is JobState & { options: CrawlOptions } {
  return job.kind === "crawl";
}
```

Line 281, `EnqueueInput.storeId`:

```ts
  /**
   * The site this run targets, or `null` for a crawl, which has none.
   *
   * The column has always been nullable — a deleted site sets it null rather
   * than deleting the run's history — so `toState` already reads it back as `""`
   * and every screen already handles a run with no site.
   */
  storeId: string | null;
```

Line 334 needs no change: `storeId: input.storeId` already passes the value straight through, and the column is nullable.

After `enqueueEdit` (around line 411-430), add:

```ts
/**
 * A crawl.
 *
 * `items` is EMPTY at creation, and that is the difference from every other run
 * here: the other three are handed their payload and send it, while a crawl goes
 * and finds one. `job_item` is written again by the worker when it has products,
 * which is what `fromCrawl` in `lib/build-products.ts` then reads back.
 *
 * `storeId` is null because there is no target site. `storeUrl` and `storeLabel`
 * carry the shop being READ, which keeps the run list's "which site did this
 * touch" column meaningful rather than blank.
 */
export async function enqueueCrawl(
  input: Omit<EnqueueInput, "items" | "options" | "kind" | "storeId"> & {
    options: CrawlOptions;
  },
): Promise<JobState> {
  return enqueueJob({ ...input, kind: "crawl", storeId: null, items: [] });
}
```

- [ ] **Step 4: Update the display maps — these are the compile errors that matter**

In `lib/job-display.ts`, the three records at lines 30-47. `Record<JobKind, …>` will not compile until every one has the new member, which is the only automatic safety net for this change:

```ts
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  import: "Import",
  purge: "Removal",
  update: "Bulk edit",
  crawl: "Crawl",
};

export const JOB_KIND_ICONS: Record<JobKind, "upload" | "trash" | "refresh" | "download"> = {
  import: "upload",
  purge: "trash",
  update: "refresh",
  crawl: "download",
};

export const JOB_KIND_TONES: Record<JobKind, "neutral" | "bad" | "warn"> = {
  import: "neutral",
  purge: "bad",
  // Warn rather than neutral: it wrote over products that were already on sale.
  update: "warn",
  // Neutral: a crawl reads, and writes nothing to anybody's shop.
  crawl: "neutral",
};
```

- [ ] **Step 5: Run the audit the schema demands**

`db/schema.ts:266` records that adding the third kind produced no compile errors and silently mislabelled runs. Run the grep and fix each site.

Run:

```bash
grep -rn 'kind === "purge"\|kind === "update"\|kind === "import"\|isPurgeRun\|isImportRun\|isEditRun' app lib worker components
```

Expected: 19 matches. Handle them as follows.

In `app/api/jobs/[id]/schedule/route.ts`, after the guard block ending at line 71 and before the `state.kind === "import"` branch at line 73, insert:

```ts
  /*
   * A crawl cannot be scheduled.
   *
   * Not an oversight and not a limitation to lift later: a schedule re-runs a
   * payload, and a crawl has none — it goes and finds one. Repeating a crawl
   * nightly is a different feature with a different meaning, and letting this
   * route accept one would create a series that quietly produced a new preview
   * nobody asked for.
   */
  if (state.kind === "crawl") {
    return Response.json({ error: "A crawl cannot be scheduled." }, { status: 400 });
  }
```

In `app/api/jobs/[id]/retry-failed/route.ts`, immediately before line 53 (`const store = await getStoreUnscoped(job.storeId);`), insert:

```ts
  // A crawl has no per-row results, so there is nothing to retry. It also has no
  // target site, and the lookup below would fail on it.
  if (job.kind === "crawl") {
    return Response.json({ error: "A crawl has no rows to retry." }, { status: 400 });
  }
```

`app/(app)/remove/page.tsx:24` filters on `kind === "import"`, so a crawl is already excluded. Confirm by reading it:

```bash
sed -n 22,28p 'app/(app)/remove/page.tsx'
```

Expected: the filter reads `job.kind === "import" && job.succeeded > 0`. No change.

`app/(app)/process/[id]/job-detail-view.tsx` is handled in Task 9.
`worker/index.ts` is handled in Task 7.

- [ ] **Step 6: Generate and apply the migration**

> **This step turned out to be wrong — read before running it.** `db/schema.ts:266`
> already carries a warning, written by whoever added the third `kind` member, that
> says plainly: *"A TS-level enum, not a Postgres one, so adding a member needs no
> migration."* `kind` and `job_log.stage` are `text(..., { enum: [...] })` columns —
> a TypeScript-level string union, not a Postgres `CHECK` or a `pgEnum` — so widening
> either array is a type-level change only. Running `pnpm db:generate` after this
> step's edits produces **no new file**: Drizzle has nothing to diff, because nothing
> in the actual database schema changed. Do not expect a `db/migrations/0017_*.sql`
> to appear, and do not run `pnpm db:migrate` for this step — there is nothing to
> apply, and the database must not be touched. Confirmed during implementation: no
> migration file exists in `db/migrations/`, and `job`/`job_log` row counts were the
> same before and after this task.

Run, only to confirm the expectation above:

```bash
pnpm db:generate
```

Expected: no new migration file. If one *does* appear, stop and read it before applying anything — that would mean this column stopped being TS-only, which is not what this task changed.

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm typecheck
```

Expected: PASS. If `JOB_KIND_*` errors appear, a record is missing the `crawl` member — that is this change working as designed.

```bash
./tests/crawl.sh
git add lib/crawl-options.ts db/schema.ts lib/jobs.ts lib/job-display.ts lib/schedules.ts 'app/api/jobs/[id]/schedule/route.ts' 'app/api/jobs/[id]/retry-failed/route.ts'
git commit -m "feat(crawl): a fourth job kind, and the audit the schema asks for

db/schema.ts:266 records that adding the third kind produced no compile
errors and silently rendered a bulk edit as an import. Every kind branch was
grepped: schedule and retry-failed now refuse a crawl outright, because a
crawl has no payload to repeat and no rows to retry."
```

---

## Task 7: runCrawl on the worker

**Files:**
- Modify: `worker/index.ts` (insert `runCrawl` and dispatch it before the store lookup at line 252)

**Interfaces:**
- Consumes: `crawlShop`, `CrawlError` (Task 5); `minorUnitFor`, `CrawlOptions` (Task 6); `isCrawlRun` (Task 6).
- Produces: `runCrawl(state: JobState): Promise<void>` (module-private).

- [ ] **Step 1: Add the imports**

At the top of `worker/index.ts`, beside the existing `lib/` imports:

```ts
import { crawlShop } from "../lib/sources/crawl";
import { CrawlError } from "../lib/sources/crawl/types";
import { minorUnitFor, type CrawlOptions } from "../lib/crawl-options";
import { db } from "../db";
import { jobItems, jobs as jobsTable } from "../db/schema";
```

Check first whether `db`, `jobItems` and `jobsTable` are already imported in this file, and if so do not import them twice:

```bash
grep -n "from \"../db\"\|from \"../db/schema\"" worker/index.ts
```

- [ ] **Step 2: Dispatch the crawl before the store lookup**

This position is load-bearing. `worker/index.ts:252` calls `getStoreUnscoped(state.storeId)` and fails the run when it returns null — which is exactly what a crawl's empty `storeId` would produce. So the crawl must return before that line.

Insert immediately after the schedule block closes (the `}` ending the `if (state.scheduleId !== null)` block, around line 249) and **before** `const store = await getStoreUnscoped(state.storeId);`:

```ts
  /*
   * A CRAWL LEAVES HERE, before the target-site lookup.
   *
   * Position is the whole comment. A crawl has no target site, so `storeId` is
   * empty and `getStoreUnscoped` below returns null — which that code correctly
   * reads as "the site was deleted" and fails the run. Everything from here down
   * is about writing to a shop, and a crawl only reads one.
   */
  if (state.kind === "crawl") {
    const controller = new AbortController();
    inFlight.set(jobId, controller);

    try {
      await runCrawl(state, controller.signal);
    } finally {
      inFlight.delete(jobId);
    }
    return;
  }
```

- [ ] **Step 3: Keep the permissions branch honest**

At line 279 the verdict falls through to `removeVerdict` for anything that is not an import or an update. A crawl must not be checked against the removal permission. Because Step 2 returns before this point, the branch is now unreachable for a crawl — but the fall-through is exactly the shape `db/schema.ts:266` warns about, so make it explicit. Change the final `: await removeVerdict(state.createdBy);` to:

```ts
        : state.kind === "purge"
          ? await removeVerdict(state.createdBy)
          : /*
             * Exhaustive on purpose. A crawl returns above and never reaches
             * this, and a fifth kind must not silently inherit the removal
             * permission the way a crawl would have.
             */
            (() => {
              throw new Error(`No permission check defined for a run of kind "${state.kind}".`);
            })();
```

- [ ] **Step 4: Write runCrawl**

Add this function after `runPurge` (which ends around line 1088), before `runBatches`:

```ts
/**
 * A crawl: read a shop, and stage what was found.
 *
 * The odd one out among the four run kinds, and worth stating why. The other
 * three are handed a payload and send it to a site; this one is handed a URL and
 * comes back with a payload. So it writes `job_item` at the END rather than
 * reading it at the start, and it finishes without having touched anybody's shop.
 *
 * The products it stages are read back by `fromCrawl` in `lib/build-products.ts`
 * when the operator carries them into the import wizard.
 */
async function runCrawl(state: JobState, signal: AbortSignal): Promise<void> {
  const jobId = state.id;
  const options = state.options as CrawlOptions;

  await markRunning(jobId);

  if (options.transport === "browser") {
    const message =
      "This run asked to crawl through the customer's own Chrome, which this build cannot do yet.";
    await logJob(jobId, { level: "error", stage: "crawl", message });
    await settleRun(jobId, "failed", message);
    return;
  }

  /*
   * The account's ceiling, applied here as well as at the route.
   *
   * Both, and for the same reason the import path checks twice: the route gives
   * an immediate refusal, and this catches a limit lowered between queueing and
   * running.
   */
  const limits = await limitsFor(state.createdBy);
  const ceiling =
    limits.maxProductsPerRun === null
      ? options.limit
      : Math.min(options.limit, limits.maxProductsPerRun);

  if (ceiling < options.limit) {
    await logJob(jobId, {
      level: "warn",
      stage: "limits",
      message: `This account is capped at ${limits.maxProductsPerRun} products per run, so the crawl will stop there.`,
      detail: { asked: options.limit, ceiling },
    });
  }

  const warnings: string[] = [];

  try {
    const outcome = await crawlShop({
      shopUrl: options.shopUrl,
      platform: options.platform,
      limit: ceiling,
      imagesPerProduct: options.imagesPerProduct,
      minorUnit: minorUnitFor(options.sourceCurrency),
      fxRate: options.fxRate,
      signal,
      log: (line) => {
        // Fire and forget: a log line must never be able to fail a crawl.
        void logJob(jobId, { level: line.level, stage: "crawl", message: line.message, detail: line.detail });
        if (line.level === "warn") {
          warnings.push(line.message);
        }
      },
    });

    if (signal.aborted) {
      await logJob(jobId, {
        level: "warn",
        stage: "cancel",
        message: `Stopped after reading ${outcome.products.length} product(s). Nothing was staged.`,
      });
      await settleRun(jobId, "cancelled", null);
      return;
    }

    if (options.fxRate !== null) {
      await logJob(jobId, {
        stage: "crawl",
        message:
          `Prices converted ${options.sourceCurrency} → ${options.fxTarget || "target"} at ` +
          `${options.fxRate} — a rate entered by the operator, not looked up.`,
        detail: { rate: options.fxRate, from: options.sourceCurrency, to: options.fxTarget },
      });
    }

    // The payload the wizard will read back. Written before the run is marked
    // complete, so a "completed" crawl always has its products.
    await db
      .insert(jobItems)
      .values({ jobId, items: outcome.products })
      .onConflictDoUpdate({ target: jobItems.jobId, set: { items: outcome.products } });

    await db
      .update(jobsTable)
      .set({ total: outcome.products.length, processed: outcome.products.length, succeeded: outcome.products.length })
      .where(eq(jobsTable.id, jobId));

    await logJob(jobId, {
      stage: "finish",
      message: `Read ${outcome.products.length} product(s) from ${options.shopUrl}.`,
      detail: { platform: outcome.platform, total: outcome.products.length, warnings: warnings.length },
    });

    await settleRun(jobId, "completed", null);
  } catch (error) {
    /*
     * A CrawlError is a sentence for the operator — "robots.txt says no",
     * "password protected", "this needs the browser crawler" — so it is shown as
     * written. Anything else is a bug and is reported as one rather than dressed
     * up as advice.
     */
    const message =
      error instanceof CrawlError
        ? error.message
        : `The crawl failed: ${error instanceof Error ? error.message : String(error)}`;

    await logJob(jobId, { level: "error", stage: "crawl", message });
    await settleRun(jobId, "failed", message);
  }
}
```

- [ ] **Step 5: Verify the imports resolve and nothing else broke**

Run: `pnpm typecheck`
Expected: PASS.

If `limitsFor`, `markRunning`, `settleRun`, `logJob` or `eq` are not already imported in `worker/index.ts`, add them. Check with:

```bash
grep -n "limitsFor\|markRunning\|settleRun\|^import" worker/index.ts | head -30
```

- [ ] **Step 6: Commit**

```bash
./tests/crawl.sh
pnpm typecheck
git add worker/index.ts
git commit -m "feat(crawl): run a crawl on the worker

Dispatched before the target-site lookup, and that position is the point: a
crawl has no target site, so the lookup would read its empty storeId as a
deleted site and fail the run."
```

---

## Task 8: The crawl route and page

**Files:**
- Create: `app/api/crawl/route.ts`
- Create: `app/(app)/crawl/page.tsx`
- Create: `app/(app)/crawl/crawl-form.tsx`
- Modify: `components/shell/nav.ts`

**Interfaces:**
- Consumes: `crawlOptionsSchema`, `DEFAULT_CRAWL_OPTIONS`, `CRAWL_PLATFORMS`, `CRAWL_PLATFORM_LABELS` (Task 6); `enqueueCrawl` (Task 6).
- Produces: `POST /api/crawl` → `{ jobId: string }` on 200.

- [ ] **Step 1: Read the Next.js 16 route and page guides**

Per `AGENTS.md`, this version differs from training data. Before writing either file:

```bash
ls node_modules/next/dist/docs/
```

Read the route-handler and page guides listed there. Note in particular how `params` and `searchParams` are typed in this version — the existing `app/api/jobs/[id]/route.ts` is the in-repo reference.

- [ ] **Step 2: Write the route**

Create `app/api/crawl/route.ts`, modelled on `app/api/purge/route.ts` for its guard-then-limit-then-enqueue shape:

```ts
import { crawlOptionsSchema } from "@/lib/crawl-options";
import { enqueueCrawl } from "@/lib/jobs";
import { limitsFor } from "@/lib/limits";
import { apiRequireView } from "@/lib/view";

/**
 * Start a crawl.
 *
 * Thin on purpose: it validates, checks the account's ceiling so the refusal is
 * immediate and actionable, and queues. Everything that takes time happens on the
 * worker, which is why this returns a run id rather than products.
 */
export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "That request was not valid JSON." }, { status: 400 });
  }

  const parsed = crawlOptionsSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const options = parsed.data;

  if (options.transport === "browser") {
    return Response.json(
      { error: "Crawling through your own Chrome is not in this build yet." },
      { status: 400 },
    );
  }

  const limits = await limitsFor(guard.ownerId);
  if (!limits.importEnabled) {
    return Response.json(
      { error: "This account is not allowed to import products." },
      { status: 403 },
    );
  }

  let host: string;
  try {
    host = new URL(options.shopUrl).host;
  } catch {
    return Response.json({ error: "That is not a web address." }, { status: 400 });
  }

  const job = await enqueueCrawl({
    // The shop being READ. It is not a target site, but it is the site this run
    // talked to, which is what the run list's column means.
    storeUrl: options.shopUrl,
    storeLabel: host,
    sourceLabel: host,
    createdBy: guard.ownerId,
    options,
  });

  return Response.json({ jobId: job.id });
}
```

- [ ] **Step 3: Write the page and form**

Create `app/(app)/crawl/page.tsx`. Follow the shape of `app/(app)/remove/page.tsx` for the guard and shell:

```tsx
import { CrawlForm } from "./crawl-form";

export const metadata = { title: "Crawl" };

export default function CrawlPage() {
  return <CrawlForm />;
}
```

Create `app/(app)/crawl/crawl-form.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Card, Field, Input, Panel, Select } from "@/components/ui";
import {
  CRAWL_PLATFORMS,
  CRAWL_PLATFORM_LABELS,
  DEFAULT_CRAWL_OPTIONS,
} from "@/lib/crawl-options";

/**
 * Starting a crawl.
 *
 * Deliberately NOT a wizard. A crawl produces products; deciding what to do with
 * them is the import wizard's four steps, and duplicating any of them here would
 * mean two screens that have to agree about SKU generation and category rules.
 * This screen asks the only questions the crawl itself needs.
 */
export function CrawlForm() {
  const router = useRouter();

  const [shopUrl, setShopUrl] = useState("");
  const [platform, setPlatform] = useState<(typeof CRAWL_PLATFORMS)[number]>("shopify");
  const [limit, setLimit] = useState(String(DEFAULT_CRAWL_OPTIONS.limit));
  const [imagesPerProduct, setImagesPerProduct] = useState(
    String(DEFAULT_CRAWL_OPTIONS.imagesPerProduct),
  );
  const [sourceCurrency, setSourceCurrency] = useState(DEFAULT_CRAWL_OPTIONS.sourceCurrency);
  const [fxRate, setFxRate] = useState("");
  const [fxTarget, setFxTarget] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopUrl,
          platform,
          transport: "server",
          limit,
          imagesPerProduct,
          sourceCurrency,
          fxRate: fxRate.trim() === "" ? null : fxRate,
          fxTarget,
        }),
      });

      const payload = (await response.json()) as { jobId?: string; error?: string };

      if (!response.ok || payload.jobId === undefined) {
        setError(payload.error ?? "The crawl could not be started.");
        return;
      }

      // Straight to the run screen, which already streams the log.
      router.push(`/process/${payload.jobId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Crawl a shop" description="Read products from a store, then import them.">
      <Card>
        <Field label="Shop address" hint="For example https://example.myshopify.com">
          <Input
            value={shopUrl}
            onChange={(event) => setShopUrl(event.target.value)}
            placeholder="https://example.myshopify.com"
            autoFocus
          />
        </Field>

        <Field label="Platform" hint="Only Shopify is readable in this build.">
          <Select
            value={platform}
            onChange={(event) =>
              setPlatform(event.target.value as (typeof CRAWL_PLATFORMS)[number])
            }
          >
            {CRAWL_PLATFORMS.map((name) => (
              <option key={name} value={name} disabled={name !== "shopify"}>
                {CRAWL_PLATFORM_LABELS[name]}
                {name === "shopify" ? "" : " — not in this build"}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Stop after" hint="However many products, at most.">
          <Input value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" />
        </Field>

        <Field label="Images per product" hint="The rest are left behind.">
          <Input
            value={imagesPerProduct}
            onChange={(event) => setImagesPerProduct(event.target.value)}
            inputMode="numeric"
          />
        </Field>

        <Field
          label="Shop currency"
          hint="Decides how many decimals a price has. VND and JPY have none."
        >
          <Input
            value={sourceCurrency}
            onChange={(event) => setSourceCurrency(event.target.value.toUpperCase())}
            maxLength={3}
          />
        </Field>

        <Field
          label="Exchange rate (optional)"
          hint="Leave empty to publish the shop's own numbers. Nothing is looked up: the rate you type is the rate that is used, and it is recorded on the run."
        >
          <Input value={fxRate} onChange={(event) => setFxRate(event.target.value)} inputMode="decimal" />
        </Field>

        <Field label="Convert to" hint="Only a label for the log. Three letters.">
          <Input
            value={fxTarget}
            onChange={(event) => setFxTarget(event.target.value.toUpperCase())}
            maxLength={3}
          />
        </Field>

        {error === null ? null : <p role="alert">{error}</p>}

        <Button onClick={start} disabled={busy || shopUrl.trim() === ""}>
          {busy ? "Starting…" : "Start crawl"}
        </Button>
      </Card>
    </Panel>
  );
}
```

Before running, confirm the component names and props actually exported:

```bash
cat components/ui/index.ts
```

Adjust the imports and props above to match what is there. `Field`, `Input`, `Select`, `Button`, `Card` and `Panel` all exist; their prop names are what needs checking.

- [ ] **Step 4: Add the nav entry**

In `components/shell/nav.ts`, insert after the `/import` entry:

```ts
  {
    href: "/crawl",
    label: "Crawl",
    icon: "download",
    description: "Read products out of a shop, then import them",
    key: "8",
    publishing: true,
  },
```

Check that `key: "8"` is not already taken:

```bash
grep -n 'key: "' components/shell/nav.ts
```

If it is, use the next free digit.

- [ ] **Step 5: Verify it builds and runs**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm build`
Expected: a successful build listing `/crawl` and `/api/crawl` among the routes.

- [ ] **Step 6: Commit**

```bash
git add app/api/crawl 'app/(app)/crawl' components/shell/nav.ts
git commit -m "feat(crawl): a screen to start a crawl

Not a wizard: what to do with the products is the import wizard's job, and a
second screen making those decisions would be a second place that has to
agree about SKU generation and category rules."
```

---

## Task 9: Carrying a crawl into the import wizard

**Files:**
- Modify: `lib/build-products.ts:50,71` (+ new `fromCrawl`)
- Modify: `app/api/import/preview/route.ts:28`
- Modify: `app/(app)/process/[id]/job-detail-view.tsx:175`
- Modify: `app/(app)/import/import-wizard.tsx`

**Interfaces:**
- Consumes: `getJobProducts`, `getJobState`, `isCrawlRun` (`lib/jobs.ts:446,432`, Task 6).
- Produces: `buildProductsFromRequest(request: Request, ownerId: string): Promise<BuildResult>` — a changed signature; `app/api/import/preview/route.ts` is the only caller.

- [ ] **Step 1: Add the crawl branch to build-products**

In `lib/build-products.ts`, change the signature at line 50 and the source branch at line 71:

```ts
export async function buildProductsFromRequest(
  request: Request,
  /**
   * Who is asking. Required, and it is a security argument rather than a
   * convenience: `fromCrawl` reads a run's staged products by id, and without
   * the owner any signed-in account could name another account's crawl and walk
   * off with their catalogue.
   */
  ownerId: string,
): Promise<BuildResult> {
```

and, replacing `const source = await fromCsv(form, options);`:

```ts
  /*
   * Which source. A crawl id or a file — never both, and the id wins if somebody
   * sends both, because it is the more specific request.
   */
  const crawlJobId = form.get("crawlJobId");
  const source =
    typeof crawlJobId === "string" && crawlJobId.trim() !== ""
      ? await fromCrawl(crawlJobId.trim(), ownerId)
      : await fromCsv(form, options);
```

Add `fromCrawl` after `fromCsv`, and the imports it needs at the top of the file:

```ts
import { getJobProducts, getJobState } from "./jobs";
```

```ts
/**
 * Products a crawl already found.
 *
 * The whole reason the crawler is a SOURCE rather than a feature: from here down
 * a crawled product is indistinguishable from a CSV row, so `applyOptions`, the
 * preview, the review step and the import job need no idea that crawling exists.
 *
 * `dialect`, `columns` and `signature` are null and empty because they are CSV
 * facts. The wizard's column mapper keys off `columns`, and an empty list is
 * what makes it correctly not offer to map anything.
 */
async function fromCrawl(jobId: string, ownerId: string): Promise<SourceResult> {
  const job = await getJobState(jobId);

  if (job === null || job.createdBy !== ownerId || job.kind !== "crawl") {
    // One message for all three, on purpose: telling the difference between "no
    // such run" and "not yours" tells a caller whether an id exists.
    throw new BuildError("That crawl could not be found.", 404);
  }

  if (job.status !== "completed") {
    throw new BuildError(
      `That crawl is "${job.status}". Wait for it to finish before importing what it found.`,
    );
  }

  const products = await getJobProducts(jobId);

  if (products.length === 0) {
    throw new BuildError("That crawl found no products.");
  }

  return {
    products,
    sourceLabel: job.storeLabel,
    dialect: null,
    columns: [],
    signature: null,
    warnings: [],
    errors: [],
    skippedRows: 0,
  };
}
```

- [ ] **Step 2: Pass the owner from the preview route**

In `app/api/import/preview/route.ts` line 28:

```ts
    const built = await buildProductsFromRequest(request, guard.ownerId);
```

- [ ] **Step 3: Verify no other caller broke**

Run:

```bash
grep -rn "buildProductsFromRequest" app lib worker tests
```

Expected: two matches — the definition and the one call site above.

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Add the crawl view to the run detail screen**

In `app/(app)/process/[id]/job-detail-view.tsx`, after line 183 (`const edit = job.kind === "update";`) add:

```tsx
  const crawl = job.kind === "crawl";
```

Then guard the three sections that assume a target site and per-row results. Find where `purge` and `edit` are used to choose panels (line 175 onwards and line 974) and add `crawl` to the conditions so that, for a crawl, the screen hides the target-site block, the batch counters and the results table.

Add this panel, rendered when `crawl && job.status === "completed"`:

```tsx
{crawl && job.status === "completed" ? (
  <Card>
    <p>
      {job.total} product{job.total === 1 ? "" : "s"} read from {job.storeLabel}.
    </p>
    {/*
      * The handoff. Nothing is published by a crawl, so this button is the only
      * thing that turns a crawl into products in a shop — and it deliberately
      * goes through the ordinary import wizard rather than a shortcut, so the
      * same options, preview and image checks apply as to a CSV.
      */}
    <Button href={`/import?crawl=${job.id}`}>Import these products</Button>
  </Card>
) : null}
```

Check how `Button` renders a link in this codebase before using `href`:

```bash
grep -n "href" components/ui/button.tsx
```

If `Button` takes no `href`, wrap it in a `next/link` `<Link>` as the other screens do.

- [ ] **Step 5: Teach step 1 of the wizard to accept a crawl**

In `app/(app)/import/import-wizard.tsx`, read the crawl id from the URL and hold it in state beside the file. Add near the other `useState` calls (around line 146):

```tsx
  /*
   * A crawl already staged its products, so step 1 has nothing to read and no
   * columns to map. The id travels to the preview endpoint in place of the file;
   * `fromCrawl` in lib/build-products.ts is what reads it back.
   */
  const searchParams = useSearchParams();
  const crawlJobId = searchParams.get("crawl");
```

with the import:

```tsx
import { useSearchParams } from "next/navigation";
```

Where the preview form is built (line 386 area, `const form = new FormData()` before `fetch("/api/import/preview")`), send the id instead of the file:

```tsx
      if (crawlJobId !== null) {
        form.set("crawlJobId", crawlJobId);
      }
```

And where step 1 renders the dropzone (line 639, `{step === "source" ? (`), show a summary instead when `crawlJobId !== null`:

```tsx
        crawlJobId !== null ? (
          <Card>
            <p>Importing the products from a crawl.</p>
            <Link href="/crawl">Crawl a different shop</Link>
          </Card>
        ) : (
```

Finally, `sourceReady` (line 609) must be true for a crawl even though no file was chosen:

```tsx
    review: (sourceReady || crawlJobId !== null) && storesReady && preview !== null,
```

Read the surrounding code before editing — `canGo` has several members and `sourceReady` is used in more than one of them.

- [ ] **Step 6: Verify the whole path by hand**

There is no automated end-to-end for this; `tests/e2e.sh` needs a live plugin and MySQL. Verify manually:

```bash
pnpm dev
```

1. Open `/crawl`, enter a real Shopify store URL, set "Stop after" to 5, press Start.
2. You land on `/process/<id>`. The log shows `Reading <host> as shopify.` then `Read 5 product(s)…`.
3. Press "Import these products". The wizard opens at step 1 showing the crawl summary, not the dropzone.
4. Choose a site, accept the options, reach Review. Five products are listed with names, prices and images.

Expected at step 4: the review table is populated. If it is empty, the crawl id did not reach the preview endpoint — check the network tab for `crawlJobId` in the `POST /api/import/preview` body.

- [ ] **Step 7: Commit**

```bash
pnpm typecheck
./tests/crawl.sh
pnpm build
git add lib/build-products.ts app/api/import/preview/route.ts 'app/(app)/process/[id]/job-detail-view.tsx' 'app/(app)/import/import-wizard.tsx'
git commit -m "feat(crawl): carry a finished crawl into the import wizard

fromCrawl reads the staged products back, so from applyOptions downwards a
crawled product is indistinguishable from a CSV row. buildProductsFromRequest
now takes the owner, because reading a run's products by id without it would
let any signed-in account name another account's crawl."
```

---

## Task 10: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-24-product-crawler-source-design.md`

- [ ] **Step 1: Record what was built against what was designed**

The two existing specs in this repo are updated after implementation, and the image-download spec explains why: four things in its first draft were wrong, and *"một tài liệu sai còn tệ hơn không có tài liệu"* — a wrong document is worse than none. It marks each with a `> **Sửa so với bản đầu**` block.

Do the same. Add a status line under the spec's header:

```markdown
**Trạng thái: §1–§11 đã cài đặt xong (kế hoạch 1 — chỉ Shopify). §12 chưa làm.**
```

Then, for every place the implementation diverged from the design, add a block at that section:

```markdown
> **Sửa so với bản đầu**: <what the design said> → <what was actually built>, vì <lý do>.
```

Known candidates to check as you go:
- §4 says the adapter table has five adapters; plan 1 ships one.
- §8.1 lists a `platform: auto` option; `pickAdapter` refuses `auto` in this build.
- §3.2 says crawled products go in `job_item`; confirm that is what `runCrawl` does.

If nothing diverged, say so explicitly rather than leaving the reader to assume.

- [ ] **Step 2: Add the test to the README's test list**

Find where the other suites are listed and add:

```markdown
- `pnpm test:crawl` — the crawler's pure parts: money, robots.txt, the Shopify
  mapping. No Docker, no database, runs in a second.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/
git commit -m "docs: record what plan 1 of the crawler actually built"
```

---

## Self-Review Notes

Checked against the spec, §1–§11 (§12 is plan 3, out of scope):

| Spec | Task |
|---|---|
| §2 source, `SourceResult` shape | 9 |
| §2.1 `Product` mapping, Default Title | 3 |
| §3 `kind: "crawl"`, storeUrl/storeLabel | 6 |
| §3.1 the audit + `JOB_KIND_*` | 6 step 5 |
| §3.2 products in `job_item` | 7 |
| §3.3 same queue, `runCrawl` beside the others | 7 |
| §4 Shopify fast path, paging | 3 |
| §4.1 minor units, never /100 | 1 |
| §4.2 paging stops on empty, hard ceiling | 3, 5 |
| §5 browser gated off | 7 (fails `transport: "browser"`), 8 (route refuses) |
| §6 decode always, convert opt-in, rate recorded | 1, 6, 7 |
| §7.1 `assertFetchableUrl` on every fetch | 4 |
| §7.2 robots hard refuse | 2, 5 |
| §7.3 no CAPTCHA bypass | Nothing implements one; §7 of the plan's constraints forbids it |
| §7.4 politeness, `maxProductsPerRun` | 4, 7 |
| §7.5 images upgraded, capped, HEAD left to the wizard | 3 |
| §8.1 `/crawl` form | 8 |
| §8.2 crawl panel on the run screen | 9 |
| §8.3 wizard entry | 9 |
| §9 fixture tests, no network | 1, 2, 3, 5 |

**Gap accepted deliberately:** §7.3's CAPTCHA detection has no code in plan 1. A Shopify `/products.json` fast path never renders a challenge page — it returns JSON, HTML (password page, handled) or a status. Challenge detection belongs with the browser path in plan 2, and writing a detector now would be a detector with nothing to detect.

**Gap accepted deliberately:** §8.1's `platform: auto` is present in the UI as a disabled set of options rather than working detection, because with one adapter a detector is a constant wearing a costume. `pickAdapter` says so in an error rather than pretending.
