/*
 * Do NOT import "server-only" here — the review screen imports the TYPES, and a
 * type import is erased at compile time. No value from this module reaches the
 * browser: `checkImageUrls` is called from a route handler only.
 */

import { blockedReason } from "./outbound-url";

// Re-exported so a caller reading about image links finds the policy that applies
// to them, rather than having to know it lives somewhere more general.
export { blockedReason } from "./outbound-url";

/**
 * Asking the image links whether they work, BEFORE a run writes anything.
 *
 * Today a dead image URL is discovered halfway through an import: the products are
 * already being created, the log fills with staging failures, and the operator
 * finds out about a broken link at the point where there is nothing left to decide.
 * One request per DISTINCT link at the preview step moves that discovery to where a
 * decision is still possible.
 *
 * DISTINCT is the word that makes it affordable. A file of 3,000 products sharing
 * one size chart image is one link, not 3,000 — the same property that makes S3
 * object keys hashes of the URL.
 *
 * Four outcomes have to be told apart, and three of them look identical to code
 * that only asks whether the request succeeded:
 *
 * | Verdict | What it is |
 * |---|---|
 * | `ok` | 2xx with an image content type, or a redirect that was not followed |
 * | `not_an_image` | **2xx that answers with a PAGE.** A CDN's styled "not found" page served with status 200 — the case a naive check calls fine |
 * | `not_found` | 404 or 410: the link is dead |
 * | `refused` | any other 4xx or 5xx: the host will not serve it to us |
 * | `unreachable` | DNS, connection or deadline — nothing answered at all |
 * | `blocked` | refused by THIS app before any request was made — see below |
 */

/** Distinct links one check covers. Both numbers are always reported. */
export const IMAGE_CHECK_LIMIT = 200;

/**
 * Deadline per link. Short on purpose: this is a preview and somebody is waiting
 * for it, and a link that needs more than five seconds to answer with a HEADER is
 * a link that will hurt the shop's own pages.
 */
export const IMAGE_CHECK_TIMEOUT_MS = 5_000;

/**
 * Links checked at once. Eight rather than one — a 200-link check at one at a time
 * would take minutes — and eight rather than fifty, because the host on the other
 * end is usually somebody's shop or CDN and this is only a question.
 */
export const IMAGE_CHECK_CONCURRENCY = 8;

export type ImageVerdict =
  | "ok"
  | "not_an_image"
  | "not_found"
  | "refused"
  | "unreachable"
  | "blocked";

export interface ImageCheckResult {
  url: string;
  verdict: ImageVerdict;
  /** HTTP status, or null when nothing answered. */
  status: number | null;
  contentType: string | null;
  /** One sentence a person can act on. Never a response body. */
  detail: string;
}

/** Whether a verdict is a problem, a thing to look at, or fine. */
export function severityOf(verdict: ImageVerdict): "ok" | "warned" | "failed" {
  if (verdict === "ok") {
    return "ok";
  }

  return verdict === "not_an_image" ? "warned" : "failed";
}

async function checkOne(url: string): Promise<ImageCheckResult> {
  const blocked = blockedReason(url);

  if (blocked !== null) {
    return { url, verdict: "blocked", status: null, contentType: null, detail: blocked };
  }

  try {
    let response = await fetch(url, {
      method: "HEAD",
      // NOT followed on purpose: a redirect chain is where a public URL could
      // otherwise take this server to a private one.
      redirect: "manual",
      signal: AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS),
    });

    /*
     * Plenty of CDNs answer HEAD with 405 and serve the same file happily on GET.
     * Asking for one byte is enough to see the status and the content type without
     * pulling a megabyte of JPEG through this process.
     */
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "manual",
        signal: AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS),
      });
    }

    const status = response.status;
    const contentType = response.headers.get("content-type");

    if (status >= 300 && status < 400) {
      return {
        url,
        verdict: "ok",
        status,
        contentType,
        detail: "The host answered with a redirect, which was not followed from here.",
      };
    }

    if (status >= 400) {
      const dead = status === 404 || status === 410;

      return {
        url,
        verdict: dead ? "not_found" : "refused",
        status,
        contentType,
        detail: dead
          ? `The host says there is nothing at this link (HTTP ${status}).`
          : `The host refused it (HTTP ${status}).`,
      };
    }

    /*
     * The case worth having this whole check for. A host that answers 200 with an
     * HTML page — its own "not found" page, a login wall, a hotlink block — passes
     * every test except this one, and the import would happily publish it as a
     * product image.
     */
    if (contentType !== null && !contentType.toLowerCase().startsWith("image/")) {
      return {
        url,
        verdict: "not_an_image",
        status,
        contentType,
        detail:
          `The link works but answers with \`${contentType.split(";")[0]}\` rather than an ` +
          `image — usually a "not found" page or a hotlink block served with a 200.`,
      };
    }

    return {
      url,
      verdict: "ok",
      status,
      contentType,
      detail: contentType === null ? "Reachable; the host named no content type." : "Reachable.",
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";

    return {
      url,
      verdict: "unreachable",
      status: null,
      contentType: null,
      detail: timedOut
        ? `Nothing answered within ${Math.round(IMAGE_CHECK_TIMEOUT_MS / 1000)}s.`
        : `Could not reach the host: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Check these links, a few at a time, and answer for every one of them.
 *
 * Never throws: one unreachable host is a RESULT, not a failure of the check. A
 * preview that fell over because a link was dead would hide exactly what it exists
 * to show.
 */
export async function checkImageUrls(urls: readonly string[]): Promise<ImageCheckResult[]> {
  const results: ImageCheckResult[] = [];
  let cursor = 0;

  async function lane(): Promise<void> {
    for (;;) {
      const index = cursor++;

      if (index >= urls.length) {
        return;
      }

      results[index] = await checkOne(urls[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(IMAGE_CHECK_CONCURRENCY, urls.length) }, () => lane()),
  );

  return results;
}
