/**
 * How a rate-limited image is retried.
 *
 * Run through tests/image-retry.sh. No Docker, no network, no database: a fake bucket
 * and a fake clock, so ten attempts at thirty seconds each take no time at all.
 *
 * What is pinned here: 429 is retried in place up to ten times and then PARKED (never
 * linked); a 404 is not retried; a throttled host pauses and slows every lane, not
 * only the one that was refused; and a Retry-After is honoured.
 */

import { ImageDownloadError, parseRetryAfter } from "../lib/image-download";
import {
  HostGate,
  MAX_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  THROTTLE_ATTEMPTS,
  backoffMs,
  classifyImageError,
  realClock,
  type Clock,
} from "../lib/image-retry";
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

/** Time that only moves when something sleeps — so a 30s wait costs nothing. */
function fakeClock(): Clock & { t: number } {
  return {
    t: 1_000_000,
    now() {
      return this.t;
    },
    async sleep(ms: number, signal?: AbortSignal) {
      if (signal?.aborted === true) {
        throw new Error("Aborted");
      }
      this.t += ms;
    },
  };
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

const OPTIONS: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS, storeId: "stub", imageMode: "s3" };
const noClient = {} as unknown as GopClient;
const product = (name: string, images: string[]): Product => ({ name, images }) as unknown as Product;

/** An uploader that throws whatever `script(url, attempt)` says, or succeeds on null. */
function scripted(script: (url: string, attempt: number) => unknown | null): {
  deps: (extra?: Partial<S3StageDeps>) => S3StageDeps;
  attempts: Map<string, number>;
  clock: Clock & { t: number };
  gate: HostGate;
} {
  const attempts = new Map<string, number>();
  const clock = fakeClock();
  const gate = new HostGate(16, clock);

  return {
    attempts,
    clock,
    gate,
    deps: (extra = {}) => ({
      gate,
      retryDelaysMs: [0, 0],
      random: () => 0.5,
      uploader: () => ({
        upload: async (url: string) => {
          const attempt = (attempts.get(url) ?? 0) + 1;
          attempts.set(url, attempt);

          const failure = script(url, attempt);
          if (failure !== null) {
            throw failure;
          }

          return `https://cdn.example.com/${encodeURIComponent(url)}`;
        },
        destroy: () => undefined,
      }),
      ...extra,
    }),
  };
}

const tooMany = (retryAfterMs?: number): ImageDownloadError =>
  new ImageDownloadError("HTTP 429 fetching the image", 429, retryAfterMs);

async function main(): Promise<void> {
  console.log("\nClassifying a failure");

  check("429 from the source is throttled", classifyImageError(tooMany()).kind === "throttled");
  check(
    "a Retry-After on it is carried through",
    classifyImageError(tooMany(7000)).retryAfterMs === 7000,
  );
  check("404 is permanent", classifyImageError(new ImageDownloadError("HTTP 404", 404)).kind === "permanent");
  check("403 is permanent", classifyImageError(new ImageDownloadError("HTTP 403", 403)).kind === "permanent");
  check("503 is transient", classifyImageError(new ImageDownloadError("HTTP 503", 503)).kind === "transient");
  check(
    "this app's own refusal (no status) is permanent",
    classifyImageError(new ImageDownloadError("The URL is not an image")).kind === "permanent",
  );
  check("a plain network error is transient", classifyImageError(new Error("ECONNRESET")).kind === "transient");

  const slowDown = Object.assign(new Error("Please reduce your request rate."), {
    name: "SlowDown",
    $metadata: { httpStatusCode: 503 },
  });
  const awsClass = classifyImageError(slowDown);
  check("S3 SlowDown is throttled, and it is the bucket's pace", awsClass.kind === "throttled" && awsClass.origin === "bucket");

  console.log("\nReading Retry-After");

  check("seconds", parseRetryAfter("12") === 12_000);
  check("an HTTP date in the future", parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")) === 30_000);
  check("a date in the past is not a wait", parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT") === null);
  check("rubbish is not a wait", parseRetryAfter("soon") === null && parseRetryAfter(null) === null);

  console.log("\nBacking off");

  check("1s, 2s, 4s, 8s with no jitter", [1, 2, 3, 4].map((n) => backoffMs(n, null, () => 0.5)).join() === "1000,2000,4000,8000");
  check("capped", backoffMs(20, null, () => 0.5) === MAX_BACKOFF_MS);
  check("jitter stays within a quarter either way", backoffMs(3, null, () => 0) === 3000 && backoffMs(3, null, () => 1) === 5000);
  check("a Retry-After wins over the backoff", backoffMs(1, 7000, () => 0.5) === 7000);
  check("but not past the ceiling", backoffMs(1, 10 * 60_000) === MAX_RETRY_AFTER_MS);

  console.log("\nThe gate");

  {
    const clock = fakeClock();
    const gate = new HostGate(16, clock);

    check("a first refusal starts a pause", gate.throttled("a.example", 5000) === true);
    check("the same refusal heard by another lane does not start a second", gate.throttled("a.example", 5000) === false);
    check("lanes on that host are halved once, not once per lane", gate.snapshot("a.example").limit === 8, `limit ${gate.snapshot("a.example").limit}`);
    check("another host is untouched", gate.snapshot("b.example").limit === 16 && gate.snapshot("b.example").cooldownMs === 0);

    const before = clock.t;
    const release = await gate.acquire(["a.example"]);
    release();
    check("a lane reaching the host waits the pause out", clock.t - before >= 5000, `waited ${clock.t - before}ms`);

    const other = clock.t;
    (await gate.acquire(["b.example"]))();
    check("and a lane for another host does not", clock.t === other);

    for (let i = 0; i < 10; i++) {
      gate.succeeded(["a.example"]);
    }
    check("ten successes in a row give a lane back", gate.snapshot("a.example").limit === 9);
  }

  {
    const gate = new HostGate(2, realClock);
    gate.throttled("a.example", 0);

    let flying = 0;
    let peak = 0;

    await Promise.all(
      [1, 2, 3].map(async () => {
        const release = await gate.acquire(["a.example"]);
        flying++;
        peak = Math.max(peak, flying);
        await new Promise((resolve) => setTimeout(resolve, 30));
        flying--;
        release();
      }),
    );

    check("a throttled host really is held to fewer lanes", gate.snapshot("a.example").limit === 1 && peak === 1, `peak ${peak}`);
  }

  console.log("\nAn image that is refused with 429");

  {
    const s = scripted((_url, attempt) => (attempt <= 5 ? tooMany() : null));
    const staged = await stageImages([product("a", ["https://src.example/a.jpg"])], OPTIONS, noClient, CREDENTIALS, undefined, s.deps());

    check("is retried in place and publishes once the host relents", staged.held.length === 0 && s.attempts.get("https://src.example/a.jpg") === 6, `attempts ${s.attempts.get("https://src.example/a.jpg")}`);
  }

  {
    const s = scripted(() => tooMany());
    const url = "https://src.example/never.jpg";
    const staged = await stageImages([product("a", [url])], OPTIONS, noClient, CREDENTIALS, undefined, s.deps());

    check(`gets exactly ${THROTTLE_ATTEMPTS} attempts, then the product is held`, s.attempts.get(url) === THROTTLE_ATTEMPTS && staged.held.length === 1, `attempts ${s.attempts.get(url)}`);
    check("held as WORTH RETRYING later, not as a dead link", staged.held[0]?.permanent === false);
    check("with the reason in the message", /rate-limited after 10 attempts/.test(staged.held[0]?.error ?? ""), staged.held[0]?.error);
    check("and never linked to the source", (staged.products[0].images ?? []).length === 1 && staged.held.length === 1);
  }

  {
    const s = scripted((_url, attempt) => (attempt === 1 ? tooMany(7000) : null));
    const before = s.clock.t;
    await stageImages([product("a", ["https://src.example/a.jpg"])], OPTIONS, noClient, CREDENTIALS, undefined, s.deps());

    check("waits the Retry-After the host asked for", s.clock.t - before >= 7000, `waited ${s.clock.t - before}ms`);
  }

  {
    const pauses: string[] = [];
    const s = scripted((_url, attempt) => (attempt === 1 ? tooMany() : null));
    await stageImages(
      [product("a", ["https://src.example/a.jpg", "https://src.example/b.jpg"])],
      OPTIONS,
      noClient,
      CREDENTIALS,
      undefined,
      s.deps({ onPause: (event) => pauses.push(event.key) }),
    );

    check("the run's log hears about a pause once, not once per image", pauses.length === 1 && pauses[0] === "src.example", pauses.join());
  }

  {
    const s = scripted((_url, attempt) => (attempt === 1 ? slowDown : null));
    const staged = await stageImages([product("a", ["https://src.example/a.jpg"])], OPTIONS, noClient, CREDENTIALS, undefined, s.deps());

    check("S3's own SlowDown is absorbed the same way, and slows the bucket", staged.held.length === 0 && s.gate.snapshot("bucket").limit < 16);
  }

  console.log("\nAn image that cannot get better");

  {
    const s = scripted(() => new ImageDownloadError("HTTP 404 fetching the image", 404));
    const url = "https://src.example/gone.jpg";
    const staged = await stageImages([product("a", [url])], OPTIONS, noClient, CREDENTIALS, undefined, s.deps());

    check("a 404 is asked for ONCE", s.attempts.get(url) === 1, `attempts ${s.attempts.get(url)}`);
    check("and its product is held as permanent, so the final pass skips it", staged.held[0]?.permanent === true);
  }

  {
    const s = scripted(() => new ImageDownloadError("HTTP 503 fetching the image", 503));
    const url = "https://src.example/flaky.jpg";
    const staged = await stageImages([product("a", [url])], OPTIONS, noClient, CREDENTIALS, undefined, s.deps());

    check("a 5xx gets the short ladder: three attempts", s.attempts.get(url) === 3 && staged.held[0]?.permanent === false);
  }

  {
    const aborted = new AbortController();
    aborted.abort();
    const s = scripted(() => null);
    const url = "https://src.example/a.jpg";
    const staged = await stageImages([product("a", [url])], OPTIONS, noClient, CREDENTIALS, undefined, s.deps({ signal: aborted.signal }));

    check("a Stop ends the wait and nothing is sent to the bucket", s.attempts.get(url) === undefined && staged.held.length === 1);
  }

  console.log(`\n${"-".repeat(50)}\nPassed: ${passed}   Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
