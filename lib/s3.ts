/*
 * Do NOT import "server-only" here — this module is in the worker's import graph.
 */

import { createHash } from "node:crypto";

import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import { downloadImage } from "./image-download";
import type { S3Credentials } from "./settings";

/**
 * Copy product images into an S3 bucket and hand back the public URL.
 *
 * The object key is derived from the source URL with a hash, never from a
 * counter or the clock. Two consequences worth having:
 *
 *  - re-running the same file uploads nothing the second time, because the key
 *    already exists;
 *  - the same image referenced by ten products is stored once.
 */

export class S3ConfigError extends Error {}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

export class S3Uploader {
  private readonly client: S3Client;

  constructor(private readonly credentials: S3Credentials) {
    if (credentials.bucket === "" || credentials.region === "") {
      throw new S3ConfigError("S3 is missing a bucket or a region.");
    }

    this.client = new S3Client({
      region: credentials.region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
  }

  /**
   * Upload one image and return the URL to publish.
   *
   * A URL that already points at the configured public base is returned
   * untouched: it is already in the bucket, and fetching it only to write it
   * back would double the traffic for nothing.
   */
  async upload(sourceUrl: string): Promise<string> {
    if (this.isAlreadyOurs(sourceUrl)) {
      return sourceUrl;
    }

    const key = this.keyFor(sourceUrl);

    if (await this.exists(key)) {
      return this.publicUrlFor(key);
    }

    /*
     * The download now comes from `lib/image-download.ts`, shared with the
     * "copy into the site's media library" mode.
     *
     * TWO CHANGES IN BEHAVIOUR come with it, both fixes, both worth knowing:
     * a URL resolving to an internal address is refused, and a source that answers
     * 200 with an HTML page is refused. The private `fetchImage` this replaced
     * checked neither, so a CDN's own "not found" page could be uploaded to the
     * bucket and published as a product photo.
     */
    const { body, contentType } = await downloadImage(sourceUrl);

    // Re-derive the key once the content type is known: the extension guessed
    // from a URL with no path suffix would otherwise be wrong.
    const finalKey = this.keyFor(sourceUrl, contentType);

    await new Upload({
      client: this.client,
      params: {
        Bucket: this.credentials.bucket,
        Key: finalKey,
        Body: body,
        ContentType: contentType,
        // Images are served straight from the bucket or a CDN in front of it,
        // and they never change once written — the key is a content address.
        CacheControl: "public, max-age=31536000, immutable",
      },
    }).done();

    return this.publicUrlFor(finalKey);
  }

  /** Cheap reachability probe for the Settings screen. */
  async check(): Promise<void> {
    await this.client.send(
      new HeadObjectCommand({
        Bucket: this.credentials.bucket,
        Key: `${this.prefix()}__gop_import_probe__`,
      }),
    );
  }

  destroy(): void {
    this.client.destroy();
  }

  private prefix(): string {
    const prefix = this.credentials.prefix.replace(/^\/+|\/+$/g, "");
    return prefix === "" ? "" : `${prefix}/`;
  }

  private keyFor(sourceUrl: string, contentType?: string): string {
    const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 32);
    return `${this.prefix()}${hash}${extensionFor(sourceUrl, contentType)}`;
  }

  private publicUrlFor(key: string): string {
    const base =
      this.credentials.publicUrl !== ""
        ? this.credentials.publicUrl.replace(/\/$/, "")
        : `https://${this.credentials.bucket}.s3.${this.credentials.region}.amazonaws.com`;

    return `${base}/${key}`;
  }

  private isAlreadyOurs(url: string): boolean {
    return this.credentials.publicUrl !== "" && url.startsWith(this.credentials.publicUrl);
  }

  private async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.credentials.bucket, Key: key }),
      );
      return true;
    } catch {
      // 404 and 403-on-missing both land here. Treating "unknown" as "absent"
      // costs one redundant upload; treating it as "present" would publish a
      // URL that serves nothing.
      return false;
    }
  }
}

/** Extension from the content type first, falling back to the URL path. */
function extensionFor(url: string, contentType?: string): string {
  if (contentType) {
    const known = EXTENSION_BY_TYPE[contentType.split(";")[0].trim().toLowerCase()];
    if (known) {
      return known;
    }
  }

  try {
    const path = new URL(url).pathname;
    const match = /\.(jpe?g|png|gif|webp|avif|svg)$/i.exec(path);
    if (match) {
      return `.${match[1].toLowerCase().replace("jpeg", "jpg")}`;
    }
  } catch {
    // Not a parseable URL; the caller will have failed on the fetch anyway.
  }

  return ".jpg";
}
