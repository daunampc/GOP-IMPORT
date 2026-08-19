/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import type { DownloadedImage } from "./image-download";
import type { GopClient } from "./gop-client";

/**
 * Send images this process has already downloaded to the site, and hand back the
 * local URL of each.
 *
 * One job, kept apart from both the downloading and the orchestration in
 * `lib/images.ts`, because the thing that is easy to get wrong here is arithmetic:
 * how much goes in one request. The plugin refuses a body over 32 MB and 31 MB of
 * image, and getting that wrong turns a working run into `body_too_large` on every
 * batch.
 */

/**
 * Raw bytes packed into one request.
 *
 * 24 MB against the plugin's 31 MB ceiling. It was 16 MB while the bytes travelled as
 * base64, because 4/3 of 16 MB is already 21 MB of body; raw bytes are 1:1, so the
 * same request now carries half again as much image for the same body size and a
 * catalogue needs a third fewer round trips.
 *
 * Lower it for a site whose PHP `memory_limit` is small — `GET /health` reports that
 * limit on the Sites screen for exactly this decision. The plugin holds the body plus
 * one image, so its peak is roughly this number plus the largest image in the request.
 */
export const DEFAULT_UPLOAD_BUDGET_BYTES = 24 * 1024 * 1024;

/**
 * The most a single request may carry — the plugin's own limit.
 *
 * Kept here as well as there so the app can refuse an impossible image BEFORE
 * spending the bandwidth to download it. See `imageSizeCeiling`.
 */
export const PLUGIN_UPLOAD_CEILING_BYTES = 31 * 1024 * 1024;

/** Entries per request. The plugin refuses more than this. */
export const MAX_UPLOAD_ENTRIES = 40;

export function uploadBudgetBytes(): number {
  const raw = Number.parseInt(process.env.GOP_IMAGE_UPLOAD_BYTES ?? "", 10);

  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_UPLOAD_BUDGET_BYTES;
  }

  // Never above what the plugin will accept: a budget larger than the ceiling would
  // produce requests that cannot succeed, whatever the operator typed.
  return Math.min(raw, PLUGIN_UPLOAD_CEILING_BYTES);
}

/**
 * The largest image `upload_site` can place, so the downloader can give up early
 * rather than pulling down bytes that could never be sent.
 */
export function imageSizeCeiling(): number {
  return PLUGIN_UPLOAD_CEILING_BYTES;
}

export interface UploadOutcome {
  sourceUrl: string;
  /** The local URL on the site, when it worked. */
  url?: string;
  error?: string;
  /** True when the site already had this exact file and wrote nothing. */
  skipped?: boolean;
}

/**
 * Send ONE request's worth of images, and report on each.
 *
 * Deliberately one request rather than a loop over many: the caller is a pipeline
 * that fills a request while other images are still downloading, so it decides when a
 * request is full — see `lib/images.ts`. Packing is `packRequests` below, which the
 * caller uses when it already has everything in hand.
 */
export async function uploadOneRequest(
  images: DownloadedImage[],
  client: GopClient,
): Promise<UploadOutcome[]> {
  if (images.length === 0) {
    return [];
  }

  const tooBig = images.filter((image) => image.body.byteLength > PLUGIN_UPLOAD_CEILING_BYTES);
  const sendable = images.filter((image) => image.body.byteLength <= PLUGIN_UPLOAD_CEILING_BYTES);

  const outcomes: UploadOutcome[] = tooBig.map((image) => ({
    sourceUrl: image.sourceUrl,
    error:
      `The image is ${mb(image.body.byteLength)} MB and a site accepts at most ` +
      `${mb(PLUGIN_UPLOAD_CEILING_BYTES)} MB per image.`,
  }));

  if (sendable.length === 0) {
    return outcomes;
  }

  let answers: Awaited<ReturnType<GopClient["uploadImages"]>>;

  try {
    answers = await client.uploadImages(
      sendable.map((image) => ({
        sourceUrl: image.sourceUrl,
        contentType: image.contentType,
        body: image.body,
      })),
    );
  } catch (error) {
    /*
     * The whole request died — a timeout, a WAF, a 500. Every image in it is reported
     * as failed and the caller keeps their original URLs.
     *
     * Deliberately NOT retried here. `lib/site-pressure.ts` owns the question of
     * whether a failure is worth sending again, and a second opinion buried in this
     * module would fight it.
     */
    const message = error instanceof Error ? error.message : String(error);

    return [
      ...outcomes,
      ...sendable.map((image) => ({ sourceUrl: image.sourceUrl, error: message })),
    ];
  }

  for (const [index, answer] of answers.entries()) {
    // The plugin answers in request order and echoes source_url; position is the
    // fallback for a build that ever stopped echoing it.
    const sourceUrl = answer.source_url ?? sendable[index]?.sourceUrl ?? "";

    outcomes.push(
      answer.ok && answer.url !== undefined
        ? { sourceUrl, url: answer.url, skipped: answer.skipped === true }
        : { sourceUrl, error: answer.error ?? "No reason given" },
    );
  }

  return outcomes;
}

export interface PackedRequest {
  images: DownloadedImage[];
}

/**
 * Group images into requests: at most the byte budget, at most 40 entries.
 *
 * An image bigger than the budget travels alone rather than being refused — the budget
 * is a target for packing, the ceiling in `uploadOneRequest` is the hard limit.
 * Exported for the tests, which is the only way to assert the arithmetic without a
 * site to talk to.
 */
export function packRequests(images: DownloadedImage[]): PackedRequest[] {
  const budget = uploadBudgetBytes();
  const requests: PackedRequest[] = [];

  let current: DownloadedImage[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    if (current.length > 0) {
      requests.push({ images: current });
      current = [];
      currentBytes = 0;
    }
  };

  for (const image of images) {
    const size = image.body.byteLength;

    if (size > budget) {
      // Over the packing budget: its own request, and it does not disturb whatever
      // was being filled. Whether it is sendable at all is `uploadOneRequest`'s call.
      flush();
      requests.push({ images: [image] });
      continue;
    }

    if (currentBytes + size > budget || current.length >= MAX_UPLOAD_ENTRIES) {
      flush();
    }

    current.push(image);
    currentBytes += size;
  }

  flush();

  return requests;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
