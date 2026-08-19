/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import type { ImportOptions } from "./import-options";
import type { Product, GopClient } from "./gop-client";
import { ImageDownloadError, downloadImage } from "./image-download";
import { imageSizeCeiling, uploadImages } from "./image-upload";
import { S3ConfigError, S3Uploader } from "./s3";
import type { S3Credentials } from "./settings";

/**
 * Handle "Image handling" before products are sent down to the plugin.
 *
 *  - `keep_remote`: leave the original URLs alone. The plugin writes FIFU meta
 *    and downloads nothing. Fastest, but the images live or die with whoever
 *    hosts them.
 *  - `upload_site`: download the images HERE and send the bytes to the site, which
 *    writes them into its own wp-content/uploads.
 *  - `s3`: pull the images through this process and push them to the configured
 *    bucket, then create the products with the bucket's public URLs.
 *
 * WHERE THE DOWNLOADING HAPPENS is the thing that changed, and it is the whole
 * point of plugin 3.9.0. `upload_site` used to send the site a LIST OF URLS and let
 * its PHP fetch them with curl_multi: 40 images across 8 lanes at a 20 second
 * timeout is up to 100 seconds of a PHP-FPM worker, and `threads` ran up to 32 of
 * those requests at once. Shops went down mid-import. Now this process downloads and
 * the site only writes a file, so a request costs a disk write. `s3` already worked
 * this way, which is why it never had the problem.
 *
 * The S3 credentials are PASSED IN rather than read here.
 *
 * This module used to call `getS3Credentials()` itself, which read the one
 * global settings row — so whichever account's run happened to be executing,
 * the images went to the same bucket. There is now a bucket per account, and
 * the only correct one is the bucket of the account that OWNS THE RUN, which
 * this module has no way to know: it sees a batch of products, not a job.
 * Taking the credentials as an argument moves that decision to the one place
 * that does know, `worker/index.ts`, and makes "which bucket" impossible to get
 * wrong by omission — the argument is required.
 */

/** Parallel downloads. High enough to saturate a link, low enough to be polite. */
const DOWNLOAD_LANES = 8;

export interface ImageStageResult {
  products: Product[];
  /** URLs that failed — the original link is kept, and the failure reported. */
  failures: ImageFailure[];
}

export interface ImageFailure {
  url: string;
  error: string;
  /**
   * WHOSE fault it is, which the operator cannot work out from the message alone.
   *
   * `download` is the image's source: a dead link, a timeout, a page where a
   * picture should be. Nothing about the target site will fix it — the feed has to.
   * `upload` is the target site: no disk space, wrong permissions, a body it
   * refused. The catalogue is fine and the site needs attention.
   *
   * They used to be one undifferentiated list, so "your supplier's CDN is down" and
   * "your site's uploads directory is read-only" read identically in the log.
   */
  reason: "download" | "upload";
}

/**
 * Images resolved for the WHOLE RUN, so one image is downloaded once.
 *
 * Promises rather than values, deliberately: two lanes reaching the same URL at the
 * same moment must not both download it, so the second one awaits the first's
 * promise. Created per run in `worker/index.ts` and passed to every call.
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
    return { products, failures: [] };
  }

  return stageToSite(products, client, cache);
}

/**
 * Download every image, then send the bytes to the site.
 *
 * A failure anywhere keeps the ORIGINAL URL and lets the product publish. That rule
 * predates this change and is not weakened by it: a broken image is a bad photo, a
 * refused batch is a missing product.
 */
async function stageToSite(
  products: Product[],
  client: GopClient,
  cache: ImageCache,
): Promise<ImageStageResult> {
  const urls = collectUrls(products);

  if (urls.length === 0) {
    return { products, failures: [] };
  }

  const fresh = urls.filter((url) => !cache.has(url));

  /*
   * Every fresh URL gets its promise into the cache BEFORE any awaiting happens.
   *
   * That ordering is what makes the cache work under concurrency: a second lane
   * arriving mid-download finds a promise and waits on it, instead of finding
   * nothing and starting a second download of the same image.
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

  try {
    const downloaded = [];
    const failures: ImageFailure[] = [];

    for (const result of await inLanes(fresh, DOWNLOAD_LANES, async (url) => {
      try {
        return { url, image: await downloadImage(url, { maxBytes: imageSizeCeiling() }) };
      } catch (error) {
        return { url, error: messageOf(error) };
      }
    })) {
      if (result.image !== undefined) {
        downloaded.push(result.image);
      } else {
        failures.push({ url: result.url, error: result.error ?? "Download failed", reason: "download" });
        settle(settlers, result.url, { url: null, error: result.error, reason: "download" });
      }
    }

    for (const outcome of await uploadImages(downloaded, client)) {
      if (outcome.url !== undefined) {
        settle(settlers, outcome.sourceUrl, { url: outcome.url });
      } else {
        const error = outcome.error ?? "Upload failed";
        failures.push({ url: outcome.sourceUrl, error, reason: "upload" });
        settle(settlers, outcome.sourceUrl, { url: null, error, reason: "upload" });
      }
    }

    return finish(products, urls, failures, cache, settlers);
  } catch (error) {
    /*
     * Something outside the per-image paths threw. Release every promise still
     * waiting, or a later batch would await a promise nobody will ever resolve and
     * the run would hang rather than fail.
     */
    releaseAll(settlers, cache, messageOf(error), "upload");
    throw error;
  }
}

/**
 * Copy every image to S3 and rewrite the products to point at the bucket.
 *
 * A missing or half-finished S3 configuration THROWS rather than quietly
 * falling back to the original links: someone who picked S3 wants the images in
 * the bucket, and discovering months later that a run linked to a supplier's
 * CDN instead is far worse than a batch that fails immediately.
 *
 * The same rule now covers a second, worse failure. Falling back to ANOTHER
 * ACCOUNT's bucket when this one has none configured would put one customer's
 * product images in another customer's storage, and publish them at that
 * customer's domain. There is no fallback: no credentials means no run.
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

  if (urls.length === 0) {
    return { products, failures: [] };
  }

  const fresh = urls.filter((url) => !cache.has(url));
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

    for (const result of await inLanes(fresh, DOWNLOAD_LANES, async (url) => {
      try {
        return { url, uploaded: await uploader.upload(url) };
      } catch (error) {
        return { url, error: messageOf(error) };
      }
    })) {
      if (result.uploaded !== undefined) {
        settle(settlers, result.url, { url: result.uploaded });
      } else {
        // The whole hop is this process's own work — fetch then put — so the split
        // that `upload_site` can make between "their CDN" and "your site" is not
        // available here. An S3 failure is reported as a download failure because
        // that is what it almost always is.
        const error = result.error ?? "Upload failed";
        failures.push({ url: result.url, error, reason: "download" });
        settle(settlers, result.url, { url: null, error, reason: "download" });
      }
    }

    return await finish(products, urls, failures, cache, settlers);
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
 * `urls` is every image in THIS batch, including ones an earlier batch already
 * staged — their result comes back out of the cache. Note that `failures` holds only
 * what this call discovered: a failure another batch reported was reported then, and
 * counting it again per batch that mentions the same image would inflate the number
 * the operator reads.
 */
async function finish(
  products: Product[],
  urls: string[],
  failures: ImageFailure[],
  cache: ImageCache,
  settlers: Map<string, (image: StagedImage) => void>,
): Promise<ImageStageResult> {
  // Anything left unsettled would deadlock a later batch. Nothing should reach
  // here, so this is a backstop rather than a path.
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
   * Caching a failure would let one transient hiccup — a CDN blip on the first
   * batch — poison every later batch of a run that might take hours. Successes stay,
   * because that is the whole saving.
   */
  for (const url of urls) {
    const staged = await cache.get(url);
    if (staged !== undefined && staged.url === null) {
      cache.delete(url);
    }
  }

  return { products: products.map((product) => rewrite(product, mapping)), failures };
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

/** Run `work` over `items` with a fixed number of lanes, keeping input order. */
async function inLanes<T, R>(
  items: T[],
  lanes: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;

      if (index >= items.length) {
        return;
      }

      results[index] = await work(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, () => lane()));

  return results;
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
