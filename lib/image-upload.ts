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
 * how much goes in one request. Base64 inflates by 4/3, the plugin refuses a body
 * over 32 MB and 22 MB of decoded image, and getting that wrong turns a working run
 * into `body_too_large` on every batch.
 */

/**
 * Raw bytes packed into one request, before base64.
 *
 * The PLUGIN's ceiling is 22 MB (`MAX_IMAGE_UPLOAD_BYTES`); this is the app's own
 * budget underneath it, so a batch has headroom for the JSON around the bytes.
 * Lower it for a site whose PHP `memory_limit` is small — `GET /health` reports
 * that limit on the Sites screen for exactly this decision.
 */
export const DEFAULT_UPLOAD_BUDGET_BYTES = 16 * 1024 * 1024;

/**
 * The most a single request may carry, decoded — the plugin's own limit.
 *
 * Kept here as well as there because the app should refuse an impossible image
 * BEFORE spending the bandwidth to download it. See `imageSizeCeiling`.
 */
export const PLUGIN_UPLOAD_CEILING_BYTES = 22 * 1024 * 1024;

/** Entries per request. The plugin refuses more than this. */
export const MAX_UPLOAD_ENTRIES = 40;

export function uploadBudgetBytes(): number {
  const raw = Number.parseInt(process.env.GOP_IMAGE_UPLOAD_BYTES ?? "", 10);

  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_UPLOAD_BUDGET_BYTES;
  }

  // Never above what the plugin will accept: a budget larger than the ceiling
  // would produce requests that cannot succeed, whatever the operator typed.
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
 * Upload every image, in as few requests as the budget allows.
 *
 * Requests go out ONE AT A TIME on purpose. Each import lane already calls this
 * separately, so concurrency across the site equals the run's `threads` — the same
 * number of simultaneous requests the old `/images/fetch` produced. The difference
 * is what each one costs the site: a local disk write instead of up to 100 seconds
 * of curl. Adding parallelism here would multiply lanes by requests and put the
 * pressure straight back.
 */
export async function uploadImages(
  images: DownloadedImage[],
  client: GopClient,
): Promise<UploadOutcome[]> {
  const outcomes: UploadOutcome[] = [];

  for (const batch of packRequests(images)) {
    if (batch.oversized !== undefined) {
      outcomes.push({
        sourceUrl: batch.oversized.sourceUrl,
        error:
          `The image is ${mb(batch.oversized.body.byteLength)} MB and a site accepts at most ` +
          `${mb(PLUGIN_UPLOAD_CEILING_BYTES)} MB per image.`,
      });
      continue;
    }

    const entries = batch.images.map((image) => ({
      source_url: image.sourceUrl,
      content_type: image.contentType,
      bytes: image.body.toString("base64"),
    }));

    let answers: Awaited<ReturnType<GopClient["uploadImages"]>>;

    try {
      answers = await client.uploadImages(entries);
    } catch (error) {
      /*
       * The whole request died — a timeout, a WAF, a 500. Every image in it is
       * reported as failed and the caller keeps their original URLs.
       *
       * Deliberately NOT retried here. `lib/site-pressure.ts` owns the question of
       * whether a failure is worth sending again, and a second opinion buried in
       * this module would fight it.
       */
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push(...batch.images.map((image) => ({ sourceUrl: image.sourceUrl, error: message })));
      continue;
    }

    for (const [index, answer] of answers.entries()) {
      // The plugin answers in request order and echoes source_url; position is the
      // fallback for a build that ever stopped echoing it.
      const sourceUrl = answer.source_url ?? batch.images[index]?.sourceUrl ?? "";

      outcomes.push(
        answer.ok && answer.url !== undefined
          ? { sourceUrl, url: answer.url, skipped: answer.skipped === true }
          : { sourceUrl, error: answer.error ?? "No reason given" },
      );
    }
  }

  return outcomes;
}

interface PackedRequest {
  images: DownloadedImage[];
  /** Set instead of `images` when one image alone is over the plugin's ceiling. */
  oversized?: DownloadedImage;
}

/**
 * Group images into requests: at most the byte budget, at most 40 entries.
 *
 * An image bigger than the budget but under the ceiling travels alone rather than
 * being refused — the budget is a target for packing, the ceiling is the hard
 * limit. Exported for the tests, which is the only way to assert the arithmetic
 * without a site to talk to.
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

    if (size > PLUGIN_UPLOAD_CEILING_BYTES) {
      flush();
      requests.push({ images: [], oversized: image });
      continue;
    }

    if (size > budget) {
      // Over the packing budget but sendable: its own request, and it does not
      // disturb whatever was being filled.
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
