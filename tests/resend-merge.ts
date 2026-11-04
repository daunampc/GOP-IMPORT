/**
 * A resend folds back into the run it came from.
 *
 * Run through tests/resend-merge.sh, against a real Postgres: the merge is SQL
 * (counters moved with arithmetic, a log copied with INSERT … SELECT, a delete that
 * cascades), and a fake of it would test the fake.
 */

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { jobLogs, jobResults, jobs, users } from "../db/schema";
import {
  getJobState,
  listJobsRetryingFrom,
  mergeRetryIntoParent,
  retryIndexesOf,
  withRetryIndexes,
} from "../lib/jobs";

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

const OWNER = "user-merge-test";

async function makeRun(
  id: string,
  extra: Partial<typeof jobs.$inferInsert>,
): Promise<void> {
  await db.insert(jobs).values({
    id,
    kind: "import",
    storeUrl: "https://shop.example",
    storeLabel: "shop.example",
    createdBy: OWNER,
    sourceLabel: `run ${id}`,
    status: "completed",
    options: {},
    ...extra,
  });
}

async function rows(
  jobId: string,
  results: Array<{ index: number; ok: boolean; code?: string; dedup?: boolean }>,
): Promise<void> {
  await db.insert(jobResults).values(
    results.map((row) => ({
      jobId,
      index: row.index,
      ok: row.ok,
      deduplicated: row.dedup ?? false,
      errorCode: row.ok ? null : (row.code ?? "boom"),
      errorMessage: row.ok ? null : `message ${row.code ?? "boom"}`,
    })),
  );
}

const resultOf = async (jobId: string, index: number) =>
  (
    await db
      .select()
      .from(jobResults)
      .where(and(eq(jobResults.jobId, jobId), eq(jobResults.index, index)))
  )[0];

async function main(): Promise<void> {
  await db.insert(users).values({ id: OWNER, name: "Merge", email: "merge@example.test" });

  console.log("\nThe mapping");

  check("a resend's options carry which rows it sends", JSON.stringify(retryIndexesOf(withRetryIndexes({}, [2, 5]))) === "[2,5]");
  check("a run that is not a resend has none", retryIndexesOf({}) === null && retryIndexesOf({ retryIndexes: "x" }) === null);

  console.log("\nA finished resend");

  // Original: 5 rows, 0 and 1 fine, 2 3 4 failing.
  await makeRun("parent", { total: 5, processed: 5, succeeded: 2, failed: 3, deduplicated: 0 });
  await rows("parent", [
    { index: 0, ok: true },
    { index: 1, ok: true },
    { index: 2, ok: false, code: "old" },
    { index: 3, ok: false, code: "old" },
    { index: 4, ok: false, code: "old" },
  ]);

  // Its resend: rows 2,3,4 — the first and third fixed (the third was already there),
  // the second still failing, differently.
  await makeRun("child", {
    retryOf: "parent",
    total: 3,
    processed: 3,
    succeeded: 2,
    failed: 1,
    options: withRetryIndexes({}, [2, 3, 4]),
  });
  await rows("child", [
    { index: 0, ok: true },
    { index: 1, ok: false, code: "still" },
    { index: 2, ok: true, dedup: true },
  ]);
  await db.insert(jobLogs).values([
    { jobId: "child", stage: "run", message: "child began" },
    { jobId: "child", stage: "batch", message: "child batch" },
  ]);

  check("it is listed as a resend of its original", (await listJobsRetryingFrom("parent")).map((j) => j.id).join() === "child");

  const outcome = await mergeRetryIntoParent("child");

  check("merges", outcome.merged === true && outcome.recovered === 2 && outcome.stillFailed === 1, JSON.stringify(outcome));

  const parent = await getJobState("parent");
  check("the original's counters follow: 2 more ok, 2 fewer failed", parent?.succeeded === 4 && parent?.failed === 1, `${parent?.succeeded}/${parent?.failed}`);
  check("and the one already present is counted as such", parent?.deduplicated === 1, `${parent?.deduplicated}`);
  check("processed is not counted twice", parent?.processed === 5);

  check("row 2 is now fine", (await resultOf("parent", 2))?.ok === true);
  check("row 3 is still failing, with the NEW reason", (await resultOf("parent", 3))?.ok === false && (await resultOf("parent", 3))?.errorCode === "still");
  check("row 4 is fine and marked already present", (await resultOf("parent", 4))?.ok === true && (await resultOf("parent", 4))?.deduplicated === true);
  check("rows that were never resent are untouched", (await resultOf("parent", 0))?.ok === true && (await resultOf("parent", 1))?.ok === true);

  check("the resend no longer exists as a run of its own", (await getJobState("child")) === null);
  check("so nothing is left to resend by mistake", (await listJobsRetryingFrom("parent")).length === 0);
  check("its results went with it", (await db.select().from(jobResults).where(eq(jobResults.jobId, "child"))).length === 0);

  const logs = await db.select().from(jobLogs).where(eq(jobLogs.jobId, "parent"));
  check(
    "its log was kept inside the original, marked as a resend",
    logs.some((l) => l.message === "[resend] child began") && logs.some((l) => l.message === "[resend] child batch"),
  );
  check("with a summary line", logs.some((l) => /Resend of 3 failed row\(s\) finished \(completed\): 2 fixed, 1 still failing/.test(l.message)), logs.map((l) => l.message).join(" | "));

  console.log("\nA resend that stopped halfway");

  await makeRun("p2", { total: 4, processed: 4, succeeded: 1, failed: 3 });
  await rows("p2", [
    { index: 0, ok: true },
    { index: 1, ok: false },
    { index: 2, ok: false },
    { index: 3, ok: false },
  ]);
  await makeRun("c2", {
    retryOf: "p2",
    status: "cancelled",
    total: 3,
    processed: 1,
    succeeded: 1,
    failed: 0,
    options: withRetryIndexes({}, [1, 2, 3]),
  });
  await rows("c2", [{ index: 0, ok: true }]);

  const half = await mergeRetryIntoParent("c2");
  const p2 = await getJobState("p2");

  check("only what it reached is written", half.merged === true && half.recovered === 1);
  check("the rest keep failing in the original, where Resend can find them", p2?.succeeded === 2 && p2?.failed === 2 && (await resultOf("p2", 2))?.ok === false && (await resultOf("p2", 3))?.ok === false);

  console.log("\nA resend that must NOT be merged");

  await makeRun("p3", { total: 2, processed: 2, succeeded: 0, failed: 2 });
  await rows("p3", [{ index: 0, ok: false }, { index: 1, ok: false }]);

  await makeRun("c3", { retryOf: "p3", status: "running", options: withRetryIndexes({}, [0, 1]) });
  check("one that is still running is left alone", (await mergeRetryIntoParent("c3")).merged === false && (await getJobState("c3")) !== null);

  await makeRun("c4", { retryOf: "p3", status: "completed", options: {} });
  const legacy = await mergeRetryIntoParent("c4");
  check("one from before row mapping existed is left visible", legacy.merged === false && (await getJobState("c4")) !== null, JSON.stringify(legacy));

  check("a run that is not a resend is not touched", (await mergeRetryIntoParent("p3")).merged === false && (await getJobState("p3")) !== null);

  console.log(`\n${"-".repeat(50)}\nPassed: ${passed}   Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
