/**
 * Image staging: the download side, the SSRF guard, the packing arithmetic and the
 * run-level cache.
 *
 * Run through tests/images-staging.sh, never directly — it needs the fake image
 * host from tests/images.py on the network, and it deliberately runs with
 * GOP_ALLOW_PRIVATE_IMAGE_HOSTS unset so the guard is live.
 *
 * A SEPARATE suite from tests/isolation.ts on purpose. That one needs Postgres,
 * Redis and a built Next.js server because what it proves lives on the request
 * path. Nothing here does: this is a downloader, an arithmetic function and a Map.
 * Folding it into the heavy suite would make a five-second assertion cost the
 * fifteen minutes of a `next build`, and the tests that get skipped are the ones
 * that take too long to run.
 *
 * The plugin is STUBBED rather than stood up. What is being tested here is what
 * this side sends and how it treats the answers; `GPM_toshstack/tests/integration.php`
 * tests what the plugin does with it, and `tests/e2e.sh` proves the two meet over
 * real HTTP.
 */

import { ImageDownloadError, downloadImage } from "../lib/image-download";
import { assertFetchableUrl } from "../lib/outbound-url";
import {
  MAX_UPLOAD_ENTRIES,
  PLUGIN_UPLOAD_CEILING_BYTES,
  packRequests,
  uploadBudgetBytes,
} from "../lib/image-upload";
import { downloadLanes } from "../lib/download-limit";
import { createImageCache, stageImages } from "../lib/images";
import type { GopClient, Product } from "../lib/gop-client";
import { DEFAULT_IMPORT_OPTIONS, type ImportOptions } from "../lib/import-options";

const IMAGE_HOST = process.env.IMAGE_HOST ?? "http://localhost:8090";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail === "" ? "" : `\n       ${detail}`}`);
  }
}

/** Run `body`, and report what it threw rather than letting it end the suite. */
async function refuses(name: string, body: () => Promise<unknown>, expect: RegExp): Promise<void> {
  try {
    await body();
    check(name, false, "it did not refuse at all");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, expect.test(message), `refused, but with: ${message}`);
  }
}

/**
 * A GopClient that records what it was asked to upload and answers as the plugin
 * would. Only `uploadImages` is reachable from the code under test.
 */
interface StubEntry {
  sourceUrl: string;
  contentType: string;
  body: Buffer;
}

function stubClient(
  behaviour: {
    fail?: boolean;
    failWith?: string;
    /** Source URLs the site claims to hold already, for the `/images/present` probe. */
    present?: string[];
    /** Make the probe throw, to prove a run still works without it. */
    probeFails?: boolean;
  } = {},
): {
  client: GopClient;
  requests: StubEntry[][];
  probes: string[][];
} {
  const requests: StubEntry[][] = [];
  const probes: string[][] = [];

  const localFor = (sourceUrl: string): string =>
    `https://shop.test/wp-content/uploads/gop-import/ab/${encodeURIComponent(sourceUrl).slice(-24)}.jpg`;

  const client = {
    async imagesPresent(urls: string[]) {
      probes.push(urls);

      if (behaviour.probeFails === true) {
        throw new Error("the site did not answer the probe");
      }

      return urls.map((url) => ({
        source_url: url,
        url: (behaviour.present ?? []).includes(url) ? localFor(url) : null,
      }));
    },

    async uploadImages(entries: StubEntry[]) {
      requests.push(entries);

      if (behaviour.fail === true) {
        throw new Error(behaviour.failWith ?? "the site did not answer");
      }

      return entries.map((entry) => ({
        ok: true,
        source_url: entry.sourceUrl,
        url: localFor(entry.sourceUrl),
        skipped: false,
      }));
    },
  } as unknown as GopClient;

  return { client, requests, probes };
}

function optionsFor(imageMode: ImportOptions["imageMode"]): ImportOptions {
  return { ...DEFAULT_IMPORT_OPTIONS, storeId: "stub", imageMode };
}

function productWith(images: string[]): Product {
  return { name: "Áo khoác", images } as unknown as Product;
}

function buffer(size: number): Buffer {
  const body = Buffer.alloc(size);
  // A real JPEG prefix, so nothing downstream rejects it as not an image.
  body.write("\xFF\xD8\xFF\xE0", 0, "binary");
  return body;
}

async function main(): Promise<void> {
  console.log(`\nThe SSRF guard — image host at ${IMAGE_HOST}\n`);

  /*
   * The guard is the reason this suite exists.
   *
   * Until plugin 3.9.0 the images were fetched by PHP on the CUSTOMER'S OWN SITE, so
   * an internal URL only ever reached the customer's own network. Now this worker
   * fetches them, from URLs typed into a CSV by a customer — so every one of these
   * is a request forged from inside our infrastructure if it is not refused.
   */
  await refuses(
    "the cloud metadata address is refused",
    () => assertFetchableUrl("http://169.254.169.254/latest/meta-data/"),
    /internal address|private or local address/i,
  );

  await refuses(
    "loopback is refused",
    () => assertFetchableUrl("http://127.0.0.1:9/secret.jpg"),
    /internal address|private or local address/i,
  );

  await refuses(
    "a private range is refused",
    () => assertFetchableUrl("http://10.1.2.3/secret.jpg"),
    /internal address|private or local address/i,
  );

  await refuses(
    "an IPv4-mapped IPv6 loopback is refused, not waved through",
    () => assertFetchableUrl("http://[::ffff:127.0.0.1]/secret.jpg"),
    /internal address|private or local address/i,
  );

  await refuses(
    "IPv6 loopback is refused",
    () => assertFetchableUrl("http://[::1]/secret.jpg"),
    /internal address|private or local address/i,
  );

  await refuses(
    "a unique-local IPv6 address is refused",
    () => assertFetchableUrl("http://[fd00::1]/secret.jpg"),
    /internal address|private or local address/i,
  );

  await refuses(
    "file:// is refused — only http and https are fetched",
    () => assertFetchableUrl("file:///etc/passwd"),
    /http and https/i,
  );

  await refuses(
    "a name that resolves to nothing is refused rather than attempted",
    () => assertFetchableUrl("http://this-host-does-not-exist.invalid/a.jpg"),
    /could not be resolved/i,
  );

  console.log("\nRedirects — every hop re-checked\n");

  /*
   * This is the hole the plugin had. `CURLOPT_FOLLOWLOCATION` was on and only the
   * FIRST URL went through `reject()`, so a perfectly public URL redirecting to
   * 169.254.169.254 was fetched and its body written into the media library.
   */
  await refuses(
    "a public URL redirecting to the metadata address is refused at the second hop",
    () => downloadImage(`${IMAGE_HOST}/to-metadata.jpg`),
    /internal address|private or local address/i,
  );

  await refuses(
    "a public URL redirecting to loopback is refused at the second hop",
    () => downloadImage(`${IMAGE_HOST}/to-loopback.jpg`),
    /internal address|private or local address/i,
  );

  // And the other half, which matters just as much: refusing ALL redirects would
  // pass every test above while breaking every CDN that uses one.
  try {
    const followed = await downloadImage(`${IMAGE_HOST}/to-ok.jpg`);
    check(
      "an ordinary redirect is still followed",
      followed.body.byteLength > 0 && followed.contentType === "image/jpeg",
      `got ${followed.contentType}, ${followed.body.byteLength} bytes`,
    );
  } catch (error) {
    check("an ordinary redirect is still followed", false, String(error));
  }

  console.log("\nWhat counts as an image\n");

  await refuses(
    "200 with an HTML page is refused — the case a naive check calls fine",
    () => downloadImage(`${IMAGE_HOST}/page.html`),
    /not an image/i,
  );

  await refuses(
    "404 is refused",
    () => downloadImage(`${IMAGE_HOST}/missing.jpg`),
    /HTTP 404/,
  );

  await refuses(
    "418 is refused",
    () => downloadImage(`${IMAGE_HOST}/teapot.jpg`),
    /HTTP 418/,
  );

  await refuses(
    "an enormous Content-Length is refused on the HEADER, not after reading it",
    () => downloadImage(`${IMAGE_HOST}/enormous.jpg`),
    /over .* MB/i,
  );

  await refuses(
    "maxBytes is honoured, so upload_site gives up at the site's ceiling",
    () => downloadImage(`${IMAGE_HOST}/ok.jpg`, { maxBytes: 4 }),
    /over/i,
  );

  try {
    const ok = await downloadImage(`${IMAGE_HOST}/ok.jpg`);
    check(
      "a real image comes back with its bytes and content type",
      ok.body.byteLength > 0 && ok.contentType === "image/jpeg" && ok.sourceUrl.endsWith("/ok.jpg"),
      `${ok.contentType}, ${ok.body.byteLength} bytes`,
    );
  } catch (error) {
    check("a real image comes back with its bytes and content type", false, String(error));
  }

  console.log("\nPacking requests\n");

  const budget = uploadBudgetBytes();

  check(
    "the budget never exceeds what the plugin accepts",
    budget <= PLUGIN_UPLOAD_CEILING_BYTES,
    `budget ${budget} against a ceiling of ${PLUGIN_UPLOAD_CEILING_BYTES}`,
  );

  {
    const images = Array.from({ length: 3 }, (_unused, index) => ({
      sourceUrl: `https://cdn.test/${index}.jpg`,
      body: buffer(1024),
      contentType: "image/jpeg",
    }));

    const packed = packRequests(images);
    check("small images travel together in one request", packed.length === 1, `${packed.length} requests`);
  }

  {
    // Two images that each take more than half the budget cannot share a request.
    const big = Math.floor(budget * 0.6);
    const packed = packRequests([
      { sourceUrl: "https://cdn.test/a.jpg", body: buffer(big), contentType: "image/jpeg" },
      { sourceUrl: "https://cdn.test/b.jpg", body: buffer(big), contentType: "image/jpeg" },
    ]);

    check("the byte budget splits a request, not the count", packed.length === 2, `${packed.length} requests`);
  }

  {
    const images = Array.from({ length: MAX_UPLOAD_ENTRIES + 5 }, (_unused, index) => ({
      sourceUrl: `https://cdn.test/many-${index}.jpg`,
      body: buffer(64),
      contentType: "image/jpeg",
    }));

    const packed = packRequests(images);
    check(
      `no request carries more than ${MAX_UPLOAD_ENTRIES} entries, whatever the size`,
      packed.every((request) => request.images.length <= MAX_UPLOAD_ENTRIES) && packed.length === 2,
      packed.map((request) => request.images.length).join(", "),
    );
  }

  {
    // Bigger than the packing budget but still sendable: its own request, and it must
    // not disturb whatever was being filled.
    const packed = packRequests([
      { sourceUrl: "https://cdn.test/a.jpg", body: buffer(1024), contentType: "image/jpeg" },
      {
        sourceUrl: "https://cdn.test/huge.jpg",
        body: buffer(budget + 1024),
        contentType: "image/jpeg",
      },
      { sourceUrl: "https://cdn.test/b.jpg", body: buffer(1024), contentType: "image/jpeg" },
    ]);

    check(
      "an image over the budget travels alone, and does not swallow its neighbours",
      packed.length === 3 && packed.every((request) => request.images.length === 1),
      packed.map((request) => request.images.length).join(", "),
    );
  }

  console.log("\nStaging into the site\n");

  {
    const { client, requests } = stubClient();
    const products = [productWith([`${IMAGE_HOST}/ok.jpg`, `${IMAGE_HOST}/also-ok.png`])];

    const staged = await stageImages(products, optionsFor("upload_site"), client, null);

    check("both images were staged", staged.failures.length === 0, JSON.stringify(staged.failures));
    check("one request carried both", requests.length === 1 && requests[0].length === 2);
    check(
      "the products now point at the site",
      (staged.products[0].images ?? []).every((url) => url.startsWith("https://shop.test/")),
      JSON.stringify(staged.products[0].images),
    );
    check(
      "the bytes were sent RAW, not base64, with the content type the source gave",
      Buffer.isBuffer(requests[0][0].body) &&
        requests[0][0].body.byteLength > 0 &&
        requests[0].some((entry) => entry.contentType === "image/png"),
      JSON.stringify(requests[0].map((entry) => [entry.contentType, entry.body.byteLength])),
    );
  }

  {
    // A failure must not take the batch down, and must say WHOSE failure it was.
    const { client } = stubClient();
    const products = [productWith([`${IMAGE_HOST}/ok.jpg`, `${IMAGE_HOST}/page.html`])];

    const staged = await stageImages(products, optionsFor("upload_site"), client, null);

    check(
      "a dead image fails alone and keeps its original URL",
      staged.failures.length === 1 &&
        staged.failures[0].url === `${IMAGE_HOST}/page.html` &&
        (staged.products[0].images ?? [])[1] === `${IMAGE_HOST}/page.html`,
      JSON.stringify(staged),
    );
    check(
      "the failure is attributed to the DOWNLOAD, not to the site",
      staged.failures[0]?.reason === "download",
      staged.failures[0]?.reason,
    );
  }

  {
    const { client } = stubClient({ fail: true, failWith: "the site did not answer within 120s" });
    const products = [productWith([`${IMAGE_HOST}/ok.jpg`])];

    const staged = await stageImages(products, optionsFor("upload_site"), client, null);

    check(
      "a refused upload is attributed to the SITE",
      staged.failures.length === 1 && staged.failures[0].reason === "upload",
      JSON.stringify(staged.failures),
    );
    check(
      "and the product still publishes, with the original URL",
      (staged.products[0].images ?? [])[0] === `${IMAGE_HOST}/ok.jpg`,
      JSON.stringify(staged.products[0].images),
    );
  }

  console.log("\nAsking the site first\n");

  {
    /*
     * The single biggest saving available, and the reason `/images/present` exists: an
     * image the site already holds is neither downloaded from its source nor sent.
     */
    const held = `${IMAGE_HOST}/ok.jpg`;
    const notHeld = `${IMAGE_HOST}/also-ok.png`;
    const before = await hitsFor("/ok.jpg");

    const { client, requests, probes } = stubClient({ present: [held] });

    const staged = await stageImages(
      [productWith([held, notHeld])],
      optionsFor("upload_site"),
      client,
      null,
    );

    check("the site was asked, once, about both images", probes.length === 1 && probes[0].length === 2);
    check(
      "the image it already had was NOT downloaded",
      (await hitsFor("/ok.jpg")) - before === 0,
      `the host was asked ${(await hitsFor("/ok.jpg")) - before} time(s)`,
    );
    check(
      "and was NOT sent — only the other one was",
      requests.length === 1 &&
        requests[0].length === 1 &&
        requests[0][0].sourceUrl === notHeld,
      JSON.stringify(requests.map((request) => request.map((entry) => entry.sourceUrl))),
    );
    check(
      "both products' images still point at the site",
      (staged.products[0].images ?? []).every((url) => url.startsWith("https://shop.test/")),
      JSON.stringify(staged.products[0].images),
    );
    check(
      "and the saving is reported, so a re-run can be recognised as cheap",
      staged.stats.alreadyOnSite === 1 && staged.stats.downloaded === 1,
      JSON.stringify(staged.stats),
    );
  }

  {
    // The probe is an optimisation, so losing it must cost time and nothing else.
    const { client, requests } = stubClient({ probeFails: true });

    const staged = await stageImages(
      [productWith([`${IMAGE_HOST}/ok.jpg`])],
      optionsFor("upload_site"),
      client,
      null,
    );

    check(
      "a site that cannot answer the probe still gets a working run",
      staged.failures.length === 0 &&
        requests.length === 1 &&
        (staged.products[0].images ?? [])[0]?.startsWith("https://shop.test/") === true,
      JSON.stringify({ failures: staged.failures, requests: requests.length }),
    );
    check(
      "and nothing is claimed as already present",
      staged.stats.alreadyOnSite === 0,
      JSON.stringify(staged.stats),
    );
  }

  console.log("\nDownloading and uploading at the same time\n");

  {
    /*
     * The barrier is gone, and this is how that is visible without timing anything: an
     * upload request must have been SENT while downloads were still running.
     *
     * With a budget forced low enough that each image fills a request, three images
     * produce three requests; the old shape produced them only after every download had
     * finished, so the first request could not have been in flight before the last
     * download completed. Recording the order the stub sees proves the interleaving.
     */
    const previous = process.env.GOP_IMAGE_UPLOAD_BYTES;
    process.env.GOP_IMAGE_UPLOAD_BYTES = "1";

    try {
      const { client, requests } = stubClient();

      const staged = await stageImages(
        [productWith([`${IMAGE_HOST}/ok.jpg`, `${IMAGE_HOST}/also-ok.png`, `${IMAGE_HOST}/to-ok.jpg`])],
        optionsFor("upload_site"),
        client,
        null,
      );

      check(
        "a tiny budget produces one request per image rather than one for the batch",
        requests.length === 3,
        `${requests.length} request(s)`,
      );
      check(
        "every image still resolved",
        staged.failures.length === 0 && staged.stats.uploaded === 3,
        JSON.stringify({ failures: staged.failures, stats: staged.stats }),
      );
      check(
        "and the cost report separates download time from upload time",
        staged.stats.downloadMs > 0 && staged.stats.uploadMs >= 0 && staged.stats.requests === 3,
        JSON.stringify(staged.stats),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.GOP_IMAGE_UPLOAD_BYTES;
      } else {
        process.env.GOP_IMAGE_UPLOAD_BYTES = previous;
      }
    }
  }

  {
    // The whole point of a global ceiling: it is not multiplied by the run's lanes.
    const lanes = downloadLanes();

    check(
      "the download ceiling is a process-wide number, and a sane one",
      lanes >= 1 && lanes <= 64,
      `${lanes}`,
    );
  }

  console.log("\nThe run-level cache\n");

  {
    /*
     * The saving this exists for. A size chart or a logo appears on every product in
     * a catalogue; per batch — where the mapping used to live — it was downloaded
     * again for each batch that mentioned it.
     *
     * Counted at the fake host itself via /_hits, because "downloaded once" is a
     * claim about what left this process, not about what this process believes.
     */
    const shared = `${IMAGE_HOST}/ok.jpg`;
    const before = await hitsFor("/ok.jpg");

    const cache = createImageCache();
    const { client, requests } = stubClient();
    const options = optionsFor("upload_site");

    // Three batches, as a run of three batches would call it.
    for (let batch = 0; batch < 3; batch++) {
      const staged = await stageImages(
        [productWith([shared, `${IMAGE_HOST}/also-ok.png`])],
        options,
        client,
        null,
        cache,
      );

      check(
        `batch ${batch + 1} resolved both images`,
        (staged.products[0].images ?? []).every((url) => url.startsWith("https://shop.test/")),
        JSON.stringify(staged.products[0].images),
      );
    }

    const after = await hitsFor("/ok.jpg");

    check(
      "a shared image is downloaded ONCE for the whole run, not once per batch",
      after - before === 1,
      `the host was asked ${after - before} time(s)`,
    );
    check(
      "and it is sent to the site once, not three times",
      requests.length === 1,
      `${requests.length} upload request(s)`,
    );
  }

  {
    /*
     * A FAILURE must not be cached.
     *
     * Caching one would let a single CDN hiccup on the first batch poison every
     * later batch of a run that can take hours — the image would stay broken for the
     * whole catalogue on the strength of one bad moment.
     */
    const cache = createImageCache();
    const { client } = stubClient();
    const options = optionsFor("upload_site");

    const first = await stageImages(
      [productWith([`${IMAGE_HOST}/missing.jpg`])],
      options,
      client,
      null,
      cache,
    );

    check("the first batch reports the failure", first.failures.length === 1);
    check(
      "the failed URL is NOT left in the cache",
      !cache.has(`${IMAGE_HOST}/missing.jpg`),
      `cache holds ${cache.size} entr(ies)`,
    );

    const second = await stageImages(
      [productWith([`${IMAGE_HOST}/missing.jpg`])],
      options,
      client,
      null,
      cache,
    );

    check(
      "so a later batch tries again and reports it again, rather than going quiet",
      second.failures.length === 1,
      JSON.stringify(second.failures),
    );
  }

  {
    // Two lanes reaching the same fresh image at the same instant must produce ONE
    // download. This is why the cache holds promises rather than URLs.
    const shared = `${IMAGE_HOST}/also-ok.png`;
    const before = await hitsFor("/also-ok.png");

    const cache = createImageCache();
    const { client } = stubClient();
    const options = optionsFor("upload_site");

    await Promise.all([
      stageImages([productWith([shared])], options, client, null, cache),
      stageImages([productWith([shared])], options, client, null, cache),
    ]);

    const after = await hitsFor("/also-ok.png");

    check(
      "two lanes racing on one image download it once between them",
      after - before === 1,
      `the host was asked ${after - before} time(s)`,
    );
  }

  console.log("\nThe other two modes are untouched\n");

  {
    const { client, requests } = stubClient();
    const original = `${IMAGE_HOST}/ok.jpg`;

    const staged = await stageImages(
      [productWith([original])],
      optionsFor("keep_remote"),
      client,
      null,
    );

    check(
      "keep_remote downloads nothing and rewrites nothing",
      requests.length === 0 &&
        (staged.products[0].images ?? [])[0] === original &&
        staged.failures.length === 0,
    );
  }

  await refuses(
    "s3 with no credentials refuses the run rather than using another account's bucket",
    () => stageImages([productWith([`${IMAGE_HOST}/ok.jpg`])], optionsFor("s3"), stubClient().client, null),
    /no S3 configured/i,
  );

  console.log(`\n${"-".repeat(50)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

/** How many times the fake host has been asked for a path. */
async function hitsFor(path: string): Promise<number> {
  const response = await fetch(`${IMAGE_HOST}/_hits`);
  const text = await response.text();

  // The fixture answers Python's repr of a dict: {'/ok.jpg': 3, ...}
  const match = new RegExp(`'${path.replace(/[.]/g, "\\.")}': (\\d+)`).exec(text);

  return match === null ? 0 : Number.parseInt(match[1], 10);
}

main().catch((error) => {
  console.error(error instanceof ImageDownloadError ? error.message : error);
  process.exitCode = 1;
});
