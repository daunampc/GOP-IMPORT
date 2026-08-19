/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import type { ImportOptions } from "./import-options";
import type { Product, GopClient } from "./gop-client";
import { downloadLanes } from "./download-limit";
import { ImageDownloadError, downloadImage, type DownloadedImage } from "./image-download";
import {
  MAX_UPLOAD_ENTRIES,
  imageSizeCeiling,
  uploadBudgetBytes,
  uploadOneRequest,
} from "./image-upload";
import { S3ConfigError, S3Uploader } from "./s3";
import type { S3Credentials } from "./settings";

/**
 * Handle "Image handling" before products are sent down to the plugin.
 *
 *  - `keep_remote`: leave the original URLs alone. The plugin writes FIFU meta and
 *    downloads nothing. Fastest, but the images live or die with whoever hosts them.
 *  - `upload_site`: download the images HERE and send the bytes to the site, which
 *    writes them into its own wp-content/uploads.
 *  - `s3`: pull the images through this process and push them to the configured
 *    bucket, then create the products with the bucket's public URLs.
 *
 * WHERE THE DOWNLOADING HAPPENS is what changed in plugin 3.9.0. `upload_site` used
 * to send the site a LIST OF URLS and let its PHP fetch them with curl_multi: 40
 * images across 8 lanes at a 20 second timeout is up to 100 seconds of a PHP-FPM
 * worker, and `threads` ran up to 32 of those requests at once. Shops went down
 * mid-import. Now this process downloads and the site only writes a file.
 *
 * 3.10.0 is about the SPEED of doing that, for catalogues whose images are many and
 * large. Three things, in the order they save the most:
 *
 *  1. ASK FIRST. `client.imagesPresent` names the images the site already holds, and
 *     each one is then neither downloaded nor sent. On a catalogue being re-synced
 *     that is most of the traffic of a run — and it works at all only because the
 *     path an image lands at is now a pure function of its source URL.
 *  2. NO BARRIER. Downloading and uploading used to be two phases: every image of a
 *     batch was fetched before the first byte went to the site. With heavy images both
 *     phases are slow and neither overlapped the other. They now run at once — see
 *     `stageToSite`.
 *  3. RAW BYTES. The wire is a manifest plus the images end to end rather than base64
 *     inside JSON, which was a third of every image-heavy request. See
 *     `GopClient.uploadImages`.
 *
 * The S3 credentials are PASSED IN rather than read here.
 *
 * This module used to call `getS3Credentials()` itself, which read the one global
 * settings row — so whichever account's run happened to be executing, the images went
 * to the same bucket. There is now a bucket per account, and the only correct one is
 * the bucket of the account that OWNS THE RUN, which this module has no way to know:
 * it sees a batch of products, not a job. Taking the credentials as an argument moves
 * that decision to the one place that does know, `worker/index.ts`, and makes "which
 * bucket" impossible to get wrong by omission — the argument is required.
 */

/** URLs per `/images/present` question. Matches the plugin's own limit. */
const PROBE_CHUNK = 200;

export interface ImageStageResult {
  products: Product[];
  /** URLs that failed — the original link is kept, and the failure reported. */
  failures: ImageFailure[];
  stats: ImageStageStats;
}

export interface ImageFailure {
  url: string;
  error: string;
  /**
   * WHOSE fault it is, which the operator cannot work out from the message alone.
   *
   * `download` is the image's source: a dead link, a timeout, a page where a picture
   * should be. Nothing about the target site will fix it — the feed has to. `upload`
   * is the target site: no disk space, wrong permissions, a body it refused. The
   * catalogue is fine and the site needs attention.
   *
   * They used to be one undifferentiated list, so "your supplier's CDN is down" and
   * "your site's uploads directory is read-only" read identically in the log.
   */
  reason: "download" | "upload";
}

/**
 * What this batch's images actually cost.
 *
 * Logged per batch, and it is what makes the tuning knobs tunable. An operator asking
 * "why is this run slow" needs to know whether the time went on downloading or on
 * uploading, and whether asking the site first saved anything — `alreadyOnSite` is the
 * number that says whether a re-run is nearly free or exactly as expensive as the
 * first one.
 */
export interface ImageStageStats {
  /** Distinct image URLs referenced by this batch's products. */
  total: number;
  /** Resolved from earlier batches of the same run — no work at all. */
  fromCache: number;
  /** The site said it already had these: neither downloaded nor sent. */
  alreadyOnSite: number;
  downloaded: number;
  downloadedBytes: number;
  /** Sent to the site. */
  uploaded: number;
  uploadedBytes: number;
  /** Sent, and the site found the identical file already written. */
  skippedBySite: number;
  /** Upload requests made. */
  requests: number;
  /** Wall time with at least one download in flight. */
  downloadMs: number;
  /** Wall time with an upload request in flight. */
  uploadMs: number;
}

function emptyStats(total = 0): ImageStageStats {
  return {
    total,
    fromCache: 0,
    alreadyOnSite: 0,
    downloaded: 0,
    downloadedBytes: 0,
    uploaded: 0,
    uploadedBytes: 0,
    skippedBySite: 0,
    requests: 0,
    downloadMs: 0,
    uploadMs: 0,
  };
}

/**
 * Images resolved for the WHOLE RUN, so one image is handled once.
 *
 * Promises rather than values, deliberately: two lanes reaching the same URL at the
 * same moment must not both download it, so the second one awaits the first's promise.
 * Created per run in `worker/index.ts` and passed to every call.
 */
export type ImageCache = Map<string, Promise<StagedImage>>;

export interface StagedImage {
  /** The URL to publish, or null when staging failed and the original stands. */
  url: string | null;
  error?: string;
  reason?: "download" | "upload";
}

export function createImageCache(): ImageCache {
  return new Map();
}

export async function stageImages(
  products: Product[],
  options: ImportOptions,
  client: GopClient,
  /** The RUN OWNER's bucket, or null when that account has none configured. */
  s3: S3Credentials | null,
  /** Shared across the run. Omitted, each call stands alone — as it used to. */
  cache: ImageCache = createImageCache(),
): Promise<ImageStageResult> {
  if (options.imageMode === "s3") {
    return stageToS3(products, s3, cache);
  }

  if (options.imageMode !== "upload_site") {
    return { products, failures: [], stats: emptyStats() };
  }

  return stageToSite(products, client, cache);
}

/**
 * Ask the site, then download and upload AT THE SAME TIME.
 *
 * The shape that matters is at the bottom: download lanes append to `pending`, and
 * whenever `pending` is worth a request it is handed to a serial upload chain. Nothing
 * waits for all the downloads. Before this, `await inLanes(...)` had to finish before
 * `uploadImages(...)` began — so with a 2 MB average image and a slow shop uplink, the
 * link to the source and the link to the site took turns being idle.
 *
 * Uploads stay SERIAL within the call on purpose. Each import lane runs this
 * separately, so requests in flight against the site already equal the run's
 * `threads`; parallelising here would multiply the two and put back the PHP pressure
 * 3.9.0 removed. Downloads are bounded process-wide by `lib/download-limit.ts`.
 *
 * A failure anywhere keeps the ORIGINAL URL and lets the product publish. That rule
 * predates all of this and is not weakened by it: a broken image is a bad photo, a
 * refused batch is a missing product.
 */
async function stageToSite(
  products: Product[],
  client: GopClient,
  cache: ImageCache,
): Promise<ImageStageResult> {
  const urls = collectUrls(products);
  const stats = emptyStats(urls.length);

  if (urls.length === 0) {
    return { products, failures: [], stats };
  }

  const fresh = urls.filter((url) => !cache.has(url));
  stats.fromCache = urls.length - fresh.length;

  /*
   * Every fresh URL gets its promise into the cache BEFORE any awaiting happens.
   *
   * That ordering is what makes the cache work under concurrency: a second lane
   * arriving mid-download finds a promise and waits on it, instead of finding nothing
   * and starting a second download of the same image.
   */
  const settlers = new Map<string, (image: StagedImage) => void>();

  for (const url of fresh) {
    cache.set(
      url,
      new Promise<StagedImage>((resolve) => {
        settlers.set(url, resolve);
      }),
    );
  }

  const failures: ImageFailure[] = [];

  try {
    /* ---------------------------------------------------------------- ask first */

    const known = await alreadyOnSite(fresh, client);
    const toFetch: string[] = [];

    for (const url of fresh) {
      const local = known.get(url);

      if (local !== undefined && local !== null) {
        stats.alreadyOnSite++;
        settle(settlers, url, { url: local });
      } else {
        toFetch.push(url);
      }
    }

    /* ------------------------------------------------- download and upload, at once */

    let pending: DownloadedImage[] = [];
    let pendingBytes = 0;
    let uploads: Promise<void> = Promise.resolve();
    const budget = uploadBudgetBytes();

    const record = (outcomes: Awaited<ReturnType<typeof uploadOneRequest>>): void => {
      for (const outcome of outcomes) {
        if (outcome.url !== undefined) {
          stats.uploaded++;
          if (outcome.skipped === true) {
            stats.skippedBySite++;
          }
          settle(settlers, outcome.sourceUrl, { url: outcome.url });
        } else {
          const error = outcome.error ?? "Upload failed";
          failures.push({ url: outcome.sourceUrl, error, reason: "upload" });
          settle(settlers, outcome.sourceUrl, { url: null, error, reason: "upload" });
        }
      }
    };

    /** Hand what is pending to the upload chain, without waiting for it. */
    const flush = (): void => {
      if (pending.length === 0) {
        return;
      }

      const batch = pending;
      const batchBytes = pendingBytes;
      pending = [];
      pendingBytes = 0;

      uploads = uploads.then(async () => {
        const startedAt = Date.now();

        try {
          record(await uploadOneRequest(batch, client));
        } finally {
          stats.requests++;
          stats.uploadedBytes += batchBytes;
          stats.uploadMs += Date.now() - startedAt;
        }
      });
    };

    const downloadStartedAt = Date.now();

    await inLanes(toFetch, downloadLanes(), async (url) => {
      try {
        const image = await downloadImage(url, { maxBytes: imageSizeCeiling() });

        stats.downloaded++;
        stats.downloadedBytes += image.body.byteLength;

        pending.push(image);
        pendingBytes += image.body.byteLength;

        // Full enough to be worth a request. Handed over WITHOUT awaiting, so this
        // lane goes straight back to downloading while the site writes.
        if (pendingBytes >= budget || pending.length >= MAX_UPLOAD_ENTRIES) {
          flush();
        }
      } catch (error) {
        const message = messageOf(error);
        failures.push({ url, error: message, reason: "download" });
        settle(settlers, url, { url: null, error: message, reason: "download" });
      }
    });

    stats.downloadMs = Date.now() - downloadStartedAt;

    // Whatever is left over, then wait for the chain to drain.
    flush();
    await uploads;

    return finish(products, urls, failures, stats, cache, settlers);
  } catch (error) {
    /*
     * Something outside the per-image paths threw. Release every promise still
     * waiting, or a later batch would await a promise nobody will ever resolve and the
     * run would hang rather than fail.
     */
    releaseAll(settlers, cache, messageOf(error), "upload");
    throw error;
  }
}

/**
 * Which of these the site already holds, as a map of source URL to local URL.
 *
 * A FAILURE HERE IS NOT A FAILURE OF THE RUN. If the question cannot be asked — an
 * unexpected build, a WAF, a timeout — the answer is "we do not know", every image is
 * downloaded and sent as before, and nothing is reported to the operator. The route
 * exists to remove work, so losing it costs time and nothing else. Treating it as
 * fatal would make a run fail for the sake of an optimisation.
 */
async function alreadyOnSite(
  urls: string[],
  client: GopClient,
): Promise<Map<string, string | null>> {
  const known = new Map<string, string | null>();

  for (let offset = 0; offset < urls.length; offset += PROBE_CHUNK) {
    const chunk = urls.slice(offset, offset + PROBE_CHUNK);

    try {
      for (const answer of await client.imagesPresent(chunk)) {
        known.set(answer.source_url, answer.url);
      }
    } catch {
      // Unknown for this chunk, which means "send them".
      return known;
    }
  }

  return known;
}

/**
 * Copy every image to S3 and rewrite the products to point at the bucket.
 *
 * A missing or half-finished S3 configuration THROWS rather than quietly falling back
 * to the original links: someone who picked S3 wants the images in the bucket, and
 * discovering months later that a run linked to a supplier's CDN instead is far worse
 * than a batch that fails immediately.
 *
 * The same rule now covers a second, worse failure. Falling back to ANOTHER ACCOUNT's
 * bucket when this one has none configured would put one customer's product images in
 * another customer's storage, and publish them at that customer's domain. There is no
 * fallback: no credentials means no run.
 *
 * There is no equivalent of `alreadyOnSite` here, and none is needed: `S3Uploader`
 * already asks the bucket with a HEAD before it fetches anything, and its object key
 * has always been a hash of the source URL.
 */
async function stageToS3(
  products: Product[],
  credentials: S3Credentials | null,
  cache: ImageCache,
): Promise<ImageStageResult> {
  if (credentials === null) {
    throw new S3ConfigError(
      'Image handling is set to "Upload to Amazon S3" but this account has no S3 configured. Fill in the bucket, region and keys on the Settings screen, or pick another image mode.',
    );
  }

  const urls = collectUrls(products);
  const stats = emptyStats(urls.length);

  if (urls.length === 0) {
    return { products, failures: [], stats };
  }

  const fresh = urls.filter((url) => !cache.has(url));
  stats.fromCache = urls.length - fresh.length;

  const uploader = new S3Uploader(credentials);
  const settlers = new Map<string, (image: StagedImage) => void>();

  for (const url of fresh) {
    cache.set(
      url,
      new Promise<StagedImage>((resolve) => {
        settlers.set(url, resolve);
      }),
    );
  }

  try {
    const failures: ImageFailure[] = [];
    const startedAt = Date.now();

    await inLanes(fresh, downloadLanes(), async (url) => {
      try {
        settle(settlers, url, { url: await uploader.upload(url) });
        stats.uploaded++;
      } catch (error) {
        // The whole hop is this process's own work — fetch then put — so the split
        // that `upload_site` can make between "their CDN" and "your site" is not
        // available here. An S3 failure is reported as a download failure because
        // that is what it almost always is.
        const message = messageOf(error);
        failures.push({ url, error: message, reason: "download" });
        settle(settlers, url, { url: null, error: message, reason: "download" });
      }
    });

    stats.downloadMs = Date.now() - startedAt;

    return await finish(products, urls, failures, stats, cache, settlers);
  } catch (error) {
    releaseAll(settlers, cache, messageOf(error), "download");
    throw error;
  } finally {
    uploader.destroy();
  }
}

/**
 * Resolve the whole URL set from the cache and rewrite the products.
 *
 * `urls` is every image in THIS batch, including ones an earlier batch already staged —
 * their result comes back out of the cache. Note that `failures` holds only what this
 * call discovered: a failure another batch reported was reported then, and counting it
 * again per batch that mentions the same image would inflate the number the operator
 * reads.
 */
async function finish(
  products: Product[],
  urls: string[],
  failures: ImageFailure[],
  stats: ImageStageStats,
  cache: ImageCache,
  settlers: Map<string, (image: StagedImage) => void>,
): Promise<ImageStageResult> {
  // Anything left unsettled would deadlock a later batch. Nothing should reach here,
  // so this is a backstop rather than a path.
  releaseAll(settlers, cache, "The image was never resolved", "upload");

  const mapping = new Map<string, string>();

  await Promise.all(
    urls.map(async (url) => {
      const staged = await cache.get(url);

      if (staged?.url != null) {
        mapping.set(url, staged.url);
      }
    }),
  );

  /*
   * A URL that FAILED is dropped from the cache, so the next batch tries again.
   *
   * Caching a failure would let one transient hiccup — a CDN blip on the first batch —
   * poison every later batch of a run that might take hours. Successes stay, because
   * that is the whole saving.
   */
  for (const url of urls) {
    const staged = await cache.get(url);
    if (staged !== undefined && staged.url === null) {
      cache.delete(url);
    }
  }

  return { products: products.map((product) => rewrite(product, mapping)), failures, stats };
}

function settle(
  settlers: Map<string, (image: StagedImage) => void>,
  url: string,
  image: StagedImage,
): void {
  const resolve = settlers.get(url);

  if (resolve !== undefined) {
    settlers.delete(url);
    resolve(image);
  }
}

function releaseAll(
  settlers: Map<string, (image: StagedImage) => void>,
  cache: ImageCache,
  error: string,
  reason: "download" | "upload",
): void {
  for (const [url, resolve] of settlers) {
    resolve({ url: null, error, reason });
    cache.delete(url);
  }

  settlers.clear();
}

/** Run `work` over `items` with a fixed number of lanes. */
async function inLanes<T>(items: T[], lanes: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;

      if (index >= items.length) {
        return;
      }

      await work(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, () => lane()));
}

function messageOf(error: unknown): string {
  if (error instanceof ImageDownloadError) {
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

function collectUrls(products: Product[]): string[] {
  const urls = new Set<string>();

  for (const product of products) {
    for (const url of product.images ?? []) {
      urls.add(url);
    }
    for (const variation of product.variations ?? []) {
      if (variation.image) {
        urls.add(variation.image);
      }
      for (const url of variation.images ?? []) {
        urls.add(url);
      }
    }
  }

  return [...urls];
}

function rewrite(product: Product, mapping: Map<string, string>): Product {
  const map = (url: string): string => mapping.get(url) ?? url;

  return {
    ...product,
    images: product.images?.map(map),
    variations: product.variations?.map((variation) => ({
      ...variation,
      image: variation.image ? map(variation.image) : variation.image,
      images: variation.images?.map(map),
    })),
  };
}
