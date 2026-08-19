/**
 * Cancelling, Stopping and deleting runs — against a site that never answers.
 *
 * This is the defect the operator was reporting, and it is not reproducible
 * against a site that FAILS: it needs one that accepts the connection, reads the
 * request and never replies — see tests/blackhole.py. Against that,
 * `GopClient.request()` had no timeout and no AbortSignal, so a lane blocked for
 * ever, `runBatches` never reached its between-batch cancel check, and the run
 * sat at `running` with Cancel doing visibly nothing.
 *
 * Eight phases, each its own process, driven by tests/cancel.sh:
 *
 *   seed        stage a run aimed at the blackhole and exit
 *   cancel      press Cancel on a wedged run; it must reach `cancelled`
 *   redeliver   hand the cancelled job to the queue again; it must stay cancelled
 *   stop        press Stop; it must end NOW and warn about what it cannot promise
 *   arm         wedge a run and press Cancel, for the shell to SIGKILL into
 *   resurrect   after that SIGKILL and restart, the run is still cancelled
 *   schedule    a run fires on its own, and is re-checked for permission when it does
 *   remove      delete a finished run's rows, and refuse a live one
 *
 * And four for §2.6, against tests/flaky.py rather than the blackhole — a site
 * that stops failing is what makes a retry observable at all:
 *
 *   retrysucceeds   a batch times out once and goes through on the next attempt
 *   retryexhausted  a site that never answers: bounded attempts, same error code
 *   retrynever      a batch the site REFUSED is not sent a second time
 *   retrystop       Stop pressed during a backoff ends the run there and then
 *
 * And two for §6 C1, where the only difference between them is how fast the
 * fixture answers:
 *
 *   lanesdown       a slow site makes the run stand lanes down, losing no work
 *   lanessteady     a fast site keeps every lane, under the same threshold
 *
 * And two for §6 C3, asserted from the RECEIVER's side — the only side that can
 * prove a signature verifies against the bytes that arrived:
 *
 *   notify          a finished run is delivered, signed, with its final numbers
 *   notifyfailures  "only when something went wrong": silence for a clean run,
 *                   delivery for a failing one, and a dead receiver harms neither
 *   telegram        the same event on the second channel, asserted from the receiving
 *                   end: the right bot, the right chat, and the same switch
 *
 * And one for §6 C2, which is mostly about what a repeat must NOT do to the run
 * model:
 *
 *   repeat          a series fires, stages the next occurrence as an ordinary
 *                   scheduled run, survives its own history being deleted, cannot
 *                   be doubled by a redelivery, and pauses without losing anything
 *
 * Run through tests/cancel.sh, never directly.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { db } from "../db";
import { closeDatabase } from "../db";
import { jobBatches, jobItems, jobResults } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  enqueueEdit,
  enqueueImport,
  forgetJob,
  getJobState,
  isScheduled,
  isTerminal,
  getResults,
  importQueue,
  jobFootprint,
  requestCancel,
  requestStop,
} from "../lib/jobs";
import { getJobLogs } from "../lib/job-log";
import { DEFAULT_IMPORT_OPTIONS } from "../lib/import-options";
import {
  EDIT_CANCEL_WARNING,
  describeEdit,
  type EditItem,
  type EditOperation,
} from "../lib/edit-options";
import { DEFAULT_LIMITS, saveLimits } from "../lib/limits";
import { redis } from "../lib/redis";
import { createStore } from "../lib/stores";
import { getTelegramPublic, getWebhookPublic, saveTelegram, saveWebhook } from "../lib/settings";
import {
  advanceSchedule,
  createSchedule,
  deleteSchedule,
  getSchedule,
  nextOccurrenceAt,
  setSchedulePaused,
} from "../lib/schedules";
import { verifySignature } from "../lib/gop-client";
import { applyOptions } from "../lib/transform";
import type { JobState } from "../lib/jobs";
import type { Product } from "../lib/gop-client";
import { makeAccount } from "./accounts";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** 8 batches of 50 across 4 lanes: every lane wedges, 4 batches never get sent. */
const PRODUCTS = 400;
const BATCH_SIZE = 50;
const LANES = 4;

/* ------------------------------------------------------------------- seed */

/**
 * Stage a run at the blackhole.
 *
 * With ACCOUNT_ALICE and STORE_ID in the environment it reuses them, so the
 * later phases each get a fresh run without a fresh account — an account per run
 * would make "whose run is this" the thing under test, and it is not.
 */
async function seed(): Promise<void> {
  const existingAccount = process.env.ACCOUNT_ALICE ?? "";
  const existingStore = process.env.STORE_ID ?? "";

  const ownerId =
    existingAccount === "" ? (await makeAccount("alice@cancel.test")).id : existingAccount;

  const storeId =
    existingStore === ""
      ? (
          // Deliberately NOT checked with checkStore(): a health check against
          // the blackhole would wedge this process rather than the worker.
          await createStore(ownerId, {
            url: process.env.BLACKHOLE_URL!,
            pin: "",
            apiKey: "cancelkey0123456",
            apiSecret: "cancel-secret-never-logged",
            urlRewrite: false,
            baseUrlOverride: process.env.BLACKHOLE_URL!,
            label: "the site that never answers",
          })
        ).id
      : existingStore;

  const options = {
    ...DEFAULT_IMPORT_OPTIONS,
    storeId,
    threads: LANES,
    batchSize: BATCH_SIZE,
  };

  const raw: Product[] = Array.from({ length: PRODUCTS }, (_ignored, index) => ({
    name: `Cancel Probe ${index + 1}`,
    slug: `cancel-probe-${index + 1}`,
    sku: `CANCEL-${process.env.SEED_TAG ?? "a"}-${index + 1}`,
    price: "10000",
    instock: true,
  }));

  const job = await enqueueImport({
    storeId,
    storeUrl: process.env.BLACKHOLE_URL!,
    sourceLabel: `cancel-fixture-${process.env.SEED_TAG ?? "a"}.csv`,
    options,
    products: applyOptions(raw, options, { sourceId: `cancel-${process.env.SEED_TAG ?? "a"}` }),
    createdBy: ownerId,
  });

  check("the run enters the queue as queued", job.status === "queued");
  check(
    `it is staged as ${PRODUCTS} products in 8 batches`,
    job.total === PRODUCTS && job.batches === 8,
    `total=${job.total} batches=${job.batches}`,
  );
  check(
    "no stop has been asked for yet",
    job.cancelRequestedAt === null && job.cancelMode === null,
  );

  console.log(`\nACCOUNT_ALICE=${ownerId}`);
  console.log(`STORE_ID=${storeId}`);
  console.log(`JOB_ID=${job.id}`);

  return finish();
}

/* ----------------------------------------------------------------- cancel */

/**
 * THE RED TEST.
 *
 * Before the fix this failed at "the run reaches cancelled": every lane was
 * blocked inside `fetch` with no deadline, so nothing read the cancel record and
 * the status stayed `running` until the polling here gave up 45 seconds later.
 */
async function verifyCancel(): Promise<void> {
  const jobId = process.env.JOB_ID!;

  console.log("\nCancel — a run wedged in a request that will never return\n");

  const wedged = await untilWedged(jobId);
  if (wedged === null) {
    return finish();
  }

  const requestedAt = Date.now();
  await requestCancel(jobId);
  console.log("     Cancel pressed.");

  const asked = await getJobState(jobId);
  check(
    "the cancel is recorded on the run itself, durably, before anything stops",
    asked?.cancelRequestedAt !== null && asked?.cancelMode === "cancel",
    `cancelRequestedAt=${asked?.cancelRequestedAt} mode=${asked?.cancelMode}`,
  );

  const cancelled = await waitForStatus(jobId, (state) => state.status === "cancelled", 45);
  const tookMs = Date.now() - requestedAt;

  check(
    "the run reaches cancelled instead of sitting at running for ever",
    cancelled?.status === "cancelled",
    `status=${cancelled?.status} after ${Math.round(tookMs / 1000)}s — before the fix ` +
      `this never happened: no deadline, no signal, no boundary ever reached`,
  );

  if (cancelled?.status === "cancelled") {
    console.log(`     Cancelled ${Math.round(tookMs / 1000)}s after the press.`);
  }

  check(
    "a graceful cancel carries no warning, because it has nothing to warn about",
    (cancelled?.error ?? null) === null,
    `error=${cancelled?.error}`,
  );

  /*
   * What a batch cut short is allowed to claim.
   *
   * The four batches never sent must have NO rows. Inventing 200 failed products
   * because the operator pressed Cancel would be a lie in the results table, and
   * it is the specific lie this fix had to avoid.
   *
   * The four that WERE sent and never answered are recorded — but as
   * `request_timeout`, not the generic `batch_failed`. `batch_failed` reads as
   * "the site rejected these"; what happened is "the site was given these and
   * never said", which is the one case where they may be on the site anyway.
   */
  const results = await getResults(jobId, 0, PRODUCTS);
  const codes = [...new Set(results.map((result) => result.error?.code ?? "ok"))].sort();

  check(
    "the batches that were never sent produced no result rows at all",
    results.length <= LANES * BATCH_SIZE,
    `rows=${results.length}, but only ${LANES * BATCH_SIZE} products were ever sent`,
  );
  check(
    "the rows that do exist say the site never answered, not that it refused",
    results.length === 0 || codes.every((code) => code === "request_timeout"),
    `codes=${JSON.stringify(codes)}`,
  );
  check("no product is blamed on the generic batch_failed", !codes.includes("batch_failed"), `codes=${JSON.stringify(codes)}`);

  const final = await getJobState(jobId);
  check(
    "the run does not claim to have processed products it never sent",
    (final?.processed ?? 0) < PRODUCTS,
    `processed=${final?.processed} of total=${final?.total}`,
  );

  return finish();
}

/* -------------------------------------------------------------- redeliver */

/**
 * §2.2 and §2.3 together: a cancelled run must STAY cancelled.
 *
 * `runJob` used to check only that the run existed, and `finishJob` deleted the
 * Redis cancel flag at the exact moment a cancelled run finished — so a
 * redelivery found no flag, called `markRunning()`, flipped the status back to
 * `running` and published the whole payload again. Both halves are needed and
 * this is the test that says so.
 */
async function verifyRedelivery(): Promise<void> {
  const jobId = process.env.JOB_ID!;

  console.log("\nRedelivery — the queue hands a cancelled run over a second time\n");

  const before = await getJobState(jobId);

  check(
    "the run under test is cancelled to begin with",
    before?.status === "cancelled",
    `status=${before?.status}`,
  );

  if (before?.status !== "cancelled") {
    return finish();
  }

  // Exactly what a stall does: the old queue entry goes, the same id comes back.
  const existing = await importQueue.getJob(jobId);
  await existing?.remove().catch(() => undefined);
  await importQueue.add("run", { jobId }, { jobId });

  console.log("     Job id re-added to the queue. Waiting to see whether it re-runs…");

  // Long enough for the worker to pick it up, and then some.
  await sleep(12_000);

  const after = await getJobState(jobId);

  check(
    "it is STILL cancelled — the database is what the worker trusts, not the queue",
    after?.status === "cancelled",
    `status=${after?.status}`,
  );
  check(
    "processed did not grow, so the payload was not published a second time",
    after?.processed === before.processed,
    `before=${before.processed} after=${after?.processed}`,
  );
  check(
    "the cancel record survived the run finishing, rather than being deleted with it",
    after?.cancelRequestedAt !== null,
    `cancelRequestedAt=${after?.cancelRequestedAt}`,
  );

  return finish();
}

/* ------------------------------------------------------------------- stop */

/**
 * Stop, as distinct from Cancel.
 *
 * The case Cancel cannot serve. Cancel on a wedged run still has to wait out the
 * request deadline, because its promise is that no product is cut off mid-write.
 * Stop abandons the request there and then — and must say plainly that the site
 * may hold products the results table does not list.
 */
async function verifyStop(): Promise<void> {
  const jobId = process.env.JOB_ID!;

  console.log("\nStop — end a run wedged in a request that will never return, NOW\n");

  const wedged = await untilWedged(jobId);
  if (wedged === null) {
    return finish();
  }

  const requestedAt = Date.now();
  await requestStop(jobId);
  console.log("     Stop pressed.");

  const stopped = await waitForStatus(jobId, (state) => state.status === "cancelled", 30);
  const tookMs = Date.now() - requestedAt;

  check(
    "the run ends without waiting for the request deadline",
    stopped?.status === "cancelled",
    `status=${stopped?.status} after ${Math.round(tookMs / 1000)}s`,
  );

  /*
   * The deadline in this harness is deliberately short so a graceful Cancel can
   * be measured at all. Stop must beat it comfortably — that difference IS the
   * distinction between the two buttons, and a Stop that merely waited out the
   * deadline would be a second button that does nothing new.
   */
  const deadlineMs = Number.parseInt(process.env.GOP_REQUEST_TIMEOUT_MS ?? "8000", 10);

  check(
    `it aborted the request in flight rather than waiting out the ${deadlineMs}ms deadline`,
    tookMs < deadlineMs,
    `took ${tookMs}ms, deadline is ${deadlineMs}ms`,
  );

  console.log(`     Stopped ${tookMs}ms after the press.`);

  check(
    "the run is recorded as having been STOPPED, not merely cancelled",
    stopped?.cancelMode === "stop",
    `mode=${stopped?.cancelMode}`,
  );

  check(
    "and it says on the run that the site may hold products the results do not list",
    (stopped?.error ?? "").includes("can hold products that are not listed"),
    stopped?.error ?? "(no warning recorded)",
  );

  const results = await getResults(jobId, 0, PRODUCTS);

  check(
    "the abandoned batches claim nothing at all, neither success nor failure",
    results.length === 0,
    `rows=${results.length} — an aborted batch cannot honestly report per-row outcomes`,
  );

  /* ---- the log is what explains all of the above ---- */

  const log = await getJobLogs(jobId, { limit: 2000 });
  const text = log.map((line) => line.message).join("\n");

  check("the run wrote a log", log.length > 0, `lines=${log.length}`);
  check(
    "log lines are ordered by id, so a cursor cannot skip or repeat one",
    log.every((line, index) => index === 0 || line.id > log[index - 1].id),
  );
  check(
    "it says the worker picked the run up, and with what options",
    log.some((line) => line.stage === "run" && /Picked up by the worker/.test(line.message)) &&
      log.some((line) => line.stage === "run" && /parallel lane/.test(line.message)),
    JSON.stringify(log.filter((line) => line.stage === "run").map((line) => line.message)),
  );
  check(
    "it logged EACH batch BEFORE sending it — the line that explains a wedged run",
    log.filter((line) => line.stage === "batch" && /^Sending batch /.test(line.message)).length >= LANES,
    `sending lines=${log.filter((line) => /^Sending batch /.test(line.message)).length}`,
  );
  check(
    "it records the batch that Stop ABANDONED in flight, and says the site may hold it",
    log.some(
      (line) =>
        line.stage === "cancel" &&
        /ABANDONED in flight/.test(line.message) &&
        /may have committed them/.test(line.message),
    ),
    JSON.stringify(log.filter((line) => line.stage === "cancel").map((line) => line.message)),
  );
  check(
    "it ends with a finish line naming the mode and the totals",
    log.some((line) => line.stage === "finish" && /STOPPED/.test(line.message)),
    JSON.stringify(log.filter((line) => line.stage === "finish").map((line) => line.message)),
  );
  check(
    "no secret reached the log table",
    !text.includes("cancel-secret-never-logged") &&
      !text.includes(process.env.STORE_ENCRYPTION_KEY ?? "\u0000"),
  );
  check(
    "and no HMAC signature or header name reached it either",
    !/X-TSD-|Signature|apiSecret/i.test(text),
    text.slice(0, 200),
  );

  return finish();
}

/* -------------------------------------------------- the resurrection setup */

/**
 * Wait until the run is wedged, press Cancel, and return — leaving the worker
 * mid-flight for the shell to SIGKILL.
 *
 * Its own phase rather than an inline `tsx -e` in the shell script: `tsx -e`
 * compiles to CJS, which has no top-level await, so anything that touches the
 * database from a one-liner fails to build. Discovered the hard way.
 */
async function armResurrection(): Promise<void> {
  const jobId = process.env.JOB_ID!;

  console.log("\nArming — wedge the run, press Cancel, then let the shell kill the worker\n");

  const wedged = await untilWedged(jobId);
  if (wedged === null) {
    return finish();
  }

  await requestCancel(jobId);

  const asked = await getJobState(jobId);

  check(
    "the cancel is on the run before the worker dies, which is the whole point",
    asked?.cancelRequestedAt !== null && asked?.status === "running",
    `status=${asked?.status} cancelRequestedAt=${asked?.cancelRequestedAt}`,
  );

  console.log("     Cancel pressed. The worker still holds the job and has not settled it.");

  return finish();
}

/* -------------------------------------------------------------- resurrect */

/**
 * §2.4 as an actual test: a worker killed without releasing its lock.
 *
 * SIGKILL rather than SIGTERM on purpose — a clean shutdown releases the lock and
 * finishes the run, which is the case that already worked. Killed hard, BullMQ
 * marks the job stalled and hands it to a worker again, and the run must not come
 * back to life.
 *
 * This exercises the SECOND guard rather than the first: the status is still
 * `running` when the worker dies, so `isTerminal` does not catch it — what catches
 * it is the durable cancel record, which is precisely what the Redis flag could
 * not have provided.
 */
async function verifyResurrect(): Promise<void> {
  const jobId = process.env.JOB_ID!;

  console.log("\nResurrection — the worker is SIGKILLed mid-cancel, then restarted\n");

  const state = await getJobState(jobId);

  check(
    "the run was left mid-flight by the kill, with a stop already asked for",
    state?.cancelRequestedAt !== null,
    `status=${state?.status} cancelRequestedAt=${state?.cancelRequestedAt}`,
  );

  const processedAtKill = state?.processed ?? 0;

  console.log("     Waiting for BullMQ to notice the stalled job and redeliver it…");

  const settled = await waitForStatus(jobId, (job) => job.status === "cancelled", 90);

  check(
    "the redelivered run settles as cancelled rather than starting again",
    settled?.status === "cancelled",
    `status=${settled?.status}`,
  );
  check(
    "and it published nothing further after the restart",
    (settled?.processed ?? 0) === processedAtKill,
    `atKill=${processedAtKill} now=${settled?.processed}`,
  );

  return finish();
}

/* ----------------------------------------------------------------- remove */

/**
 * Delete, and what it takes with it.
 *
 * `forgetJob` refuses a live run and that refusal stays — deleting the row of a
 * running run would leave the worker with nowhere to write progress. What is new
 * is being able to say how many rows will go BEFORE asking, which for a large run
 * is the difference between "delete this run" and "delete this run and several
 * thousand result rows".
 */
async function verifyRemove(): Promise<void> {
  const finishedId = process.env.JOB_ID!;
  const liveId = process.env.LIVE_JOB_ID ?? "";

  console.log("\nDelete — a finished run's rows go; a live run is refused\n");

  const footprint = await jobFootprint(finishedId);

  check("the footprint is known before anything is deleted", footprint !== null);

  if (footprint === null) {
    return finish();
  }

  check(
    "it counts result rows, batch records, LOG LINES and the staged payload — not just the run",
    footprint.total ===
      1 + footprint.results + footprint.batches + footprint.items + footprint.logs,
    JSON.stringify(footprint),
  );
  check(
    "the staged payload is one row, and it is still there to be reclaimed",
    footprint.items === 1,
    `items=${footprint.items}`,
  );
  check("a finished run reports itself deletable", footprint.deletable, `status=${footprint.status}`);

  const deleted = await forgetJob(finishedId);
  check("the finished run is deleted", deleted);

  const [results, batches, items] = await Promise.all([
    db.select().from(jobResults).where(eq(jobResults.jobId, finishedId)),
    db.select().from(jobBatches).where(eq(jobBatches.jobId, finishedId)),
    db.select().from(jobItems).where(eq(jobItems.jobId, finishedId)),
  ]);

  check("the run row is gone", (await getJobState(finishedId)) === null);
  check("job_result went with it, by cascade", results.length === 0, `rows=${results.length}`);
  check("job_batch went with it", batches.length === 0, `rows=${batches.length}`);
  check("job_item went with it, which is what reclaims the space", items.length === 0, `rows=${items.length}`);
  check(
    "job_log went with it too, and the footprint had counted those lines",
    (await getJobLogs(finishedId, { limit: 10 })).length === 0 && footprint.logs > 0,
    `logs remaining=${(await getJobLogs(finishedId, { limit: 10 })).length} counted=${footprint.logs}`,
  );

  if (liveId !== "") {
    const live = await getJobState(liveId);
    const liveFootprint = await jobFootprint(liveId);

    check(
      "a run that is still queued or running reports itself NOT deletable",
      liveFootprint?.deletable === false,
      `status=${live?.status}`,
    );
    check(
      "and deleting it is refused outright",
      (await forgetJob(liveId)) === false,
      `status=${live?.status}`,
    );
    check("so it is still there", (await getJobState(liveId)) !== null);
  }

  return finish();
}

/* --------------------------------------------------------------- scheduled */

/**
 * A scheduled run fires on its own, and is still subject to the account's
 * permissions WHEN IT FIRES.
 *
 * Needs a worker, which is why it lives here rather than in tests/isolation.ts —
 * that suite runs the real server but no worker, so it can only prove the half
 * reachable from a browser.
 *
 * The second run is the one that matters. Scheduling and firing can be days
 * apart, and an account whose import permission is revoked in between must not
 * publish on a decision made before the revocation. Checking only at scheduling
 * time would let exactly that happen, quietly, at 3am.
 */
async function verifySchedule(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;
  const storeId = process.env.STORE_ID!;

  console.log("\nScheduled runs — firing on time, and re-checked when they do\n");

  const soon = new Date(Date.now() + 8_000);
  const fires = await stageRun(ownerId, storeId, "sched-fires", soon);

  check(
    "before its time it is queued in the database but derived as scheduled",
    fires.status === "queued" && isScheduled(fires),
    `status=${fires.status} scheduledFor=${fires.scheduledFor}`,
  );

  // The worker must NOT have it yet. If BullMQ ignored the delay this would
  // already be running, and everything below would be measuring nothing.
  await sleep(2000);

  const notYet = await getJobState(fires.id);
  check(
    "the worker leaves it alone until its time",
    notYet?.status === "queued" && notYet?.startedAt === null,
    `status=${notYet?.status} startedAt=${notYet?.startedAt}`,
  );

  const fired = await waitForStatus(fires.id, (state) => state.status !== "queued", 60);
  check(
    "it fires on its own, with nobody pressing anything",
    fired?.status === "running" || fired?.status === "cancelled" || fired?.status === "completed",
    `status=${fired?.status}`,
  );
  check(
    "and it is no longer derived as scheduled once it has started",
    fired !== null && !isScheduled(fired),
    `status=${fired?.status} scheduledFor=${fired?.scheduledFor}`,
  );

  // Stop it so it does not sit wedged against the blackhole for the rest of the
  // suite — the point above is already made.
  await requestStop(fires.id);

  /* ---- permission revoked between scheduling and firing ---- */

  const later = new Date(Date.now() + 10_000);
  const revoked = await stageRun(ownerId, storeId, "sched-revoked", later);

  check("a second run is scheduled", isScheduled(revoked), `status=${revoked.status}`);

  await saveLimits(
    ownerId,
    { ...DEFAULT_LIMITS, importEnabled: false },
    ownerId,
  );

  console.log("     Import permission revoked while the run waits for its time.");

  const refused = await waitForStatus(revoked.id, (state) => state.status === "failed", 90);

  check(
    "when it fires, the revoked permission makes it FAIL rather than publish",
    refused?.status === "failed",
    `status=${refused?.status} error=${refused?.error}`,
  );
  check(
    "and the failure names the switch as the cause",
    (refused?.error ?? "").includes("Importing is switched off"),
    refused?.error ?? "(no error recorded)",
  );
  check(
    "and says the permission changed after it was scheduled",
    (refused?.error ?? "").includes("permissions changed before it fired"),
    refused?.error ?? "(no error recorded)",
  );
  check(
    "nothing was sent to the site",
    refused?.processed === 0,
    `processed=${refused?.processed}`,
  );

  // Put it back, so this phase leaves the account as it found it.
  await saveLimits(ownerId, DEFAULT_LIMITS, ownerId);

  return finish();
}

/** One small run at the blackhole, optionally scheduled. */
async function stageRun(
  ownerId: string,
  storeId: string,
  tag: string,
  scheduledFor: Date | null,
): Promise<JobState> {
  const options = { ...DEFAULT_IMPORT_OPTIONS, storeId, threads: 1, batchSize: BATCH_SIZE };

  const raw: Product[] = Array.from({ length: 10 }, (_ignored, index) => ({
    name: `${tag} ${index + 1}`,
    slug: `${tag}-${index + 1}`,
    sku: `${tag.toUpperCase()}-${index + 1}`,
    price: "10000",
    instock: true,
  }));

  return enqueueImport({
    storeId,
    storeUrl: process.env.BLACKHOLE_URL!,
    sourceLabel: `${tag}.csv`,
    options,
    products: applyOptions(raw, options, { sourceId: tag }),
    createdBy: ownerId,
    scheduledFor,
  });
}

/* ------------------------------------------------------------- bulk edit */

/**
 * A BULK EDIT wedged at the never-answering site, and Stop on it.
 *
 * The claim §2.5 makes is that a bulk edit "runs as a run through the existing
 * queue, worker, log and cancel machinery". That is only worth anything if it is
 * true of the case the machinery exists for — a site that accepts the connection
 * and never answers, where a lane has no batch boundary to reach and Cancel alone
 * would wait out the deadline. This is the only harness where that reproduces.
 *
 * It also asserts the sentence that makes a bulk edit different from a removal, and
 * the one it would be easiest to leave off a screen: a cancelled removal leaves the
 * un-deleted products alone, while a cancelled reprice leaves the already-repriced
 * products **repriced**. Cancel stops the run; it does not put the old values back.
 */
async function verifyEditStop(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;
  const storeId = process.env.STORE_ID!;

  console.log("\nBulk edit — the same machinery, including Stop\n");

  const operation: EditOperation = {
    kind: "price",
    target: "regular_price",
    operation: "percent",
    value: -10,
    decimals: 0,
  };

  const items: EditItem[] = Array.from({ length: 10 }, (_ignored, index) => ({
    product_id: 9000 + index,
    sku: `EDIT-${index + 1}`,
    name: `Edit ${index + 1}`,
    set: { regular_price: "90000" },
    was: {
      price: "100000",
      regular_price: "100000",
      sale_price: "",
      status: "publish",
      stock: "",
    },
  }));

  const job = await enqueueEdit({
    storeId,
    storeUrl: process.env.BLACKHOLE_URL!,
    sourceLabel: describeEdit(operation),
    createdBy: ownerId,
    options: { storeId, operation, threads: 1, batchSize: BATCH_SIZE, displayCurrency: "" },
    products: items,
  });

  check("a bulk edit is queued as kind=update", job.kind === "update", job.kind);

  const wedged = await untilWedged(job.id);
  if (wedged === null) {
    return finish();
  }

  check(
    "it wedges in the same place an import does — no result rows yet",
    (await getResults(job.id)).length === 0,
    `rows=${(await getResults(job.id)).length}`,
  );

  /*
   * The log line for a batch is written BEFORE the request goes out, which is the
   * only thing on screen while a site holds the connection open. It has to be true
   * of this kind of run too, or the log panel is empty for the whole deadline on
   * exactly the run somebody is watching.
   */
  const during = await getJobLogs(job.id, { limit: 200 });

  check(
    "the log already explains what it is doing, before any answer came back",
    during.some((line) => line.stage === "batch" && line.message.includes("Sending batch")),
    during.map((line) => `${line.stage}:${line.message}`).join(" | ").slice(0, 300),
  );
  check(
    "and it named the change in words when it picked the run up",
    during.some((line) => line.stage === "run" && line.message.includes("Bulk edit")),
    during
      .filter((line) => line.stage === "run")
      .map((line) => line.message)
      .join(" | ")
      .slice(0, 300),
  );

  const requestedAt = Date.now();
  await requestStop(job.id);

  const stopped = await waitForStatus(job.id, (state) => state.status === "cancelled", 30);
  const tookMs = Date.now() - requestedAt;

  const deadlineMs = Number.parseInt(process.env.GOP_REQUEST_TIMEOUT_MS ?? "8000", 10);

  check(
    "Stop ends a wedged bulk edit without waiting out the request deadline",
    stopped?.status === "cancelled" && tookMs < deadlineMs,
    `status=${stopped?.status} took ${tookMs}ms, deadline ${deadlineMs}ms`,
  );
  check(
    "it is recorded as STOPPED rather than merely cancelled",
    stopped?.cancelMode === "stop",
    `mode=${stopped?.cancelMode}`,
  );

  /*
   * The abandoned batch records NOTHING. Same reasoning as the import path: the
   * products were sent, the site may or may not have committed them, and writing ten
   * rows either way would assert something this process cannot know.
   */
  check(
    "the abandoned batch invented no result rows",
    (await getResults(job.id)).length === 0,
    `rows=${(await getResults(job.id)).length}`,
  );

  check(
    "the run carries the warning that the site may hold changes it never recorded",
    (stopped?.error ?? "").includes("may have been committed") ||
      (stopped?.error ?? "").includes("can hold products"),
    `error=${(stopped?.error ?? "").slice(0, 200)}`,
  );

  const after = await getJobLogs(job.id, { limit: 500 });

  check(
    "the log records the batch abandoned in flight",
    after.some((line) => line.stage === "cancel" && line.message.includes("ABANDONED")),
    after
      .filter((line) => line.stage === "cancel")
      .map((line) => line.message)
      .join(" | ")
      .slice(0, 300),
  );
  check(
    "and closes with a summary, like every other run",
    after.some((line) => line.stage === "finish"),
    after.map((line) => line.stage).join(","),
  );

  /*
   * The sentence a screen would be tempted to leave off.
   *
   * Asserted as a property of the SHARED warning text rather than of this run, so it
   * cannot be quietly softened later: a cancel does not undo what already landed.
   */
  check(
    "the bulk-edit warning says out loud that a cancel does not put the old values back",
    EDIT_CANCEL_WARNING.includes("stay changed") &&
      EDIT_CANCEL_WARNING.includes("does not put the old values back"),
    EDIT_CANCEL_WARNING,
  );

  return finish();
}

/* ------------------------------------------------------------------ retry */

/**
 * §2.6 — a batch that failed because the SITE hiccuped is sent again; a batch the
 * site made a decision about is not.
 *
 * Four phases, and they need a site tests/blackhole.py cannot be: one that fails
 * and then stops failing. "It went through on the second attempt" is not
 * observable against a site that never answers at all, and neither is "it was
 * NOT sent again, because what came back was an answer rather than a silence".
 * That is tests/flaky.py, and each phase points a store at one of its scenarios.
 *
 * The strongest assertion in all four is the REQUEST COUNT, read from the site
 * itself. How many times the app decided to send something is a fact only the
 * receiving end holds; counting log lines would be counting this app's own
 * account of what it did.
 */

/** Ten products, one batch, one lane: the retry is the only variable. */
const RETRY_PRODUCTS = 10;

/** A store aimed at one of tests/flaky.py's scenarios, by path. */
async function stageAtFlaky(
  ownerId: string,
  scenario: string,
  shape: { products?: number; threads?: number } = {},
): Promise<JobState> {
  const total = shape.products ?? RETRY_PRODUCTS;
  const threads = shape.threads ?? 1;
  // GopClient builds `<baseUrl>/index.php?route=…`, so the scenario rides in the
  // base URL's path and one fixture container serves every phase.
  const url = `${process.env.FLAKY_URL!}/${scenario}`;

  const store = await createStore(ownerId, {
    url,
    pin: "",
    apiKey: "flakykey012345678",
    // The same secret the blackhole store uses, so the suite's closing grep for
    // it covers these runs too rather than only the ones it was written for.
    apiSecret: "cancel-secret-never-logged",
    urlRewrite: false,
    baseUrlOverride: url,
    label: `the flaky site (${scenario})`,
  });

  const options = { ...DEFAULT_IMPORT_OPTIONS, storeId: store.id, threads, batchSize: BATCH_SIZE };

  const raw: Product[] = Array.from({ length: total }, (_ignored, index) => ({
    name: `Retry ${scenario} ${index + 1}`,
    slug: `retry-${scenario}-${index + 1}`,
    sku: `RETRY-${scenario}-${index + 1}`,
    price: "10000",
    instock: true,
  }));

  return enqueueImport({
    storeId: store.id,
    storeUrl: url,
    sourceLabel: `retry-${scenario}.csv`,
    options,
    // Staged ONCE. `applyOptions` mints a fresh random slug suffix on every call
    // and the idempotency key is hashed from the slug, so calling it twice would
    // produce two different sets of keys for what is meant to be one file read.
    products: applyOptions(raw, options, { sourceId: `retry-${scenario}` }),
    createdBy: ownerId,
  });
}

/**
 * How many times the site was sent the BATCH — a fact only the site has.
 *
 * Per route, not per scenario: a run that succeeds also calls
 * `/maintenance/clear-transients` when it finishes, and counting every request
 * together made that closing call read as a third attempt at the batch.
 */
async function siteRequests(scenario: string, route = "/products/batch"): Promise<number> {
  const response = await fetch(`${process.env.FLAKY_URL!}/_counts`);
  const counts = (await response.json()) as Record<string, number>;
  return counts[`${scenario} ${route}`] ?? 0;
}

/**
 * A run that timed out once and then went through.
 *
 * The red test of the four. Before batch-level retry this run also reached
 * `completed` — with all ten products recorded as `request_timeout` failures and
 * an operator left to press "Resend the failures" for a hiccup that had already
 * passed. So the assertion is on the PRODUCTS, never on the status alone.
 */
async function verifyRetrySucceeds(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;

  console.log("\nRetry — a batch that timed out once, then went through\n");

  const job = await stageAtFlaky(ownerId, "timeout-once");
  const done = await waitForStatus(job.id, (state) => isTerminal(state.status), 90);

  check(
    "the run completed rather than ending on a failure that had already passed",
    done?.status === "completed",
    `status=${done?.status}`,
  );
  check(
    "every product landed — the timeout cost time, not products",
    done?.succeeded === RETRY_PRODUCTS && done?.failed === 0,
    `succeeded=${done?.succeeded} failed=${done?.failed} of ${RETRY_PRODUCTS}`,
  );

  const results = await getResults(job.id, 0, RETRY_PRODUCTS);
  const codes = [...new Set(results.map((result) => result.error?.code ?? "ok"))].sort();

  check(
    "no row is blamed on the timeout the run recovered from",
    !codes.includes("request_timeout"),
    `codes=${JSON.stringify(codes)}`,
  );

  const requests = await siteRequests("timeout-once");
  check(
    "the site received the batch exactly twice: once unanswered, once answered",
    requests === 2,
    `requests=${requests}`,
  );

  /* ---- every attempt is visible, which is the half easiest to leave out ---- */

  const log = await getJobLogs(job.id, { limit: 2000 });
  const messages = log.map((line) => line.message);

  check(
    "the log records the attempt that FAILED, not only the one that worked",
    log.some(
      (line) => line.stage === "batch" && line.level === "error" && /did not answer/.test(line.message),
    ),
    messages.filter((message) => /batch 1/i.test(message)).join(" | ").slice(0, 400),
  );
  check(
    "it says the batch will be sent again, and how many attempts it is allowed",
    log.some(
      (line) =>
        line.stage === "batch" &&
        line.level === "warn" &&
        /sent again/.test(line.message) &&
        /attempt 2 of 3/.test(line.message),
    ),
    messages.filter((message) => /again/.test(message)).join(" | ").slice(0, 400),
  );
  check(
    "the second attempt is announced BEFORE it goes out, exactly like the first",
    messages.filter((message) => /^Sending batch 1 of 1/.test(message)).length === 2,
    `sending lines=${messages.filter((message) => /^Sending batch 1 of 1/.test(message)).length}`,
  );
  check(
    "and the answer names the attempt it came back on, so a run that only worked " +
      "the second time does not read as though it worked the first",
    log.some((line) => /answered/.test(line.message) && /attempt 2 of 3/.test(line.message)),
    messages.filter((message) => /answered/.test(message)).join(" | ").slice(0, 400),
  );

  return finish();
}

/**
 * A site that never answers: the attempts must be BOUNDED, and the rows must
 * still say what they said before this feature existed.
 *
 * `request_timeout` is load-bearing — it is the one code whose message admits the
 * products may be on the site regardless, and it is what tells "resend these"
 * apart from "fix the data". A retry that gave up under a new code would break
 * that distinction while looking like an improvement.
 */
async function verifyRetryExhausted(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;

  console.log("\nRetry — a site that never answers: bounded attempts, same code\n");

  const job = await stageAtFlaky(ownerId, "always-timeout");
  const done = await waitForStatus(job.id, (state) => isTerminal(state.status), 120);

  check("the run reaches a terminal state instead of retrying for ever", done?.status === "completed", `status=${done?.status}`);
  check(
    "the products are recorded as failures, all of them",
    done?.failed === RETRY_PRODUCTS && done?.succeeded === 0,
    `succeeded=${done?.succeeded} failed=${done?.failed}`,
  );

  const results = await getResults(job.id, 0, RETRY_PRODUCTS);
  const codes = [...new Set(results.map((result) => result.error?.code ?? "ok"))].sort();

  check(
    "and they still say `request_timeout` — not a new code invented for giving up",
    codes.length === 1 && codes[0] === "request_timeout",
    `codes=${JSON.stringify(codes)}`,
  );

  const requests = await siteRequests("always-timeout");
  check(
    "the site received the batch three times and no more",
    requests === 3,
    `requests=${requests}`,
  );

  const log = await getJobLogs(job.id, { limit: 2000 });

  check(
    "the log shows both retries rather than one silent gap of three deadlines",
    log.filter((line) => /sent again/.test(line.message)).length === 2,
    log.filter((line) => /again/.test(line.message)).map((line) => line.message).join(" | ").slice(0, 400),
  );
  check(
    "and the line that gives up says how many attempts it took to get there",
    log.some((line) => line.stage === "batch" && /3 attempt/.test(line.message)),
    log.filter((line) => line.level === "error").map((line) => line.message).join(" | ").slice(0, 400),
  );

  return finish();
}

/**
 * A site that ANSWERED, with a refusal. It must not be asked twice.
 *
 * The guard on the other side of the feature, and the reason the classification
 * reads the error CODE rather than the fact that something went wrong. A row
 * missing its name fails identically however many times it is sent, so retrying
 * makes a doomed run take three times as long to reach the same answer — with
 * every batch of it waiting out a backoff nobody benefits from.
 */
async function verifyRetryNever(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;

  console.log("\nRetry — a batch the site REFUSED is not sent again\n");

  const job = await stageAtFlaky(ownerId, "reject");
  const done = await waitForStatus(job.id, (state) => isTerminal(state.status), 60);

  check("the run finished", done?.status === "completed", `status=${done?.status}`);

  const results = await getResults(job.id, 0, RETRY_PRODUCTS);
  const codes = [...new Set(results.map((result) => result.error?.code ?? "ok"))].sort();

  check(
    "the rows carry the site's own reason, unchanged",
    codes.length === 1 && codes[0] === "missing_name",
    `codes=${JSON.stringify(codes)}`,
  );

  const requests = await siteRequests("reject");
  check(
    "the site was asked exactly once — a decision is not a hiccup",
    requests === 1,
    `requests=${requests} — retrying a refusal only makes a doomed run slower`,
  );

  const log = await getJobLogs(job.id, { limit: 2000 });

  check(
    "and nothing in the log claims it would try again",
    !log.some((line) => /sent again/.test(line.message)),
    log.filter((line) => /again/.test(line.message)).map((line) => line.message).join(" | ").slice(0, 400),
  );

  return finish();
}

/**
 * Stop pressed while a batch is WAITING to be sent again.
 *
 * The failure mode this phase exists for: a lane inside a backoff is not at a
 * batch boundary and has no request in flight to abort, so a naive implementation
 * sleeps out the whole chain before noticing — Stop appearing to do nothing at
 * exactly the moment it matters, which is the defect this whole harness was built
 * to catch the first time.
 *
 * The backoff here is deliberately far longer than the suite's other waits (the
 * shell passes it), so "it did not wait out the backoff" is measurable rather
 * than inferred.
 */
async function verifyRetryStop(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;
  const backoffMs = Number.parseInt(process.env.GOP_RETRY_BACKOFF_MS ?? "2000", 10);

  console.log(`\nRetry — Stop pressed during a ${backoffMs}ms backoff\n`);

  const job = await stageAtFlaky(ownerId, "stop-backoff");

  const waiting = await untilLogged(job.id, /sent again/, 60);
  check(
    "the run got as far as waiting to send the batch again",
    waiting,
    "no line saying the batch would be sent again ever appeared",
  );

  if (!waiting) {
    return finish();
  }

  const requestedAt = Date.now();
  await requestStop(job.id);
  console.log("     Stop pressed while the lane was waiting out the backoff.");

  const stopped = await waitForStatus(job.id, (state) => state.status === "cancelled", 30);
  const tookMs = Date.now() - requestedAt;

  check(
    `it ended without sleeping out the ${backoffMs}ms backoff`,
    stopped?.status === "cancelled" && tookMs < backoffMs,
    `status=${stopped?.status} took ${tookMs}ms, backoff is ${backoffMs}ms`,
  );

  if (stopped?.status === "cancelled") {
    console.log(`     Stopped ${tookMs}ms into a ${backoffMs}ms backoff.`);
  }

  check(
    "it is recorded as STOPPED rather than merely cancelled",
    stopped?.cancelMode === "stop",
    `mode=${stopped?.cancelMode}`,
  );

  const requests = await siteRequests("stop-backoff");
  check(
    "and the batch was never sent again",
    requests === 1,
    `requests=${requests}`,
  );

  /*
   * What the rows say, and why they are not empty here.
   *
   * A batch abandoned IN FLIGHT records nothing, because nothing about it is
   * knowable. This batch is not that: its deadline expired, and "the site was sent
   * these and never answered within 8s" is a fact the run already had before
   * anybody pressed Stop. Dropping it because the retry was cut short would throw
   * away something true rather than avoid claiming something false.
   */
  const results = await getResults(job.id, 0, RETRY_PRODUCTS);
  const codes = [...new Set(results.map((result) => result.error?.code ?? "ok"))].sort();

  check(
    "the rows record what was already known: sent, never answered",
    results.length === RETRY_PRODUCTS && codes.length === 1 && codes[0] === "request_timeout",
    `rows=${results.length} codes=${JSON.stringify(codes)}`,
  );

  const log = await getJobLogs(job.id, { limit: 2000 });

  check(
    "the log says the retry was dropped because a stop was asked for",
    log.some((line) => line.stage === "cancel" && /waiting to be sent again/.test(line.message)),
    log.filter((line) => line.stage === "cancel").map((line) => line.message).join(" | ").slice(0, 400),
  );

  return finish();
}

/* -------------------------------------------------------------- telegram */

/**
 * Telegram as a second channel for the run-finished notification.
 *
 * Asserted from the RECEIVING end, like the webhook: `TELEGRAM_API_BASE` points at
 * tests/receiver.py, so what is checked is the request Telegram would have got —
 * the bot in the URL, the chat id and the text in the body — rather than this app's
 * belief that it sent something.
 */
async function verifyTelegram(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;
  const token = "111222:telegram-token-never-logged";
  const chatId = "-1009876543210";

  console.log("\nTelegram — the same event, delivered to a person\n");

  await resetDeliveries();
  // Webhook off, so one delivery means one channel and the assertion is unambiguous.
  await saveWebhook(ownerId, { url: "", secret: "", failuresOnly: false });
  await saveTelegram(ownerId, { token, chatId });

  const stored = await getTelegramPublic(ownerId);

  check(
    "the stored token says it exists without saying what it is",
    stored.tokenConfigured && !JSON.stringify(stored).includes("telegram-token"),
    JSON.stringify(stored),
  );
  check("the chat id IS shown back, because it is not a secret", stored.chatId === chatId);

  const job = await stageAtFlaky(ownerId, "fast", { products: 30, threads: 1 });
  const done = await waitForStatus(job.id, (state) => isTerminal(state.status), 90);

  check("the run completed", done?.status === "completed", `status=${done?.status}`);

  const sent = await untilDelivered(1, 30);

  check("exactly one message was sent", sent.length === 1, `deliveries=${sent.length}`);

  if (sent.length === 0) {
    return finish();
  }

  const [delivery] = sent;
  const payload = JSON.parse(delivery.body) as { chat_id?: string; text?: string };

  // The path carries the bot token, so it is checked and never printed.
  check("it went to the bot the account configured", delivery.path.includes("/sendMessage"));
  check("with that bot's token in the URL, which is how Telegram authenticates", delivery.path.includes(token));
  check("and to the chat the account configured", payload.chat_id === chatId, String(payload.chat_id));
  check(
    "the text names the site and the counts",
    typeof payload.text === "string" &&
      payload.text.includes("30 ok") &&
      payload.text.includes("0 failed"),
    String(payload.text),
  );

  const log = await getJobLogs(job.id, { limit: 2000 });

  check(
    "the run's log says Telegram was told",
    log.some((line) => line.stage === "notify" && /Telegram/.test(line.message)),
    log.filter((line) => line.stage === "notify").map((line) => line.message).join(" | "),
  );
  check(
    "and the log holds neither the token nor the chat id",
    !log.some((line) => line.message.includes(token) || line.message.includes(chatId)),
  );

  /* ---- the switch covers both channels, not just the webhook ---- */

  await resetDeliveries();
  await saveWebhook(ownerId, { url: `${process.env.RECEIVER_URL!}/hook`, secret: "", failuresOnly: true });

  const clean = await stageAtFlaky(ownerId, "fast", { products: 10, threads: 1 });
  await waitForStatus(clean.id, (state) => isTerminal(state.status), 90);
  await sleep(4000);

  check(
    '"only when something went wrong" silences Telegram too, not only the webhook',
    (await deliveries()).length === 0,
    JSON.stringify(await deliveries()).slice(0, 200),
  );

  // Left off for anything that runs after this.
  await saveTelegram(ownerId, { token: "", chatId: "" });
  await saveWebhook(ownerId, { url: "", secret: "", failuresOnly: false });

  return finish();
}

/* ------------------------------------------------------------------ lanes */

/**
 * §6 C1 — standing lanes down when the site is coping badly.
 *
 * 32 lanes of 50 products can take a small shop down, and the operator has no way
 * to know that in advance: they pick a lane count before the run and the shop's
 * behaviour is only visible during it. The per-batch wall clock is already
 * recorded, so the run can back off by itself rather than asking somebody to guess
 * again.
 *
 * Two phases, and the ONLY difference between them is how fast the site answers:
 * the same worker, the same threshold, the same run shape. That is what makes the
 * second one worth having — a rule that stands lanes down when a site is fine is a
 * rule that has quietly halved every run in the system.
 *
 * Both assert that every product still lands. A run that loses work while backing
 * off would be a far worse defect than the one this fixes.
 */

/** 8 batches across 4 lanes: more batches than lanes, so a lane leaving is visible. */
const LANE_PRODUCTS = 400;
const LANE_THREADS = 4;

async function verifyLanesStandDown(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;
  const slowMs = Number.parseInt(process.env.GOP_SLOW_BATCH_MS ?? "60000", 10);

  console.log(`\nLanes — a site answering slower than ${slowMs}ms per batch\n`);

  const job = await stageAtFlaky(ownerId, "slow", {
    products: LANE_PRODUCTS,
    threads: LANE_THREADS,
  });

  const done = await waitForStatus(job.id, (state) => isTerminal(state.status), 180);

  check(
    "the run completed",
    done?.status === "completed",
    `status=${done?.status}`,
  );
  check(
    "and EVERY product still landed — backing off must not lose work",
    done?.succeeded === LANE_PRODUCTS && done?.failed === 0,
    `succeeded=${done?.succeeded} failed=${done?.failed} of ${LANE_PRODUCTS}`,
  );

  const log = await getJobLogs(job.id, { limit: 3000 });
  const reductions = log.filter((line) => /standing one lane down/.test(line.message));
  const stoodDown = log.filter((line) => /Lane stood down/.test(line.message));

  check(
    "it noticed the site was slow and reduced the lane allowance",
    reductions.length > 0,
    log.filter((line) => line.stage === "run").map((line) => line.message).join(" | ").slice(0, 500),
  );
  check(
    "the reduction says WHAT it measured, not merely that it happened",
    reductions.some((line) => /ms/.test(line.message) && new RegExp(`${slowMs}`).test(line.message)),
    reductions.map((line) => line.message).join(" | ").slice(0, 500),
  );
  check(
    "and lanes actually left, at a batch boundary",
    stoodDown.length > 0,
    stoodDown.map((line) => line.message).join(" | ").slice(0, 400),
  );
  check(
    `it never went below one lane — at most ${LANE_THREADS - 1} of ${LANE_THREADS} could leave`,
    stoodDown.length <= LANE_THREADS - 1 && reductions.length <= LANE_THREADS - 1,
    `reductions=${reductions.length} stoodDown=${stoodDown.length}`,
  );

  const requests = await siteRequests("slow");
  check(
    "the site was sent all 8 batches regardless of how many lanes carried them",
    requests === LANE_PRODUCTS / BATCH_SIZE,
    `requests=${requests}, expected ${LANE_PRODUCTS / BATCH_SIZE}`,
  );

  return finish();
}

/**
 * The control, and the reason the rule can be trusted: a site that answers at once
 * keeps every lane it was given.
 */
async function verifyLanesSteady(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;

  console.log("\nLanes — a site that answers at once keeps every lane\n");

  const job = await stageAtFlaky(ownerId, "fast", {
    products: LANE_PRODUCTS,
    threads: LANE_THREADS,
  });

  const done = await waitForStatus(job.id, (state) => isTerminal(state.status), 120);

  check("the run completed", done?.status === "completed", `status=${done?.status}`);
  check(
    "every product landed",
    done?.succeeded === LANE_PRODUCTS && done?.failed === 0,
    `succeeded=${done?.succeeded} failed=${done?.failed}`,
  );

  const log = await getJobLogs(job.id, { limit: 3000 });

  check(
    "NO lane stood down — the same threshold that backed off a slow site leaves this one alone",
    !log.some((line) => /standing one lane down|Lane stood down/.test(line.message)),
    log
      .filter((line) => /lane/i.test(line.message))
      .map((line) => line.message)
      .join(" | ")
      .slice(0, 500),
  );

  return finish();
}

/* ----------------------------------------------------------------- notify */

/**
 * §6 C3 — being TOLD a run has finished, instead of watching for it.
 *
 * Asserted from the RECEIVER's side, which is the only side that proves anything:
 * the signature is checked against the bytes that actually arrived, using the same
 * `verifySignature` this codebase already ships for inbound webhooks. "We signed
 * it" and "a receiver can verify it" are different claims, and only the second one
 * is worth making.
 *
 * Three behaviours, and the middle one is the reason the switch exists:
 *
 *  - a run that finishes sends one delivery, signed, with the final numbers;
 *  - with "only when something went wrong" ON, a clean run sends NOTHING and a run
 *    with failures still does;
 *  - a receiver that answers 500 does not take the run down with it.
 */

interface Delivery {
  path: string;
  body: string;
  headers: Record<string, string>;
}

async function deliveries(): Promise<Delivery[]> {
  const response = await fetch(`${process.env.RECEIVER_URL!}/_deliveries`);
  return (await response.json()) as Delivery[];
}

async function resetDeliveries(): Promise<void> {
  await fetch(`${process.env.RECEIVER_URL!}/_reset`, { method: "POST" });
}

/** Wait for a delivery rather than assuming one has landed by now. */
async function untilDelivered(count: number, seconds: number): Promise<Delivery[]> {
  for (let attempt = 0; attempt < seconds * 2; attempt++) {
    const seen = await deliveries();

    if (seen.length >= count) {
      return seen;
    }

    await sleep(500);
  }

  return deliveries();
}

async function verifyNotify(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;
  const secret = "webhook-secret-never-logged";

  console.log("\nNotify — the run says it has finished, and the receiver can prove it\n");

  await resetDeliveries();
  await saveWebhook(ownerId, {
    url: `${process.env.RECEIVER_URL!}/hook`,
    secret,
    failuresOnly: false,
  });

  const stored = await getWebhookPublic(ownerId);
  check(
    "the stored webhook says a secret is set without saying what it is",
    stored.secretConfigured && !JSON.stringify(stored).includes(secret),
    JSON.stringify(stored),
  );

  const job = await stageAtFlaky(ownerId, "fast", { products: 100, threads: 2 });
  const done = await waitForStatus(job.id, (state) => isTerminal(state.status), 90);

  check("the run completed", done?.status === "completed", `status=${done?.status}`);

  const sent = await untilDelivered(1, 30);

  check("exactly one delivery arrived", sent.length === 1, `deliveries=${sent.length}`);

  if (sent.length === 0) {
    return finish();
  }

  const [delivery] = sent;
  const payload = JSON.parse(delivery.body) as {
    event?: string;
    text?: string;
    run?: Record<string, unknown>;
  };

  check(
    "it names the event in a header as well as in the body",
    delivery.headers["X-TSD-Event"] === "run.finished" && payload.event === "run.finished",
    JSON.stringify(delivery.headers),
  );
  check(
    "it carries the run's FINAL numbers, read after the run was finished",
    payload.run?.status === "completed" &&
      payload.run?.succeeded === 100 &&
      payload.run?.failed === 0 &&
      payload.run?.id === job.id,
    JSON.stringify(payload.run).slice(0, 300),
  );
  check(
    "and a one-line summary, so a Slack-shaped receiver needs no translator",
    typeof payload.text === "string" && /finished/.test(payload.text),
    String(payload.text),
  );

  /*
   * The assertion that can only be made out here: the signature verifies against
   * the bytes that ARRIVED, with the app's own verifier.
   */
  const timestamp = delivery.headers["X-TSD-Timestamp"] ?? "";
  const signature = delivery.headers["X-TSD-Signature"] ?? "";

  check(
    "the receiver can verify the signature over exactly the bytes it received",
    verifySignature(secret, "POST", "/hook", timestamp, delivery.body, signature),
    `timestamp=${timestamp} signature=${signature.slice(0, 16)}…`,
  );
  check(
    "and a WRONG secret does not verify — the check above is not vacuous",
    !verifySignature("not-the-secret", "POST", "/hook", timestamp, delivery.body, signature),
  );

  const log = await getJobLogs(job.id, { limit: 2000 });

  check(
    "the run's log records that the webhook was told",
    log.some((line) => line.stage === "notify" && /finished/.test(line.message)),
    log.filter((line) => line.stage === "notify").map((line) => line.message).join(" | "),
  );
  check(
    "and the log does NOT contain the webhook URL or its secret — a hook URL is itself a token",
    !log.some(
      (line) =>
        line.message.includes(secret) || line.message.includes(process.env.RECEIVER_URL!),
    ),
    log.filter((line) => line.stage === "notify").map((line) => line.message).join(" | "),
  );

  return finish();
}

/**
 * "Only when something went wrong", which is the switch's whole meaning: silence
 * has to mean something, and a clean run has to be the only thing it means.
 */
async function verifyNotifyFailuresOnly(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;

  console.log("\nNotify — with \"only when something went wrong\" on\n");

  await resetDeliveries();
  await saveWebhook(ownerId, {
    url: `${process.env.RECEIVER_URL!}/hook`,
    secret: "webhook-secret-never-logged",
    failuresOnly: true,
  });

  /* ---- a clean run says nothing ---- */

  const clean = await stageAtFlaky(ownerId, "fast", { products: 50, threads: 1 });
  const cleanDone = await waitForStatus(clean.id, (state) => isTerminal(state.status), 90);

  check(
    "the clean run completed with nothing failed",
    cleanDone?.status === "completed" && cleanDone?.failed === 0,
    `status=${cleanDone?.status} failed=${cleanDone?.failed}`,
  );

  // Long enough that a delivery would have landed if one were coming: the run has
  // already finished, and the notification is sent before the worker moves on.
  await sleep(4000);

  check(
    "no delivery arrived for it — that is what the switch is FOR",
    (await deliveries()).length === 0,
    JSON.stringify(await deliveries()).slice(0, 300),
  );

  /* ---- a run with failures still speaks ---- */

  const bad = await stageAtFlaky(ownerId, "always-timeout", { products: 50, threads: 1 });
  const badDone = await waitForStatus(bad.id, (state) => isTerminal(state.status), 150);

  check(
    "the failing run finished with failures recorded",
    (badDone?.failed ?? 0) > 0,
    `status=${badDone?.status} failed=${badDone?.failed}`,
  );

  const sent = await untilDelivered(1, 30);

  check("and THAT one was delivered", sent.length === 1, `deliveries=${sent.length}`);

  if (sent.length > 0) {
    const payload = JSON.parse(sent[0].body) as { run?: Record<string, unknown> };

    check(
      "with the failure count and the run's own error text in it",
      (payload.run?.failed as number) > 0 && payload.run?.id === bad.id,
      JSON.stringify(payload.run).slice(0, 300),
    );
  }

  /* ---- a receiver that is down does not take the run with it ---- */

  await resetDeliveries();
  await saveWebhook(ownerId, {
    url: `${process.env.RECEIVER_URL!}/broken`,
    secret: "",
    failuresOnly: false,
  });

  const survives = await stageAtFlaky(ownerId, "fast", { products: 50, threads: 1 });
  const survived = await waitForStatus(survives.id, (state) => isTerminal(state.status), 90);

  check(
    "a run whose receiver answers HTTP 500 still completes, with its products",
    survived?.status === "completed" && survived?.succeeded === 50,
    `status=${survived?.status} succeeded=${survived?.succeeded}`,
  );

  const attempted = await untilDelivered(1, 20);

  check("the delivery was attempted", attempted.length === 1, `deliveries=${attempted.length}`);
  check(
    "and the run's log says the receiver refused it, and that it was not sent again",
    (await getJobLogs(survives.id, { limit: 2000 })).some(
      (line) =>
        line.stage === "notify" && line.level === "warn" && /not sent again/.test(line.message),
    ),
    (await getJobLogs(survives.id, { limit: 2000 }))
      .filter((line) => line.stage === "notify")
      .map((line) => line.message)
      .join(" | "),
  );

  // Left OFF for whatever runs after this phase, so a later phase cannot be
  // confused by deliveries it never asked for.
  await saveWebhook(ownerId, { url: "", secret: "", failuresOnly: false });

  return finish();
}

/* --------------------------------------------------------------- schedules */

/**
 * §6 C2 — a run that happens again.
 *
 * The claim being tested is not "it fired twice". It is that a REPEAT does not
 * bend the run model: each occurrence is an ordinary run, `JobStatus` still has its
 * original five members, "scheduled" is still derived from `scheduled_for`, and the
 * guard that stops a redelivered job re-publishing a catalogue still holds.
 *
 * So the assertions are mostly about what must NOT happen:
 *
 *  - the series must not depend on the previous occurrence's rows, or deleting last
 *    night's run breaks tonight's;
 *  - a redelivered occurrence must not create a second pending one;
 *  - a worker that was down must not come back and fire a week of missed nightly
 *    syncs in a burst;
 *  - pausing must stop it without throwing the payload away.
 */

/** Fast enough to watch, and the floor the library enforces anyway. */
const REPEAT_MINUTES = 60;

async function verifyRepeat(): Promise<void> {
  const ownerId = process.env.ACCOUNT_ALICE!;

  console.log("\nRepeat — each occurrence is an ordinary run, and the series survives\n");

  /* ---- the pure part first: what "next" means ---- */

  const due = new Date("2026-08-18T02:00:00.000Z");

  check(
    "the next occurrence is counted from the previous DUE time, so 02:00 stays 02:00",
    nextOccurrenceAt(due, 1440, new Date("2026-08-18T02:41:00.000Z")).toISOString() ===
      "2026-08-19T02:00:00.000Z",
    nextOccurrenceAt(due, 1440, new Date("2026-08-18T02:41:00.000Z")).toISOString(),
  );
  check(
    "a week of missed occurrences is SKIPPED, not queued up as a burst",
    nextOccurrenceAt(due, 1440, new Date("2026-08-25T09:00:00.000Z")).toISOString() ===
      "2026-08-26T02:00:00.000Z",
    nextOccurrenceAt(due, 1440, new Date("2026-08-25T09:00:00.000Z")).toISOString(),
  );

  /* ---- the series itself ---- */

  const url = `${process.env.FLAKY_URL!}/fast`;
  const store = await createStore(ownerId, {
    url,
    pin: "",
    apiKey: "repeatkey01234567",
    apiSecret: "cancel-secret-never-logged",
    urlRewrite: false,
    baseUrlOverride: url,
    label: "the flaky site (repeat)",
  });

  const options = { ...DEFAULT_IMPORT_OPTIONS, storeId: store.id, threads: 1, batchSize: BATCH_SIZE };

  const raw: Product[] = Array.from({ length: 20 }, (_ignored, index) => ({
    name: `Repeat ${index + 1}`,
    slug: `repeat-${index + 1}`,
    sku: `REPEAT-${index + 1}`,
    price: "10000",
    instock: true,
  }));

  const { schedule, first } = await createSchedule({
    createdBy: ownerId,
    storeId: store.id,
    storeUrl: url,
    storeLabel: "the flaky site (repeat)",
    sourceLabel: "repeat-fixture.csv",
    options,
    items: applyOptions(raw, options, { sourceId: "repeat" }),
    everyMinutes: REPEAT_MINUTES,
    // Due now, so the first occurrence runs while the test is watching.
    firstRunAt: new Date(),
  });

  check(
    "the series names the pending occurrence, and it is the run that was created",
    schedule.nextJobId === first.id,
    `nextJobId=${schedule.nextJobId} first=${first.id}`,
  );
  check(
    "the first occurrence is an ORDINARY run: kind import, queued, with a due time",
    first.kind === "import" && first.status === "queued" && first.scheduledFor !== null,
    `kind=${first.kind} status=${first.status} scheduledFor=${first.scheduledFor}`,
  );
  check(
    "and it carries its own staged payload, all 20 items",
    first.total === 20,
    `total=${first.total}`,
  );

  const ran = await waitForStatus(first.id, (state) => isTerminal(state.status), 90);

  check(
    "it ran and completed like any other run",
    ran?.status === "completed" && ran?.succeeded === 20,
    `status=${ran?.status} succeeded=${ran?.succeeded}`,
  );

  /* ---- firing one occurrence must leave the next one waiting ---- */

  const advanced = await getSchedule(schedule.id);

  check(
    "the series moved on to a NEW pending occurrence",
    advanced !== null && advanced.nextJobId !== null && advanced.nextJobId !== first.id,
    `nextJobId=${advanced?.nextJobId}`,
  );
  check(
    "and recorded when it last fired",
    advanced?.lastFiredAt !== null,
    `lastFiredAt=${advanced?.lastFiredAt}`,
  );

  const second = advanced?.nextJobId === undefined ? null : await getJobState(advanced.nextJobId!);

  check(
    "the next occurrence is due one interval after the FIRST one, not one hour from now",
    second?.scheduledFor !== null &&
      new Date(second!.scheduledFor!).getTime() ===
        new Date(first.scheduledFor!).getTime() + REPEAT_MINUTES * 60_000,
    `first=${first.scheduledFor} second=${second?.scheduledFor}`,
  );
  check(
    "it shows as SCHEDULED rather than as a sixth status — the enum is untouched",
    second !== null && isScheduled(second) && second.status === "queued",
    `status=${second?.status} scheduled=${second === null ? "?" : isScheduled(second)}`,
  );
  check(
    "and it has its OWN copy of the payload",
    second?.total === 20,
    `total=${second?.total}`,
  );

  /* ---- the series must not depend on the run that already happened ---- */

  /*
   * The previous occurrence's staged payload is taken away, which is what
   * retention does to it eventually. If the series had copied tonight's products
   * from last night's run, this is where tonight would quietly become empty.
   */
  await db.delete(jobItems).where(eq(jobItems.jobId, first.id));

  const afterPrune = await getSchedule(schedule.id);
  const survivor = afterPrune?.nextJobId == null ? null : await getJobState(afterPrune.nextJobId);

  check(
    "losing last night's staged payload leaves tonight's occurrence with all of its own",
    survivor !== null && survivor.total === 20,
    `nextJobId=${afterPrune?.nextJobId} total=${survivor?.total}`,
  );
  check(
    "and the series still holds its own copy, independently of any run",
    afterPrune?.total === 20,
    `total=${afterPrune?.total}`,
  );

  /* ---- a redelivered occurrence must not double the series ---- */

  const pendingBefore = afterPrune?.nextJobId ?? "";

  await advanceSchedule(schedule.id, "a-job-id-that-is-not-the-pending-one");

  const unchanged = await getSchedule(schedule.id);

  check(
    "advancing on a run that is NOT the pending occurrence changes nothing",
    unchanged?.nextJobId === pendingBefore,
    `before=${pendingBefore} after=${unchanged?.nextJobId}`,
  );

  /* ---- pausing keeps the series and stops it firing ---- */

  await setSchedulePaused(schedule.id, true);

  const paused = await getSchedule(schedule.id);

  check("pausing is recorded on the series", paused?.paused === true, `paused=${paused?.paused}`);
  check(
    "the pending occurrence is dropped, so nothing fires while it is paused",
    paused?.nextJobId === null,
    `nextJobId=${paused?.nextJobId}`,
  );
  check(
    "and its RUN is really gone, not merely unpointed-at — an orphan would still fire",
    (await getJobState(pendingBefore)) === null,
    `jobId=${pendingBefore} still exists with status ${(await getJobState(pendingBefore))?.status}`,
  );
  check(
    "but the payload is still there, so resuming needs no file read",
    paused?.total === 20,
    `total=${paused?.total}`,
  );

  const resumed = await setSchedulePaused(schedule.id, false);
  const revived = resumed?.nextJobId == null ? null : await getJobState(resumed.nextJobId);

  check(
    "resuming stages a fresh occurrence with the payload, due in the future",
    revived !== null &&
      revived.total === 20 &&
      new Date(revived.scheduledFor!).getTime() > Date.now(),
    `nextJobId=${resumed?.nextJobId} total=${revived?.total} due=${revived?.scheduledFor}`,
  );

  /* ---- deleting the series stops it, and keeps what already happened ---- */

  const pendingAtDelete = (await getSchedule(schedule.id))?.nextJobId ?? "";

  await deleteSchedule(schedule.id);

  check("the series is gone", (await getSchedule(schedule.id)) === null);
  check(
    "the occurrence it had waiting is gone too — a deleted series must not fire tonight",
    (await getJobState(pendingAtDelete)) === null,
    `jobId=${pendingAtDelete} still exists`,
  );
  check(
    "but the run that already RAN is untouched: deleting a series is not deleting history",
    (await getJobState(first.id))?.status === "completed",
    `first=${(await getJobState(first.id))?.status}`,
  );
  check(
    "and that run no longer points at a series that does not exist",
    (await getJobState(first.id))?.scheduleId === null,
    `scheduleId=${(await getJobState(first.id))?.scheduleId}`,
  );

  return finish();
}

/* ------------------------------------------------------------------ shared */

/**
 * Wait until the worker has the run and every lane is genuinely stuck.
 *
 * "Genuinely" matters: if a batch had completed, the site would not be the
 * never-answering one this suite needs, and every assertion after it would be
 * measuring something else.
 */
async function untilWedged(jobId: string): Promise<JobState | null> {
  const running = await waitForStatus(jobId, (state) => state.status === "running", 60);

  check(
    "the worker picked the run up and marked it running",
    running?.status === "running",
    `status=${running?.status}`,
  );

  if (running?.status !== "running") {
    return null;
  }

  // Let every lane get its request out and wedge.
  await sleep(4000);

  const wedged = await getJobState(jobId);

  check(
    "no batch has completed — every lane is genuinely wedged, not merely slow",
    wedged?.processed === 0 && wedged?.batchesDone === 0,
    `processed=${wedged?.processed} batchesDone=${wedged?.batchesDone}`,
  );

  return wedged;
}

/**
 * Wait for a particular LINE, rather than for a status.
 *
 * The retry phases need to act at a moment no status describes — a lane inside a
 * backoff is still `running` — and the log is what makes that moment observable
 * from outside the worker. Polled twice a second so a Stop can be pressed while
 * the backoff still has most of itself left to run.
 */
async function untilLogged(jobId: string, pattern: RegExp, seconds: number): Promise<boolean> {
  for (let attempt = 0; attempt < seconds * 2; attempt++) {
    const lines = await getJobLogs(jobId, { limit: 2000 });

    if (lines.some((line) => pattern.test(line.message))) {
      return true;
    }

    await sleep(500);
  }

  return false;
}

async function waitForStatus(
  jobId: string,
  done: (state: JobState) => boolean,
  seconds: number,
): Promise<JobState | null> {
  for (let attempt = 0; attempt < seconds; attempt++) {
    const state = await getJobState(jobId);
    if (state !== null && done(state)) {
      return state;
    }
    await sleep(1000);
  }
  return getJobState(jobId);
}

async function finish(): Promise<void> {
  console.log(`\n${"-".repeat(50)}\nPassed: ${passed}   Failed: ${failed}`);

  await importQueue.close();
  await redis.quit();
  await closeDatabase().catch(() => undefined);

  process.exit(failed === 0 ? 0 : 1);
}

const PHASES: Record<string, () => Promise<void>> = {
  seed,
  cancel: verifyCancel,
  redeliver: verifyRedelivery,
  stop: verifyStop,
  arm: armResurrection,
  schedule: verifySchedule,
  resurrect: verifyResurrect,
  remove: verifyRemove,
  editstop: verifyEditStop,
  retrysucceeds: verifyRetrySucceeds,
  retryexhausted: verifyRetryExhausted,
  retrynever: verifyRetryNever,
  retrystop: verifyRetryStop,
  lanesdown: verifyLanesStandDown,
  lanessteady: verifyLanesSteady,
  notify: verifyNotify,
  telegram: verifyTelegram,
  notifyfailures: verifyNotifyFailuresOnly,
  repeat: verifyRepeat,
};

const PHASE = process.argv[2] ?? "";
const run = PHASES[PHASE];

if (run === undefined) {
  console.error(`Unknown phase "${PHASE}". One of: ${Object.keys(PHASES).join(", ")}`);
  process.exit(1);
}

void run();
