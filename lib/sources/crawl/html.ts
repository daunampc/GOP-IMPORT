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
