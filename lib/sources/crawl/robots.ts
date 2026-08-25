/*
 * robots.txt, hand-rolled.
 *
 * A dependency was considered and refused. `robots-parser` is 300 lines behind a
 * supply-chain surface, and this file needs two behaviours beyond string
 * matching: longest-match-wins with Allow breaking the tie (the loop at the
 * bottom), and translating each pattern's `*` and `$` into a regular expression
 * (`matcherFor`, below) — Shopify's own robots.txt relies on both wildcards, and
 * without them a rule like `Disallow: /*\/checkouts/` matches nothing at all.
 * `lib/sources/csv-dialect.ts` hand-rolls dialect detection for the same reason,
 * and this repo keeps its dependency list short on purpose.
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
  /** The pattern as written. Its LENGTH decides precedence, so it is kept. */
  path: string;
  matches: RegExp;
}

/**
 * A robots.txt path pattern as a regular expression.
 *
 * Two wildcards are standard and both matter to real shops: `*` stands for any
 * run of characters, and a trailing `$` anchors the end of the path. Shopify's
 * own template uses them — `Disallow: /*\/checkouts/` and friends — and without
 * translation those rules match nothing at all, so a shop that asked to be left
 * alone would be crawled anyway. That failure is silent, which is what makes it
 * worth the fifteen lines.
 *
 * Everything else is escaped, so a `.` or a `?` in a rule is the character
 * rather than a metacharacter.
 */
function matcherFor(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
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
        groups.get(name)?.push({ allow: field === "allow", path: value, matches: matcherFor(value) });
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
        if (!rule.matches.test(path)) {
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
