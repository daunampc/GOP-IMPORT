/**
 * The run worker — a SEPARATE process, not part of Next.js.
 *
 * This is why closing the browser does not stop a run: the web process only
 * pushes a job into Redis and answers. This process reads the queue, calls the
 * plugin, and writes progress back to Postgres. Closing a tab or restarting
 * Next.js touches none of it.
 *
 * Run with: pnpm worker
 */

import { setTimeout as sleep } from "node:timers/promises";

import { Worker, type Job } from "bullmq";

import { closeDatabase } from "../db";
import {
  QUEUE_NAME,
  STOP_WARNING,
  appendBatchRecord,
  appendResults,
  applyBatch,
  cancelRequest,
  finishJob,
  getJobProducts,
  getJobState,
  isTerminal,
  markRunning,
  type CancelMode,
  type JobState,
  type RunResult,
} from "../lib/jobs";
import {
  batchAttempts,
  isTransientFailure,
  retryDelayMs,
  slowBatchMs,
} from "../lib/site-pressure";
import {
  createImageCache,
  stageImages,
  type ImageCache,
  type ImageFailure,
  type ImageStageStats,
} from "../lib/images";
import { downloadLanes, downloadStats, resetDownloadStats } from "../lib/download-limit";
import { describeEdit, type EditOptions } from "../lib/edit-options";
import { logJob } from "../lib/job-log";
import { notifyRunFinished } from "../lib/notify";
import { advanceSchedule } from "../lib/schedules";
import { importVerdict, productEditVerdict, removeVerdict } from "../lib/limits";
import { getEditItems } from "../lib/jobs";
import { getPurgeItems } from "../lib/purge";
import { STOP_CHANNEL, createConnection, redis } from "../lib/redis";
import { getS3Credentials, type S3Credentials } from "../lib/settings";
import { clientFor, getStoreUnscoped, type Store } from "../lib/stores";
import {
  GopAbortError,
  GopApiError,
  MAX_BATCH_SIZE,
  MAX_DELETE_BATCH,
  MAX_UPDATE_BATCH,
  type GopClient,
  type Product,
  type ProductUpdate,
} from "../lib/gop-client";
import { toProductUpdate } from "../lib/product-update";
import { WRITE_MODE_LABELS, type ImportOptions } from "../lib/import-options";
import { imageUploadSupport } from "../lib/plugin-version";
import type { PurgeOptions } from "../lib/purge-options";

const CONCURRENCY = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "4", 10);

/**
 * The runs this process is holding right now, and how to abort each one.
 *
 * Stop has to reach a request that is ALREADY IN FLIGHT, and only the process
 * making that request can abort it — no amount of database polling reaches
 * inside an open `fetch`. So the web process publishes a run id and this map is
 * what turns that id back into the AbortController the request was made with.
 *
 * An id for a run this worker is not holding is simply ignored: with several
 * workers the broadcast goes to all of them and exactly one has the run.
 */
const inFlight = new Map<string, AbortController>();

/**
 * Everything a lane needs to know about a stop having been asked for.
 *
 * Read from POSTGRES between batches rather than from a Redis flag. The flag and
 * the run row were two records of one fact with different lifetimes, and that
 * produced two live bugs — see `lib/redis.ts` for the full account.
 */
interface StopState {
  cancelled: boolean;
  mode: CancelMode | null;
}

/**
 * One batch of work, whichever kind of run it belongs to.
 *
 * Import and purge differ only in what a batch IS and what calling the plugin
 * with it returns. Everything around that — lanes, the cancel check between
 * batches, per-batch timing, writing results as they arrive — is identical, so
 * it lives in `runBatches` and is written once.
 */
interface BatchPlan<T> {
  batches: T[][];
  batchSize: number;
  lanes: number;
  /** Called per batch. `offset` is the index of the batch's first item. */
  run: (batch: T[], offset: number) => Promise<{ results: RunResult[]; pluginElapsedMs: number | null }>;
  /**
   * Rows to record when the whole batch died before the plugin answered.
   *
   * Takes the CODE as well as the message. It used to stamp every one of these
   * `batch_failed`, which flattened "the site refused the key", "the plugin is
   * missing" and "the site accepted the connection and never answered" into one
   * indistinguishable row — and the last of those is the one an operator most
   * needs to tell apart, because it is the only one where the products may have
   * landed anyway.
   */
  onBatchError: (batch: T[], offset: number, failure: BatchFailure) => RunResult[];
}

/** Why a whole batch produced no answer. */
interface BatchFailure {
  code: string;
  message: string;
}

/**
 * Name the failure from the error, rather than calling everything `batch_failed`.
 *
 * `request_timeout` is the one that matters: its message says out loud that
 * nothing here can tell whether the site committed the batch, so a row carrying
 * that code is not claiming the products were rejected.
 */
function describeFailure(error: unknown): BatchFailure {
  if (error instanceof GopApiError) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "batch_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Everything a run needs that is NOT in the run row.
 *
 * All of it is resolved from `state.createdBy` — the account that owns the run
 * — and never from "the settings", because there is no such thing any more.
 * This process has no session and no request: it must be told which account it
 * is working for, and the run row is what tells it.
 */
async function runJob(job: Job<{ jobId: string }>): Promise<void> {
  const { jobId } = job.data;

  const state = await getJobState(jobId);
  if (state === null) {
    console.warn(`[worker] skipping ${jobId}: no such run in the database.`);
    return;
  }

  /*
   * TRUST POSTGRES, NOT THE QUEUE.
   *
   * This used to check only that the run existed, and that was enough for a
   * cancelled run to come back to life. BullMQ redelivery is an ordinary
   * production event, not an edge case: this worker is built with the default
   * `lockDuration` of 30s, `stalledInterval` of 30s and `maxStalledCount` of 1,
   * so a redeploy, a restart, or an event loop blocked past the lock window
   * hands the same job to a worker a second time. The second delivery called
   * `markRunning()`, which flipped `cancelled` back to `running`, and then
   * published the entire payload again.
   *
   * One query, and it is the same query the run needs anyway.
   */
  if (isTerminal(state.status)) {
    console.log(`[worker] skipping ${jobId}: the database says "${state.status}".`);
    // Logged as well as printed: a redelivery that correctly refuses to re-run is
    // exactly the kind of thing somebody later asks "did it run twice?" about.
    await logJob(jobId, {
      level: "warn",
      stage: "run",
      message: `The queue offered this run again, but the database says "${state.status}". Nothing was re-sent.`,
      detail: { status: state.status },
    });
    return;
  }

  // Asked to stop before it ever started — a cancel that landed while the job
  // sat in the queue and lost the race to remove it.
  const stop = await cancelRequest(jobId);
  if (stop.requested) {
    console.log(`[worker] skipping ${jobId}: a stop was asked for before it started.`);
    await logJob(jobId, {
      level: "warn",
      stage: "cancel",
      message: "A stop was asked for before this run started. Nothing was sent.",
      detail: { mode: stop.mode },
    });
    await settleRun(jobId, "cancelled", null);
    return;
  }

  // Unscoped because the worker IS the owner's agent here: it has already been
  // told which run it is executing, and the run names its account.
  await logJob(jobId, {
    stage: "run",
    message:
      `Picked up by the worker: ${state.kind} of ${state.total} item(s) to ${state.storeLabel}, ` +
      `${state.batches} batch(es).`,
    detail: {
      kind: state.kind,
      total: state.total,
      batches: state.batches,
      store: state.storeLabel,
      source: state.sourceLabel,
      scheduled: state.scheduledFor !== null,
      scheduledFor: state.scheduledFor,
    },
  });

  /*
   * ONE OCCURRENCE OF A REPEATING SERIES — stage the next one now, §6 C2.
   *
   * Done at PICKUP rather than when this run finishes, so the series survives its
   * own runs going wrong: a cancelled occurrence, one that fails on the account's
   * permissions, or a worker killed mid-run all leave tomorrow's already staged.
   *
   * Idempotent under redelivery — `advanceSchedule` claims the series with a single
   * conditional UPDATE keyed on this run being the pending one, so a second delivery
   * advances nothing. See `lib/schedules.ts`.
   */
  if (state.scheduleId !== null) {
    const next = await advanceSchedule(state.scheduleId, jobId);

    await logJob(jobId, {
      stage: "run",
      message:
        next === null
          ? "This run is one occurrence of a repeating series, which was already moved on " +
            "(a redelivery, or the series was paused or deleted while this waited)."
          : `One occurrence of a repeating series. The next one is staged for ${next.scheduledFor}.`,
      detail: { scheduleId: state.scheduleId, nextJobId: next?.id ?? null },
    });
  }

  const store = await getStoreUnscoped(state.storeId);
  if (store === null) {
    await logJob(jobId, {
      level: "error",
      stage: "run",
      message: "The target site was removed from the list. Nothing was sent.",
    });
    await settleRun(jobId, "failed", "The target site was removed from the list.");
    return;
  }

  /*
   * RE-CHECK THE ACCOUNT'S PERMISSION AT EXECUTION TIME, not only at scheduling.
   *
   * Both, and for different reasons. The route checks so the operator gets an
   * immediate, actionable refusal instead of a run that quietly fails later. This
   * checks because a scheduled run can be hours or days old, and the interesting
   * case is exactly the one that gap creates: an account whose import permission
   * is revoked between scheduling and firing must not publish. Checking only at
   * scheduling would let a revoked account publish tomorrow on a decision made
   * yesterday; checking only here would accept a run that was never going to be
   * allowed and fail it in the middle of the night with nobody watching.
   *
   * It fails as a run with the cause named, exactly like the S3 case below, rather
   * than completing with every row marked failed.
   */
  const verdict =
    state.kind === "import"
      ? await importVerdict(state.createdBy, {
          count: state.total,
          threads: (state.options as ImportOptions).threads,
        })
      : state.kind === "update"
        ? // A bulk edit has its OWN switch, and it is re-checked here for exactly the
          // reason an import is: a scheduled run can be days old, and an account whose
          // permission was withdrawn in between must not reprice a catalogue tonight.
          await productEditVerdict(state.createdBy, {
            count: state.total,
            threads: (state.options as EditOptions).threads,
          })
        : await removeVerdict(state.createdBy);

  if (!verdict.ok) {
    await logJob(jobId, {
      level: "error",
      stage: "limits",
      message: `Refused by the account's permissions: ${verdict.message}`,
      detail: { scheduled: state.scheduledFor !== null },
    });
    await settleRun(
      jobId,
      "failed",
      `${verdict.message} Nothing was sent.` +
        (state.scheduledFor === null
          ? ""
          : " This run was scheduled earlier, and the account's permissions changed before it fired."),
    );
    return;
  }

  // Defence in depth against a run and a site drifting into different accounts.
  // Nothing can currently produce this — a run is created with a site fetched
  // scoped to its own account, and both cascade to the same user — so if it ever
  // does happen it is a bug, and pushing 5000 products into another customer's
  // shop is not the way to find out about it.
  if (store.ownerId !== state.createdBy) {
    await logJob(jobId, {
      level: "error",
      stage: "run",
      message: "This run and its target site belong to different accounts. Nothing was sent.",
    });
    await settleRun(
      jobId,
      "failed",
      "This run and its target site belong to different accounts. Nothing was sent.",
    );
    return;
  }

  /*
   * One controller per RUN, not per request.
   *
   * Every request this run makes shares it, so a single Stop ends all of the
   * run's lanes at once instead of the next one queueing up behind another
   * deadline. Registered before any request goes out and removed in `finally`, so
   * a Stop arriving during teardown finds nothing rather than an abort with no
   * request behind it.
   */
  const controller = new AbortController();
  inFlight.set(jobId, controller);

  try {
    const client = await clientFor(store, { signal: controller.signal });

    if (state.kind === "purge") {
      await runPurge(job, state, client);
      return;
    }

    if (state.kind === "update") {
      await runEdit(job, state, client);
      return;
    }

    await runImport(job, state, client, store);
  } finally {
    inFlight.delete(jobId);
  }
}


/**
 * What this batch's images cost, and where the time went.
 *
 * Logged because the tuning knobs are otherwise unturnable. "The run is slow" has at
 * least four different answers here — the source is slow, the shop's uplink is slow,
 * the images are enormous, or the run is re-sending images the site already has — and
 * they need opposite responses. `alreadyOnSite` in particular is the number that says
 * whether a re-run is nearly free.
 *
 * Skipped entirely when a batch had no images, rather than logging a row of zeroes on
 * every batch of a catalogue that uses `keep_remote`.
 */
async function logImageCost(
  jobId: string,
  batchIndex: number,
  stats: ImageStageStats,
): Promise<void> {
  if (stats.total === 0) {
    return;
  }

  const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

  const parts = [`${stats.total} image(s)`];

  if (stats.fromCache > 0) {
    parts.push(`${stats.fromCache} already resolved earlier in this run`);
  }
  if (stats.alreadyOnSite > 0) {
    parts.push(`${stats.alreadyOnSite} already on the site (neither downloaded nor sent)`);
  }
  if (stats.downloaded > 0) {
    parts.push(`${stats.downloaded} downloaded (${mb(stats.downloadedBytes)} MB in ${stats.downloadMs}ms)`);
  }
  if (stats.uploaded > 0) {
    parts.push(
      `${stats.uploaded} sent in ${stats.requests} request(s) ` +
        `(${mb(stats.uploadedBytes)} MB in ${stats.uploadMs}ms)`,
    );
  }
  if (stats.skippedBySite > 0) {
    parts.push(`${stats.skippedBySite} the site already had byte for byte`);
  }

  await logJob(jobId, {
    stage: "images",
    batchIndex,
    message: parts.join("; ") + ".",
    detail: { ...stats },
  });
}

/**
 * The image-failure log line, with the two causes SEPARATED.
 *
 * The counts are what make this worth a helper rather than a template string.
 * "18 images could not be staged" left the operator with no idea whether their
 * supplier's CDN was down or their own uploads directory was read-only, and those
 * two need entirely different people to act. `download` is the source of the image;
 * `upload` is the target site.
 */
async function logImageFailures(
  jobId: string,
  batchIndex: number,
  failures: ImageFailure[],
): Promise<void> {
  if (failures.length === 0) {
    return;
  }

  const download = failures.filter((failure) => failure.reason === "download");
  const upload = failures.filter((failure) => failure.reason === "upload");

  const parts: string[] = [];
  if (download.length > 0) {
    parts.push(`${download.length} could not be downloaded from the source`);
  }
  if (upload.length > 0) {
    parts.push(`${upload.length} the site would not store`);
  }

  console.warn(
    `[worker] ${jobId}: ${failures.length} image(s) failed, keeping original URLs.`,
    failures.slice(0, 3),
  );

  await logJob(jobId, {
    level: "warn",
    stage: "images",
    batchIndex,
    message:
      `${failures.length} image(s) could not be staged (${parts.join("; ")}); the original URLs ` +
      `were kept so the products still publish.`,
    // URLs only, truncated: enough to recognise the pattern without turning the
    // log into a copy of the catalogue.
    detail: {
      failed: failures.length,
      download: download.length,
      upload: upload.length,
      examples: failures.slice(0, 3),
    },
  });
}

/* --------------------------------------------------------------- import */

async function runImport(
  job: Job<{ jobId: string }>,
  state: JobState,
  client: GopClient,
  /** Already resolved by the caller — needed here to check the plugin's version. */
  store: Store,
): Promise<void> {
  const jobId = state.id;
  const options = state.options as ImportOptions;

  const products = await getJobProducts(jobId);
  if (products.length === 0) {
    await logJob(jobId, {
      level: "error",
      stage: "run",
      message: "The staged product payload is gone — nothing to send.",
    });
    await settleRun(jobId, "failed", "The staged product payload is gone.");
    return;
  }

  /*
   * The RUN OWNER's bucket. Resolved once, here, before any batch moves.
   *
   * This is the single most dangerous line in the change. Before per-account
   * settings there was one bucket and `lib/images.ts` read it directly; now the
   * only correct bucket is the one belonging to the account that owns this run
   * — which is the member's bucket even when an administrator started the run
   * on their behalf, because the run was created with the member as its owner.
   *
   * Resolved UP FRONT rather than discovered inside the first batch, so a run
   * whose owner has no S3 while the run asks for S3 fails as a run, with a
   * message naming the cause, instead of completing with every row marked
   * `batch_failed` and a summary that says "completed".
   */
  /*
   * "Copy into the site's media library" needs plugin 3.9.0 on the target site.
   *
   * Checked HERE for the same reason the bucket is: an older build has no
   * `/images/upload` route at all, so it answers `unknown_route` — loudly, but once
   * per image. A 5,000-product run would report five thousand identical 404s, publish
   * every product with its supplier's links anyway, and finish saying "completed".
   * The operator would have to read the log to discover that the one thing this mode
   * exists to do did not happen.
   *
   * Refused before a single byte is sent instead.
   */
  if (options.imageMode === "upload_site") {
    const support = imageUploadSupport(store.pluginVersion);

    if (!support.ok) {
      await logJob(jobId, {
        level: "error",
        stage: "images",
        message: support.message ?? "This site's plugin is too old to accept image uploads.",
        detail: { installed: support.installed, required: support.required },
      });
      await settleRun(jobId, "failed", support.message ?? "This site's plugin is too old.");
      return;
    }
  }

  let s3: S3Credentials | null = null;

  if (options.imageMode === "s3") {
    s3 = await getS3Credentials(state.createdBy);

    if (s3 === null) {
      await logJob(jobId, {
        level: "error",
        stage: "s3",
        message:
          'This run asks for "Upload to Amazon S3" but the account that owns it has no complete ' +
          "S3 configuration. Nothing was sent.",
      });
      await settleRun(
        jobId,
        "failed",
        'This run asks for "Upload to Amazon S3" but the account that owns it has no complete S3 configuration (bucket, region, access key and secret). Nothing was sent. Fill it in on the Settings screen, or start the run with a different image mode.',
      );
      return;
    }
  }

  if (s3 !== null) {
    // The BUCKET NAME only. Never the access key, never the secret — this table is
    // grepped for secrets by the test suites precisely so that stays true.
    await logJob(jobId, {
      stage: "s3",
      message: `Images will be uploaded to the owner's bucket "${s3.bucket}" (${s3.region}).`,
      detail: { bucket: s3.bucket, region: s3.region },
    });
  }

  /*
   * ONE image cache for the whole run.
   *
   * A catalogue reuses images heavily — a size chart or a brand logo can appear on
   * every product in the file. Per batch, which is where the mapping used to live,
   * that image was downloaded again for each of the 100 batches that mentioned it.
   * Shared across the run it is downloaded once, and the site is asked to write it
   * once.
   *
   * It holds promises, not URLs, so two lanes reaching the same image at the same
   * moment produce one download rather than two.
   */
  const imageCache = createImageCache();

  // Process-wide counters, so the summary below reports THIS run rather than the
  // lifetime of the worker.
  resetDownloadStats();

  // Batch size is the operator's choice but capped by the plugin — anything
  // larger is rejected wholesale with `batch_too_large`.
  const batchSize = Math.max(1, Math.min(options.batchSize ?? MAX_BATCH_SIZE, MAX_BATCH_SIZE));

  await logJob(jobId, {
    stage: "run",
    message:
      `Import options: ${options.mode} mode, "${WRITE_MODE_LABELS[options.writeMode]}", ` +
      `images "${options.imageMode}", ${options.threads} parallel lane(s), ` +
      `${batchSize} product(s) per batch` +
      (options.imageMode === "keep_remote"
        ? "."
        : `, at most ${downloadLanes()} image download(s) at once.`),
    detail: {
      mode: options.mode,
      writeMode: options.writeMode,
      imageMode: options.imageMode,
      threads: options.threads,
      batchSize,
      downloadLanes: options.imageMode === "keep_remote" ? null : downloadLanes(),
      flattenVariants: options.flattenVariants,
      skipRepeatedSku: options.skipRepeatedSku,
    },
  });

  const outcome = await runBatches(job, state, {
    batches: chunk(products, batchSize),
    batchSize,
    lanes: Math.max(1, Math.min(options.threads, 32)),
    run: async (batch, offset) => {
      /*
       * WHICH OF THESE ARE ALREADY ON THE SITE — asked per batch, before writing.
       *
       * Only in the two modes that need the answer. `skip` is the behaviour that
       * existed before this option did, and it costs exactly what it always cost:
       * one request per batch, no existence check, the plugin answering
       * `deduplicated` for anything it has seen.
       *
       * Asked HERE rather than once at the start of the run for a reason that
       * matters on a long run: a 14,000-product run takes hours, and an answer
       * gathered at minute zero would be stale by hour three — a product created
       * by somebody else in between would be created a second time. Per batch,
       * the answer is at most one batch old.
       */
      if (options.writeMode !== "skip") {
        return runWriteMode(jobId, batch, offset, options, client, batchSize, s3, imageCache);
      }

      // Image handling happens per batch so this batch's images are ready
      // before its products are created.
      const staged = await stageImages(batch, options, client, s3, imageCache);

      await logImageCost(jobId, Math.floor(offset / batchSize), staged.stats);
      await logImageFailures(jobId, Math.floor(offset / batchSize), staged.failures);

      let pluginElapsedMs: number | null = null;

      const results = await client.importProducts(staged.products, {
        // Batches here are already <= the plugin cap, so this fires once.
        onBatchDone: (batchResponse) => {
          pluginElapsedMs = batchResponse.elapsed_ms;
        },
      });

      return {
        results: results.map((result) => ({ ...result, index: result.index + offset })),
        pluginElapsedMs,
      };
    },
    onBatchError: (batch, offset, failure) =>
      batch.map((_product, position) => ({
        index: offset + position,
        ok: false,
        error: failure,
      })),
  });

  await logFinish(jobId, outcome, state);
  await settleRun(jobId, outcome.cancelled ? "cancelled" : "completed", stopNote(outcome));

  // Writing straight to the database means WooCommerce never clears its own
  // transients. Called ONCE for the whole run.
  //
  // Runs even when the job was CANCELLED: whatever reached the site before the
  // stop still leaves stale transients behind, and cleaning up only after
  // complete runs meant those were silently skipped, showing up later as wrong
  // prices on category pages.
  if (outcome.succeeded > 0) {
    await clearTransients(client, jobId);
  }

  /*
   * Did the download ceiling ever actually bite?
   *
   * `queued: 0` means it never did, and raising `GOP_IMAGE_DOWNLOAD_LANES` would change
   * nothing about this run — which is the answer to the question an operator asks
   * first, and the one they otherwise have to guess at. A large `waitedMs` says the
   * opposite: the sources could have been read faster than the ceiling allowed.
   *
   * Logged once per run rather than per batch, because it is a property of the process.
   */
  if (options.imageMode !== "keep_remote") {
    const limit = downloadStats();

    await logJob(jobId, {
      stage: "images",
      message:
        limit.queued === 0
          ? `The image download ceiling of ${downloadLanes()} was never reached (peak ${limit.peak}), ` +
            `so raising it would not have made this run faster.`
          : `${limit.queued} download(s) waited for a slot, ${Math.round(limit.waitedMs / 1000)}s in ` +
            `total, against a ceiling of ${downloadLanes()}. Raising GOP_IMAGE_DOWNLOAD_LANES may ` +
            `help if the link is not already saturated.`,
      detail: { ...limit, ceiling: downloadLanes() },
    });
  }
}

/**
 * The two modes that write over products already on the site.
 *
 * Shape of the work, and every part of it is deliberate:
 *
 *  1. ask the site which of this batch's SKUs it already has;
 *  2. update those, with ONLY the fields the file actually carries a value for;
 *  3. create the rest — or, in `update_only`, record them as failures rather than
 *     creating anything at all.
 *
 * Two requests per batch instead of one, and the extra one is the cheap one:
 * `/products/exists` is a single indexed `IN (...)` with no per-product summary.
 *
 * `toProductUpdate` is what keeps step 2 from being a catastrophe — see the long
 * comment there. A `Product` built for an import carries `""` for every column the
 * file does not have, and `""` on the update route means "clear it on purpose".
 */
async function runWriteMode(
  jobId: string,
  batch: Product[],
  offset: number,
  options: ImportOptions,
  client: GopClient,
  batchSize: number,
  s3: S3Credentials | null,
  imageCache: ImageCache,
): Promise<{ results: RunResult[]; pluginElapsedMs: number | null }> {
  const batchIndex = Math.floor(offset / batchSize);

  // Position within the batch → the update payload, or null for a row that has no
  // SKU and therefore cannot be matched against anything.
  const planned = batch.map((product) => toProductUpdate(product));
  const skus = planned
    .map((update) => update?.sku)
    .filter((sku): sku is string => sku !== undefined);

  const existing = skus.length === 0 ? { found: [], missing: [] } : await client.productsExist(skus);
  const onSite = new Set(existing.found.map((entry) => entry.sku));

  const toUpdate: Array<{ position: number; update: ProductUpdate }> = [];
  const toCreate: number[] = [];

  planned.forEach((update, position) => {
    if (update !== null && onSite.has(update.sku ?? "")) {
      toUpdate.push({ position, update });
    } else {
      toCreate.push(position);
    }
  });

  await logJob(jobId, {
    stage: "batch",
    batchIndex,
    message:
      `Batch ${batchIndex + 1}: ${toUpdate.length} of ${batch.length} row(s) are already on the site ` +
      `and will be updated; ${toCreate.length} are new and will be ` +
      `${options.writeMode === "update_only" ? "REPORTED AS FAILURES, not created" : "created"}.`,
    detail: {
      writeMode: options.writeMode,
      existing: toUpdate.length,
      new: toCreate.length,
      withoutSku: planned.filter((update) => update === null).length,
    },
  });

  const results: RunResult[] = [];
  let pluginElapsedMs: number | null = null;

  /* ---------------------------------------------------------------- update */

  if (toUpdate.length > 0) {
    const updated = await client.updateProducts(
      toUpdate.map((entry) => entry.update),
      {
        onBatchDone: (response) => {
          pluginElapsedMs = (pluginElapsedMs ?? 0) + response.elapsed_ms;
        },
      },
    );

    for (const result of updated) {
      const entry = toUpdate[result.index];

      if (entry === undefined) {
        continue;
      }

      const changed = result.changed ?? {};

      results.push({
        index: offset + entry.position,
        ok: result.ok,
        product_id: result.product_id,
        sku: result.sku ?? entry.update.sku,
        changed,
        /*
         * A successful update that changed NOTHING is counted as "already
         * present", which is the counter this app has always had for "the row
         * succeeded and created nothing new".
         *
         * The alternative — counting it as a change — would make re-running the
         * same price file report 1,240 price changes every time, and a number that
         * is the same whether or not anything happened is not a number.
         */
        deduplicated: result.ok && Object.keys(changed).length === 0,
        /*
         * The discriminant that keeps `/remove` honest.
         *
         * "Everything one import run created" builds its list from this run's
         * successful `product_id`s, and in this mode most of those products were
         * NOT created by it — they were already on the site and had their price
         * changed. Without this flag that selection would delete a customer's
         * existing catalogue under a label promising the opposite.
         */
        action: "updated",
        error: result.error,
      });
    }
  }

  /* ---------------------------------------------------------------- create */

  if (toCreate.length > 0 && options.writeMode === "update_only") {
    /*
     * "Update only" — and this is the whole reason the mode exists.
     *
     * Recorded as FAILURES rather than skipped silently. A row whose SKU is not on
     * the site is a real discrepancy between the file and the shop: usually a
     * typo, sometimes a product somebody deleted. Skipping it quietly would hide
     * exactly what the operator chose this mode to be protected from, and the
     * failed rows already have two ways out — download them as a CSV to fix, or
     * import them as a new file once checked.
     */
    for (const position of toCreate) {
      const sku = (batch[position]?.sku ?? "").trim();

      results.push({
        index: offset + position,
        ok: false,
        sku: sku === "" ? undefined : sku,
        error: {
          code: sku === "" ? "no_sku_to_match" : "not_on_site",
          message:
            sku === ""
              ? 'This row has no SKU, so there is nothing to match it against. "Update only" ' +
                "creates nothing, so it was not published."
              : `No product on this site has SKU \`${sku}\`. "Update only" creates nothing, so ` +
                "this row was not published. Check the SKU, or run the file again in " +
                '"Create or update" if it really is a new product.',
        },
      });
    }
  } else if (toCreate.length > 0) {
    const fresh = toCreate.map((position) => batch[position]);

    // Images are staged for the CREATE half only. An update never writes images,
    // so staging them for a row that is going to be updated would do the work and
    // then throw it away.
    const staged = await stageImages(fresh, options, client, s3, imageCache);

    await logImageCost(jobId, batchIndex, staged.stats);
    await logImageFailures(jobId, batchIndex, staged.failures);

    const created = await client.importProducts(staged.products, {
      onBatchDone: (response) => {
        pluginElapsedMs = (pluginElapsedMs ?? 0) + response.elapsed_ms;
      },
    });

    for (const result of created) {
      const position = toCreate[result.index];

      if (position === undefined) {
        continue;
      }

      results.push({ ...result, index: offset + position, action: "created" });
    }
  }

  // Back into the file's own order. The results table, the resend and the CSV
  // export all key off the original row index, and a batch that answered in two
  // halves must not read as though the file were shuffled.
  results.sort((left, right) => left.index - right.index);

  return { results, pluginElapsedMs };
}

/* ----------------------------------------------------------------- edit */

/**
 * A bulk edit of products that already exist.
 *
 * Goes through the SAME machinery as every other run — the queue, the lanes, the
 * per-batch cancel check, the log, Cancel and Stop, per-row results. That was a
 * decision, not an accident: a price change across 3,000 products has exactly the
 * same needs as an import of 3,000 products, and doing it in a loop inside a route
 * handler would mean no progress, no log, no way to stop it and a browser tab that
 * must stay open.
 *
 * What is NOT re-evaluated here is the selection. The staged list carries the
 * absolute value for every row, resolved when the operator looked at it — so a
 * product whose price somebody else changed in between is not swept along at a
 * number nobody reviewed, and a product that joined the filter afterwards is not
 * taken at all. Same property the removal path has, for the same reason.
 */
async function runEdit(
  job: Job<{ jobId: string }>,
  state: JobState,
  client: GopClient,
): Promise<void> {
  const jobId = state.id;
  const options = state.options as EditOptions;

  const items = await getEditItems(jobId);

  if (items.length === 0) {
    await logJob(jobId, {
      level: "error",
      stage: "run",
      message: "The staged list of changes is gone — nothing to send.",
    });
    await settleRun(jobId, "failed", "The staged list of changes is gone.");
    return;
  }

  const batchSize = Math.max(1, Math.min(options.batchSize ?? MAX_UPDATE_BATCH, MAX_UPDATE_BATCH));

  await logJob(jobId, {
    stage: "run",
    message:
      `Bulk edit: ${describeEdit(options.operation)}, across ${items.length} product(s) on ` +
      `${state.storeLabel}. ${options.threads} parallel lane(s), ${batchSize} per batch.`,
    detail: {
      operation: options.operation,
      total: items.length,
      threads: options.threads,
      batchSize,
    },
  });

  const outcome = await runBatches(job, state, {
    batches: chunk(items, batchSize),
    batchSize,
    lanes: Math.max(1, Math.min(options.threads, 32)),
    run: async (batch, offset) => {
      let pluginElapsedMs: number | null = null;

      const results = await client.updateProducts(
        // Addressed by `product_id`, which is the only key that always works: a
        // product with no SKU has nothing else, and two sharing a SKU are refused.
        batch.map((item) => ({ product_id: item.product_id, ...item.set })),
        {
          onBatchDone: (response) => {
            pluginElapsedMs = response.elapsed_ms;
          },
        },
      );

      return {
        results: results.map((result) => {
          const item = batch[result.index];
          const changed = result.changed ?? {};

          return {
            index: offset + result.index,
            ok: result.ok,
            product_id: result.product_id ?? item?.product_id,
            sku: result.sku ?? item?.sku,
            // The product is still on the site, but its OLD value is now only here.
            // Carried like a purge row's name, and for the same reason.
            name: item?.name,
            changed,
            // Succeeded and moved nothing: the product was already as asked.
            deduplicated: result.ok && Object.keys(changed).length === 0,
            action: "updated" as const,
            error: result.error,
          };
        }),
        pluginElapsedMs,
      };
    },
    onBatchError: (batch, offset, failure) =>
      batch.map((item, position) => ({
        index: offset + position,
        ok: false,
        product_id: item.product_id,
        sku: item.sku,
        name: item.name,
        action: "updated" as const,
        error: failure,
      })),
  });

  await logFinish(jobId, outcome, state);
  await settleRun(jobId, outcome.cancelled ? "cancelled" : "completed", stopNote(outcome));

  /*
   * Transients, once for the whole run — the same reason the import path does it.
   *
   * The plugin already clears each product's own transients as it writes it, but
   * WooCommerce also caches things that are not per product, and writing straight to
   * the database means nothing else clears those. Runs even after a cancel: whatever
   * reached the site before the stop still leaves stale caches behind.
   */
  if (outcome.succeeded > 0) {
    await clearTransients(client, jobId);
  }
}

/* ---------------------------------------------------------------- purge */

/**
 * Remove products the operator selected and confirmed.
 *
 * The payload is the exact list they saw in the preview, staged at the moment
 * they pressed the button. It is NOT a filter re-evaluated here: a category
 * that gained a product between preview and run would otherwise quietly take
 * that product with it.
 */
async function runPurge(
  job: Job<{ jobId: string }>,
  state: JobState,
  client: GopClient,
): Promise<void> {
  const jobId = state.id;
  const options = state.options as PurgeOptions;

  const items = await getPurgeItems(jobId);
  if (items.length === 0) {
    await settleRun(jobId, "failed", "The staged list of products is gone.");
    return;
  }

  const batchSize = Math.max(1, Math.min(options.batchSize ?? MAX_DELETE_BATCH, MAX_DELETE_BATCH));

  const outcome = await runBatches(job, state, {
    batches: chunk(items, batchSize),
    batchSize,
    lanes: Math.max(1, Math.min(options.threads, 32)),
    run: async (batch, offset) => {
      let pluginElapsedMs: number | null = null;

      const results = await client.deleteProducts(
        batch.map((item) => item.product_id),
        {
          deleteImages: options.deleteImages,
          onBatchDone: (response) => {
            pluginElapsedMs = response.elapsed_ms;
          },
        },
      );

      return {
        results: results.map((result, position) => ({
          index: offset + position,
          ok: result.ok,
          product_id: result.product_id,
          // The product is gone, so this row is the only record of what it was.
          sku: batch[position]?.sku,
          name: batch[position]?.name,
          removed: result.removed,
          error: result.error,
        })),
        pluginElapsedMs,
      };
    },
    onBatchError: (batch, offset, failure) =>
      batch.map((item, position) => ({
        index: offset + position,
        ok: false,
        product_id: item.product_id,
        sku: item.sku,
        name: item.name,
        error: failure,
      })),
  });

  await logFinish(jobId, outcome, state);
  await settleRun(jobId, outcome.cancelled ? "cancelled" : "completed", stopNote(outcome));

  // Same reason as the import path: rows disappeared from under WooCommerce's
  // cache without WooCommerce ever being told.
  if (outcome.succeeded > 0) {
    await clearTransients(client, jobId);
  }
}

/* ------------------------------------------------------------ the engine */

async function runBatches<T>(
  job: Job<{ jobId: string }>,
  state: JobState,
  plan: BatchPlan<T>,
): Promise<{ cancelled: boolean; mode: CancelMode | null; succeeded: number }> {
  const jobId = state.id;

  await markRunning(jobId);

  let cursor = 0;
  let succeededTotal = 0;

  const stop: StopState = { cancelled: false, mode: null };

  /*
   * §6 C1 — how many lanes this run is still allowed to fly, and how many are.
   *
   * The operator picks a lane count before the run, and the only place the shop's
   * behaviour is visible is DURING it: 32 lanes of 50 products is fine against one
   * site and takes another one down. So a batch that comes back slowly costs the
   * run one lane, one at a time, floor of one — the per-batch wall clock is already
   * measured for the batch record, so this needs no new evidence.
   *
   * It only ever goes DOWN within a run, and that is deliberate. Adding lanes back
   * when a site recovers means oscillating around the threshold, hammering a shop
   * that has just stopped struggling; the cost of not recovering is that a run
   * finishes later than it might have, which is the direction to be wrong in. The
   * operator's number is honoured as a CEILING, never raised past it.
   */
  const slowMs = slowBatchMs();
  let allowedLanes = plan.lanes;
  let flyingLanes = plan.lanes;

  async function lane(): Promise<void> {
    for (;;) {
      if (stop.cancelled) {
        return;
      }

      /*
       * Read the run's own cancel record BETWEEN batches — a safe boundary, so
       * no product is cut off mid-write. That property is the whole meaning of
       * Cancel and it does not change here.
       *
       * Checked BEFORE claiming an index, which is the other half of this. The
       * claim used to happen first, so a lane that then found a cancel had
       * already consumed a batch nobody would run — `processed` could come up
       * short by as much as one batch per lane, and for reasons that had nothing
       * to do with the cancel at all.
       */
      const asked = await cancelRequest(jobId);
      if (asked.requested) {
        stop.cancelled = true;
        stop.mode = asked.mode;
        await logJob(jobId, {
          level: "warn",
          stage: "cancel",
          message:
            `Lane stopped at a batch boundary after ${asked.mode === "stop" ? "Stop" : "Cancel"} ` +
            `was asked for. ${plan.batches.length - cursor} batch(es) were never sent.`,
          detail: { mode: asked.mode, batchesNotSent: Math.max(0, plan.batches.length - cursor) },
        });
        return;
      }

      /*
       * Stand down if the run is now allowed fewer lanes than are flying.
       *
       * Checked BEFORE claiming an index, for exactly the reason the cancel check
       * is: a lane that claimed a batch and then left would take that batch with
       * it, and `processed` would come up short for a reason that has nothing to do
       * with the site. The batches this lane would have carried are still in the
       * queue for the lanes that remain, so nothing is dropped — it takes longer,
       * which is the whole point.
       */
      if (flyingLanes > allowedLanes && flyingLanes > 1) {
        flyingLanes--;
        await logJob(jobId, {
          level: "warn",
          stage: "run",
          message:
            `Lane stood down between batches: ${flyingLanes} of ${plan.lanes} still flying. ` +
            `The remaining ${Math.max(0, plan.batches.length - cursor)} batch(es) are shared ` +
            `between them.`,
          detail: {
            flying: flyingLanes,
            allowed: allowedLanes,
            chosen: plan.lanes,
            batchesLeft: Math.max(0, plan.batches.length - cursor),
          },
        });
        return;
      }

      const index = cursor++;
      if (index >= plan.batches.length) {
        return;
      }

      const batch = plan.batches[index];
      const offset = index * plan.batchSize;

      let results: RunResult[];

      // The plugin reports its own time via `elapsed_ms`; keep it apart from
      // the worker's wall clock, because the two answer different questions.
      let pluginElapsedMs: number | null = null;
      let wallStartedAt = Date.now();

      const attempts = batchAttempts();
      /** Which attempt produced what is recorded below. 1 unless a retry was needed. */
      let usedAttempt = 1;

      /*
       * SEND THE BATCH AGAIN when the site failed to ANSWER — §2.6.
       *
       * The retry is around the BATCH, not around the run, and the difference is
       * the whole design. A run-level retry (BullMQ `attempts`) re-sends a payload
       * that is already half-written, which is why `defaultJobOptions.attempts` is
       * 1 and is staying 1 — see the comment where it is set. One batch of 50 is
       * small enough that resending it is cheap and bounded, and it is the unit the
       * failure actually happened to.
       *
       * Written here rather than in each `run*` function because this loop is the
       * one engine underneath all four kinds of run: an import, either write mode,
       * a bulk edit and a purge all get it from this one place.
       *
       * Resending is safe for each of them, for a different reason each time:
       *
       *  - an IMPORT carries idempotency keys, so a product the timed-out attempt
       *    did create comes back as already present rather than as a second one;
       *  - a WRITE MODE re-asks `/products/exists` on the retry, so the second
       *    attempt sees what the first one may have created and updates it;
       *  - a BULK EDIT sends absolute values, so writing 90,000 twice writes
       *    90,000 — where a stored "−10%" resent would take another 10% off;
       *  - a PURGE is asked to delete products that are already gone, which the
       *    plugin reports per row rather than treating as a failure of the batch.
       *
       * Retrying used to have one more cost, and plugin 3.9.0 removed it: in the
       * "copy into the site's media library" mode the old `/images/fetch` appended
       * `-1`, `-2` on a name collision, so a resent batch left a second copy of every
       * image FILE in uploads. `/images/upload` derives the filename from the source
       * URL, so a resent batch now writes nothing it has already written.
       */
      for (let attempt = 1; ; attempt++) {
        usedAttempt = attempt;
        wallStartedAt = Date.now();
        pluginElapsedMs = null;

        /*
         * Logged BEFORE the request goes out, not after it comes back.
         *
         * This is the line that makes a wedged run explicable. A site that accepts
         * the connection and never answers holds this lane for the full request
         * deadline; if the only log line came after the answer, those two minutes
         * would have nothing at all in them — which is exactly the moment somebody
         * opens the log to find out what is happening.
         *
         * A retry writes its own copy of this line, so "it went out three times"
         * is visible in the log rather than inferred from the gap between two
         * timestamps.
         */
        await logJob(jobId, {
          // A batch needing a second go is not routine, and the level is what lets
          // a reader filter the run down to the parts that were not.
          level: attempt === 1 ? "info" : "warn",
          stage: "batch",
          batchIndex: index,
          message:
            `Sending batch ${index + 1} of ${plan.batches.length}` +
            `${attempt === 1 ? "" : ` (attempt ${attempt} of ${attempts})`} — ` +
            `${batch.length} item(s), rows ${offset + 1}–${offset + batch.length}.`,
          detail: { size: batch.length, offset, attempt, attempts },
        });

        try {
          const outcome = await plan.run(batch, offset);
          results = outcome.results;
          pluginElapsedMs = outcome.pluginElapsedMs;
          break;
        } catch (error) {
          /*
           * A Stop cut this request off. NOT the same thing as the batch failing,
           * and it must not be recorded as if it were.
           *
           * Nothing truthful can be said per row here: the products were sent, and
           * the site may or may not have committed them before the connection went
           * away. Writing 50 rows marked failed would assert something this process
           * cannot know, and writing them as succeeded would be worse. So the batch
           * records NOTHING, `processed` does not move, and the run carries
           * STOP_WARNING saying in plain words that the site may hold products the
           * results table does not list.
           *
           * A TIMEOUT is deliberately handled differently, by the branch below:
           * epistemically it is the same "sent, never confirmed", but it happens on
           * its own and can hit any number of batches through a long run, so those
           * rows are recorded with the `request_timeout` code — whose message says
           * the uncertainty out loud — rather than leaving the operator with a
           * short `processed` and no explanation anywhere.
           */
          if (error instanceof GopAbortError) {
            stop.cancelled = true;
            stop.mode = "stop";
            /*
             * NEVER retried, and the guard is here rather than only in
             * `isTransientFailure`: this is not the site failing, it is the operator
             * ending the run, and sending the batch again would make Stop stop
             * nothing at the one moment it matters most.
             *
             * Written HERE rather than after the loop, because this lane returns
             * immediately and never reaches a boundary. Miss this and the single most
             * important event in the run — a batch abandoned in flight, whose products
             * may be on the site anyway — is the only one with no record.
             */
            await logJob(jobId, {
              level: "warn",
              stage: "cancel",
              batchIndex: index,
              message:
                `Batch ${index + 1} was ABANDONED in flight by Stop. Its ${batch.length} item(s) are ` +
                `recorded nowhere: the site may have committed them, and this app never saw the answer.`,
              detail: { size: batch.length, offset, abandoned: true },
            });
            return;
          }

          // Whole batch died (network, 401, plugin missing, deadline) — record the
          // failure per row, with the code naming which, so the operator knows
          // exactly which rows never landed and why.
          const failure = describeFailure(error);
          const transient = isTransientFailure(error);
          const lastAttempt = attempt >= attempts;

          await logJob(jobId, {
            level: "error",
            stage: "batch",
            batchIndex: index,
            message:
              `Batch ${index + 1} failed after ${Date.now() - wallStartedAt}ms` +
              `${attempt === 1 ? "" : ` on attempt ${attempt} of ${attempts}`}: ${failure.message}` +
              (transient && lastAttempt ? ` Given up on after ${attempts} attempt(s).` : ""),
            detail: {
              code: failure.code,
              size: batch.length,
              wallMs: Date.now() - wallStartedAt,
              attempt,
              attempts,
              transient,
            },
          });

          if (!transient || lastAttempt) {
            /*
             * The code recorded on the rows is the LAST failure's, unchanged.
             *
             * A run that gave up after three timeouts must still say
             * `request_timeout` — that is the one code whose message admits the
             * products may be on the site regardless, and it is what tells "resend
             * these" apart from "fix the data". A code invented for "gave up" would
             * break that distinction while looking like more information.
             */
            results = plan.onBatchError(batch, offset, failure);
            break;
          }

          const delayMs = retryDelayMs(attempt);

          await logJob(jobId, {
            level: "warn",
            stage: "batch",
            batchIndex: index,
            message:
              `Batch ${index + 1} will be sent again in ${Math.round(delayMs / 1000)}s — attempt ` +
              `${attempt + 1} of ${attempts}. \`${failure.code}\` is the site failing to answer ` +
              `rather than refusing what it was sent, and that is often over by the next attempt.`,
            detail: { code: failure.code, delayMs, attempt: attempt + 1, attempts },
          });

          /*
           * A lane inside a backoff is NOT at a batch boundary.
           *
           * The boundary check at the top of the loop is what makes Cancel work, and
           * a batch waiting to be sent again is in the middle of one iteration — so
           * without this a press of Cancel would wait out the whole backoff chain,
           * which on a long run is the difference between "it stopped" and "it
           * ignored me". Stop has the same problem here and worse: there is no
           * request in flight for it to abort, so aborting the controller does
           * nothing at all and the durable record is the only thing that can be read.
           */
          const asked = await waitBeforeRetry(jobId, delayMs);

          if (asked.requested) {
            stop.cancelled = true;
            stop.mode = asked.mode;

            await logJob(jobId, {
              level: "warn",
              stage: "cancel",
              batchIndex: index,
              message:
                `Batch ${index + 1} was waiting to be sent again when ` +
                `${asked.mode === "stop" ? "Stop" : "Cancel"} was asked for, so it was not sent ` +
                `again. Its ${batch.length} item(s) are recorded as \`${failure.code}\` — what was ` +
                `already known before the press.`,
              detail: { mode: asked.mode, code: failure.code, attempt, attempts },
            });

            /*
             * Recorded rather than dropped, which is the opposite of the abandoned
             * case above, and deliberately.
             *
             * This batch's deadline had already expired: "it was sent and the site
             * did not answer within the deadline" is a fact the run held before
             * anybody pressed anything. Throwing it away because the retry was cut
             * short would lose something true, where the abandoned batch above has
             * nothing true to record at all.
             */
            results = plan.onBatchError(batch, offset, failure);
            break;
          }
        }
      }

      await appendResults(jobId, results);

      const succeeded = results.filter((result) => result.ok).length;
      // A deduplicated row succeeded but created NOTHING. Counted separately,
      // otherwise a second run looks identical to the first.
      const deduplicated = results.filter((result) => result.ok && result.deduplicated).length;

      succeededTotal += succeeded;

      await logJob(jobId, {
        /*
         * Warn when it took more than one go, so a run that only worked on the
         * third attempt does not read as though it worked on the first. The timings
         * on this line are the SUCCESSFUL attempt's — the ones before it have their
         * own lines, which is where "this site needed three tries" is legible.
         */
        level: usedAttempt === 1 ? "info" : "warn",
        stage: "batch",
        batchIndex: index,
        message:
          `Batch ${index + 1} answered in ${Date.now() - wallStartedAt}ms` +
          `${pluginElapsedMs === null ? "" : ` (site spent ${Math.round(pluginElapsedMs)}ms)`}` +
          `${usedAttempt === 1 ? "" : ` on attempt ${usedAttempt} of ${attempts}`}: ` +
          `${succeeded} ok, ${results.length - succeeded} failed, ${deduplicated} already present.`,
        detail: {
          succeeded,
          failed: results.length - succeeded,
          deduplicated,
          wallMs: Date.now() - wallStartedAt,
          pluginElapsedMs,
          attempt: usedAttempt,
          attempts,
        },
      });

      /*
       * EVERY failed row, individually. No cap.
       *
       * There was a cap of ten per batch, on the reasoning that fifty near-identical
       * lines bury the lines around them. That reasoning was wrong for the only
       * question this log exists to answer: "which of my products failed, and why?"
       * A cap makes the answer incomplete precisely when there is most to explain,
       * and the level filter already deals with volume — a reader who wants only the
       * failures can select Errors.
       *
       * The natural ceiling is the plugin's own: a batch is at most 50 products
       * (`MAX_BATCH_SIZE`), so this is at most 50 lines per batch.
       */
      const failedRows = results.filter((result) => !result.ok);

      if (failedRows.length > 0) {
        await logJob(
          jobId,
          failedRows.map((result) => ({
            level: "warn" as const,
            stage: "plugin" as const,
            batchIndex: index,
            message:
              `Row ${result.index + 1}${result.sku ? ` (${result.sku})` : ""} failed: ` +
              `${result.error?.code ?? "unknown"} — ${result.error?.message ?? "no message"}`,
            detail: { row: result.index, sku: result.sku ?? null, code: result.error?.code ?? null },
          })),
        );
      }

      await appendBatchRecord(jobId, {
        index,
        size: results.length,
        succeeded,
        failed: results.length - succeeded,
        deduplicated,
        elapsedMs: pluginElapsedMs,
        wallMs: Date.now() - wallStartedAt,
        at: new Date().toISOString(),
      });

      /*
       * The site is answering, but badly. Keep one fewer lane on it.
       *
       * Measured on the WALL clock rather than the plugin's own `elapsed_ms`,
       * because what matters here is how long the shop held this lane — a site
       * spending 200ms of PHP after 40 seconds of queueing is still a site that
       * cannot take what it is being given.
       *
       * One lane per slow batch, so a site that is merely having a moment loses one
       * lane and a site that is genuinely overwhelmed converges to one. Nothing is
       * skipped and nothing is trimmed: the reduction is logged with the number that
       * caused it, and every product still goes.
       */
      const batchWallMs = Date.now() - wallStartedAt;

      if (batchWallMs > slowMs && allowedLanes > 1) {
        allowedLanes--;
        await logJob(jobId, {
          level: "warn",
          stage: "run",
          message:
            `Batch ${index + 1} took ${batchWallMs}ms, over the ${slowMs}ms a batch may take ` +
            `before this run eases off — standing one lane down: ${allowedLanes} of ` +
            `${plan.lanes} lane(s) from here. Every product still goes; fewer go at once.`,
          detail: {
            wallMs: batchWallMs,
            slowMs,
            allowed: allowedLanes,
            chosen: plan.lanes,
          },
        });
      }

      const updated = await applyBatch(jobId, {
        processed: results.length,
        succeeded,
        failed: results.length - succeeded,
        deduplicated,
        pluginElapsedMs: pluginElapsedMs ?? 0,
      });

      if (updated && updated.total > 0) {
        await job.updateProgress(Math.round((updated.processed / updated.total) * 100));
      }
    }
  }

  await Promise.all(Array.from({ length: plan.lanes }, () => lane()));

  return { cancelled: stop.cancelled, mode: stop.mode, succeeded: succeededTotal };
}

/**
 * Finish the run, then tell whoever asked to be told — §6 C3.
 *
 * EVERY terminal path in this file goes through here rather than calling
 * `finishJob` directly, and that is the point. Hooking only the three happy
 * endings would mean a run refused by the account's permissions, or one whose
 * staged payload had expired, ends in silence — and those are exactly the runs
 * somebody sitting watching a screen needs told about.
 *
 * The state is re-read AFTER finishing, so the counts and the status in the payload
 * are the final ones rather than the ones from before the last batch. And it is
 * awaited: the notification is cheap, bounded by its own 5s deadline, and never
 * throws — see `lib/notify.ts` for why it swallows everything.
 */
async function settleRun(
  jobId: string,
  status: "completed" | "failed" | "cancelled",
  error: string | null,
): Promise<void> {
  await finishJob(jobId, status, error);

  const settled = await getJobState(jobId);

  if (settled !== null) {
    await notifyRunFinished(settled);
  }
}

/**
 * How often the durable cancel record is read while a batch waits to be resent.
 *
 * Half a second, not the whole delay: during a backoff there is no request in
 * flight, so Stop's abort has nothing to pull and this poll is the ONLY thing that
 * can end the lane. Cheap enough to be uninteresting — one indexed read per lane
 * per half second, against a batch measured in seconds to minutes.
 */
const RETRY_CANCEL_POLL_MS = 500;

/**
 * Wait out a backoff, and come straight back if somebody presses Cancel or Stop.
 *
 * Returns the cancel record if one appeared, so the caller can record the failure
 * it already knows about and stop, rather than sleeping out a chain of delays with
 * a press of Cancel sitting unread in the database the whole time.
 */
async function waitBeforeRetry(
  jobId: string,
  delayMs: number,
): Promise<{ requested: boolean; mode: CancelMode | null }> {
  const until = Date.now() + delayMs;

  for (;;) {
    const asked = await cancelRequest(jobId);

    if (asked.requested) {
      return asked;
    }

    const left = until - Date.now();

    if (left <= 0) {
      return { requested: false, mode: null };
    }

    await sleep(Math.min(left, RETRY_CANCEL_POLL_MS));
  }
}

/**
 * How a run that stopped early explains itself on the Activity screen.
 *
 * A graceful cancel has nothing to warn about — it stopped at a boundary, so
 * every batch it sent is accounted for in the results. A Stop does, and the
 * warning is written onto the run rather than shown once in a toast: the person
 * reading this next week is not the one who pressed it.
 */
/**
 * The last line of the run: what happened, in one sentence, with the totals.
 *
 * Written before `finishJob` so that the log's final line and the run's final
 * status cannot disagree about which came first — somebody reading the log wants the
 * summary at the bottom, not one row above the end.
 */
async function logFinish(
  jobId: string,
  outcome: { cancelled: boolean; mode: CancelMode | null; succeeded: number },
  state: JobState,
): Promise<void> {
  const fresh = await getJobState(jobId);
  const wallMs =
    fresh?.startedAt == null ? null : Date.now() - new Date(fresh.startedAt).getTime();

  if (!outcome.cancelled) {
    await logJob(jobId, {
      stage: "finish",
      message:
        `Run completed: ${fresh?.succeeded ?? outcome.succeeded} ok, ${fresh?.failed ?? 0} failed, ` +
        `${fresh?.deduplicated ?? 0} already present, of ${state.total} staged.`,
      detail: {
        succeeded: fresh?.succeeded ?? outcome.succeeded,
        failed: fresh?.failed ?? 0,
        deduplicated: fresh?.deduplicated ?? 0,
        total: state.total,
        wallMs,
      },
    });
    return;
  }

  const stopped = outcome.mode === "stop";

  await logJob(jobId, {
    level: "warn",
    stage: "finish",
    message:
      `Run ${stopped ? "STOPPED" : "cancelled"} after ${fresh?.processed ?? 0} of ${state.total} item(s). ` +
      (stopped
        ? "Requests in flight were abandoned — the site may hold items this run never recorded."
        : "It stopped at batch boundaries, so everything it sent is accounted for below."),
    detail: {
      mode: outcome.mode,
      processed: fresh?.processed ?? 0,
      total: state.total,
      wallMs,
    },
  });
}

function stopNote(outcome: { cancelled: boolean; mode: CancelMode | null }): string | null {
  return outcome.cancelled && outcome.mode === "stop" ? STOP_WARNING : null;
}

async function clearTransients(client: GopClient, jobId: string): Promise<void> {
  try {
    await client.clearTransients();
    await logJob(jobId, {
      stage: "transients",
      message: "Cleared WooCommerce's transients, so category pages show the new prices.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[worker] clearing transients failed for ${jobId}:`, error);
    await logJob(jobId, {
      level: "warn",
      stage: "transients",
      message:
        `Could not clear WooCommerce's transients: ${message}. The products are on the site, but ` +
        `category pages may show stale prices until the cache expires.`,
    });
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

// The Worker needs its own connection: it keeps a blocking command open waiting
// for jobs, so it cannot share with ordinary reads and writes.
const workerConnection = createConnection();

/**
 * A THIRD connection, because a Redis client in subscriber mode cannot run
 * ordinary commands. Not shareable with the queue's or with `redis`.
 *
 * This is the only thing in the design that is event-driven rather than read at a
 * boundary, and it has to be: Stop's whole purpose is to reach a request that is
 * already in flight, and a lane blocked inside `fetch` will not come back to any
 * boundary to be told. Polling harder would only make the poll interval the
 * response time.
 */
const stopConnection = createConnection();

stopConnection.on("message", (_channel, jobId) => {
  const controller = inFlight.get(jobId);

  if (controller === undefined) {
    // Another worker holds this run, or it has already finished. Both fine.
    return;
  }

  console.log(`[worker] stop received for ${jobId}: aborting the request in flight.`);
  controller.abort(new Error("The run was stopped."));
});

// Subscribing is not awaited at the top level on purpose: a Redis that is slow
// to accept the subscription must not delay the worker starting to take jobs,
// and a run whose Stop arrives before this lands still stops at its next batch
// boundary from the durable record.
void stopConnection.subscribe(STOP_CHANNEL).catch((error: unknown) => {
  console.error(
    "[worker] could not subscribe to the stop channel — Stop will fall back to " +
      "stopping at a batch boundary or a request deadline:",
    error instanceof Error ? error.message : String(error),
  );
});

const worker = new Worker<{ jobId: string }>(QUEUE_NAME, runJob, {
  connection: workerConnection,
  concurrency: CONCURRENCY,
});

worker.on("failed", (job, error) => {
  console.error(`[worker] run ${job?.id} failed:`, error.message);
});

worker.on("completed", (job) => {
  console.log(`[worker] run ${job.id} done.`);
});

console.log(`[worker] listening on "${QUEUE_NAME}", concurrency=${CONCURRENCY}`);

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, closing cleanly…`);
  // close() waits for in-flight runs to finish rather than abandoning them.
  await worker.close();
  await workerConnection.quit();
  await stopConnection.quit().catch(() => undefined);
  await redis.quit();
  await closeDatabase().catch(() => undefined);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
