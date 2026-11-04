/**
 * "Upload to Amazon S3" never publishes a source link.
 *
 * Run through tests/s3-only.sh. A fake bucket stands in for S3, so there is no Docker,
 * no network and no database: what is under test is what `stageImages` does when an
 * upload fails — retry, then HOLD the product — and not the AWS SDK.
 */

import { stageImages, type S3StageDeps } from "../lib/images";
import { DEFAULT_IMPORT_OPTIONS, type ImportOptions } from "../lib/import-options";
import type { GopClient, Product } from "../lib/gop-client";
import type { S3Credentials } from "../lib/settings";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail === "" ? "" : `\n       ${detail}`}`);
  }
}

const CREDENTIALS: S3Credentials = {
  enabled: true,
  accessKeyId: "k",
  secretAccessKey: "s",
  bucket: "bucket",
  region: "ap-southeast-1",
  publicUrl: "https://cdn.example.com",
  prefix: "",
};

const options = (imageMode: ImportOptions["imageMode"]): ImportOptions => ({
  ...DEFAULT_IMPORT_OPTIONS,
  storeId: "stub",
  imageMode,
});

const noClient = {} as unknown as GopClient;

const product = (name: string, images: string[], variationImage?: string): Product =>
  ({
    name,
    images,
    variations: variationImage === undefined ? [] : [{ sku: `${name}-v`, image: variationImage }],
  }) as unknown as Product;

/**
 * A bucket whose uploads fail according to `failures`: how many times each source URL
 * fails before it works. `Infinity` is a URL that never does.
 */
function fakeBucket(failures: Record<string, number> = {}): {
  deps: S3StageDeps;
  attempts: Map<string, number>;
} {
  const attempts = new Map<string, number>();

  return {
    attempts,
    deps: {
      retryDelaysMs: [0, 0],
      uploader: () => ({
        upload: async (url: string) => {
          const seen = (attempts.get(url) ?? 0) + 1;
          attempts.set(url, seen);

          if (seen <= (failures[url] ?? 0)) {
            throw new Error(`503 SlowDown for ${url}`);
          }

          return `https://cdn.example.com/${encodeURIComponent(url)}`;
        },
        destroy: () => undefined,
      }),
    },
  };
}

const URLS_OF = (p: Product): string[] => [
  ...(p.images ?? []),
  ...(p.variations ?? []).flatMap((v) => [v.image ?? "", ...(v.images ?? [])]).filter((u) => u !== ""),
];

async function main(): Promise<void> {
  console.log("\nS3 only");

  {
    const { deps } = fakeBucket();
    const staged = await stageImages(
      [product("a", ["https://src/a.jpg"]), product("b", ["https://src/b.jpg"])],
      options("s3"),
      noClient,
      CREDENTIALS,
      undefined,
      deps,
    );

    check("every upload working: nothing held, every image is the bucket's", staged.held.length === 0 &&
      staged.products.every((p) => URLS_OF(p).every((u) => u.startsWith("https://cdn.example.com/"))));
  }

  {
    const { deps, attempts } = fakeBucket({ "https://src/slow.jpg": 2 });
    const staged = await stageImages(
      [product("a", ["https://src/slow.jpg"])],
      options("s3"),
      noClient,
      CREDENTIALS,
      undefined,
      deps,
    );

    check(
      "a throttled upload that recovers on the third attempt is NOT held",
      staged.held.length === 0 && attempts.get("https://src/slow.jpg") === 3,
      `attempts ${attempts.get("https://src/slow.jpg")}, held ${staged.held.length}`,
    );
  }

  {
    const { deps, attempts } = fakeBucket({ "https://src/dead.jpg": Infinity });
    const staged = await stageImages(
      [
        product("ok", ["https://src/fine.jpg"]),
        product("bad", ["https://src/fine2.jpg", "https://src/dead.jpg"]),
      ],
      options("s3"),
      noClient,
      CREDENTIALS,
      undefined,
      deps,
    );

    check(
      "an image that never uploads holds ITS product, and only that one",
      staged.held.length === 1 && staged.held[0].index === 1,
      JSON.stringify(staged.held),
    );
    check("it was retried three times before giving up", attempts.get("https://src/dead.jpg") === 3);
    check(
      "the held product's failing URL is reported with the cause",
      staged.held[0]?.urls.join() === "https://src/dead.jpg" && /SlowDown/.test(staged.held[0]?.error ?? ""),
    );
    check(
      "the product that did upload is fully rewritten to the bucket",
      URLS_OF(staged.products[0]).every((u) => u.startsWith("https://cdn.example.com/")),
    );
  }

  {
    const { deps } = fakeBucket({ "https://src/var.jpg": Infinity });
    const staged = await stageImages(
      [product("variable", ["https://src/main.jpg"], "https://src/var.jpg")],
      options("s3"),
      noClient,
      CREDENTIALS,
      undefined,
      deps,
    );

    check("a variation image that fails holds the product too", staged.held.length === 1);
  }

  {
    const cache = new Map();
    const first = fakeBucket({ "https://src/x.jpg": Infinity });
    await stageImages([product("a", ["https://src/x.jpg"])], options("s3"), noClient, CREDENTIALS, cache, first.deps);

    const second = fakeBucket();
    const staged = await stageImages(
      [product("a", ["https://src/x.jpg"])],
      options("s3"),
      noClient,
      CREDENTIALS,
      cache,
      second.deps,
    );

    check(
      "a failure is not cached, so a later batch of the same run tries again and can succeed",
      staged.held.length === 0 && second.attempts.get("https://src/x.jpg") === 1,
    );
  }

  {
    const staged = await stageImages(
      [product("a", ["https://src/a.jpg"])],
      options("keep_remote"),
      noClient,
      null,
    );

    check("keep_remote is untouched: nothing held, link unchanged", staged.held.length === 0 && staged.products[0].images?.[0] === "https://src/a.jpg");
  }

  console.log(`\n${"-".repeat(50)}\nPassed: ${passed}   Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
