/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import { withDownloadSlot } from "./download-limit";
import { OutboundUrlError, assertFetchableUrl } from "./outbound-url";

/**
 * Download one image URL into memory.
 *
 * Shared by both image modes that need the bytes: `upload_site` sends them to the
 * site, `s3` sends them to a bucket. It used to be a private `fetchImage` inside
 * `lib/s3.ts`, and pulling it out is what makes "the web downloads, the plugin
 * writes" possible at all.
 *
 * WHY THE URL RULE IS NOT IN THIS FILE. It lives in `lib/outbound-url.ts`, which
 * already owned "URLs this app refuses to open" for the preview's image check and for
 * the run-finished webhook, and whose stated reason for existing is that a second
 * copy of that rule would drift out of agreement with the first. A third copy here
 * would have been exactly that. What this module adds is applying the rule to EVERY
 * REDIRECT HOP — see `downloadImage`.
 *
 * The rule matters more here than anywhere else it is used. Until plugin 3.9.0 the
 * images in `upload_site` were fetched by PHP running on the CUSTOMER'S OWN SITE, so
 * a URL pointing at an internal address only ever reached the customer's own network.
 * Now OUR worker does the fetching, from URLs typed into a CSV — and unlike the
 * preview, this path keeps the BODY.
 *
 * CONCURRENCY IS NOT DECIDED HERE EITHER. Every call takes a slot from
 * `lib/download-limit.ts`, which caps the whole process. It has to be global: the
 * per-batch figure used to be multiplied by the run's lane count without anyone
 * choosing the product, and 32 lanes made it 256 downloads at once.
 */

/** Bytes. An image larger than this is almost certainly not an image. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** How long to wait for the source server before giving up on one image. */
export const FETCH_TIMEOUT_MS = 30_000;

/** Redirects followed. Each hop is re-checked. */
const MAX_REDIRECTS = 3;

/**
 * Kept as this module's error type so a caller has one thing to catch, whether the
 * refusal came from the URL rule or from the response.
 */
export class ImageDownloadError extends Error {}

export interface DownloadedImage {
  sourceUrl: string;
  body: Buffer;
  contentType: string;
}

export interface DownloadOptions {
  /**
   * Refuse anything larger, in bytes. Defaults to MAX_IMAGE_BYTES.
   *
   * `upload_site` passes the site's own ceiling so an image too large to send is
   * abandoned WHILE DOWNLOADING, rather than pulled down in full and then refused
   * by the plugin.
   */
  maxBytes?: number;
  signal?: AbortSignal;
}

/** The shared rule, with its refusal re-thrown as this module's error type. */
async function checkedUrl(raw: string): Promise<URL> {
  try {
    return await assertFetchableUrl(raw);
  } catch (error) {
    throw error instanceof OutboundUrlError ? new ImageDownloadError(error.message) : error;
  }
}

export async function downloadImage(
  sourceUrl: string,
  options: DownloadOptions = {},
): Promise<DownloadedImage> {
  // The slot covers the DNS lookup and the redirect chain too, not only the transfer:
  // a name that takes three seconds to resolve occupies the link's attention just as
  // a slow body does.
  return withDownloadSlot(() => download(sourceUrl, options));
}

async function download(
  sourceUrl: string,
  options: DownloadOptions,
): Promise<DownloadedImage> {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;

  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);

  let current = sourceUrl;
  let response: Response | null = null;

  /*
   * Redirects are followed BY HAND, so every hop goes through the shared rule.
   *
   * `redirect: "follow"` would hand the whole chain to undici and check only the
   * URL we started with — which is the hole `ImageFetcher` had:
   * `CURLOPT_FOLLOWLOCATION` with a check on the first URL only, so a public URL
   * that redirects to 169.254.169.254 was fetched.
   */
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await checkedUrl(current);

    response = await fetch(url, { redirect: "manual", signal });

    if (response.status < 300 || response.status >= 400) {
      break;
    }

    const location = response.headers.get("location");
    if (location === null || location === "") {
      throw new ImageDownloadError(`HTTP ${response.status} with no Location header`);
    }

    // Cancel the redirect's own body rather than leaving the socket to time out.
    await response.body?.cancel().catch(() => {});

    if (hop === MAX_REDIRECTS) {
      throw new ImageDownloadError(`More than ${MAX_REDIRECTS} redirects`);
    }

    current = new URL(location, url).toString();
  }

  if (response === null) {
    throw new ImageDownloadError("No response");
  }

  if (!response.ok) {
    throw new ImageDownloadError(`HTTP ${response.status} fetching the image`);
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  /*
   * A page is not an image, however it is labelled.
   *
   * This is the case a naive check calls fine: a CDN's own "not found" page, a
   * hotlink block or a login wall served with status 200. The pre-run link check
   * (`lib/image-check.ts`) already refuses these, and now the download does too —
   * so an S3 run can no longer publish an HTML error page as a product photo.
   */
  if (!contentType.startsWith("image/")) {
    await response.body?.cancel().catch(() => {});
    throw new ImageDownloadError(
      `The source answered with ${contentType === "" ? "no content type" : contentType}, not an image`,
    );
  }

  // Content-Length is a hint, not a promise — but when it is present and already
  // over the ceiling there is no reason to read a single byte.
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ImageDownloadError(sizeRefusal(declared, maxBytes));
  }

  const body = await readCapped(response, maxBytes);

  if (body.byteLength === 0) {
    throw new ImageDownloadError("The source returned an empty body");
  }

  return { sourceUrl, body, contentType };
}

/**
 * Read the body, stopping AS SOON AS the ceiling is passed.
 *
 * `arrayBuffer()` then checking the length — which is what `lib/s3.ts` did — means
 * a hostile or misconfigured host can make the worker allocate as much as it likes
 * before being told no.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let total = 0;

  const reader = response.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ImageDownloadError(sizeRefusal(total, maxBytes));
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

function sizeRefusal(size: number, maxBytes: number): string {
  const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  return `The image is over ${mb(maxBytes)} MB (at least ${mb(size)} MB)`;
}
