/**
 * End to end: the Next.js lib → the queue → the worker → the real PHP plugin →
 * a real MySQL.
 *
 * Proves three things a typecheck cannot:
 *
 *  1. The HMAC signature the TypeScript client builds is accepted by the PHP
 *     plugin — both sides assemble the signing string identically.
 *  2. A run survives the web process exiting: this script enqueues and then
 *     QUITS, and a different process picks the job up afterwards.
 *  3. A removal run takes the products back off the site, with the site itself
 *     asked for the final confirmation.
 *
 * Run through tests/e2e.sh, never directly.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { closeDatabase } from "../db";
import {
  createdProductIds,
  updatedProductIds,
  enqueueEdit,
  enqueueImport,
  getJobProducts,
  enqueuePurge,
  getJobState,
  getResults,
  importQueue,
} from "../lib/jobs";
import { getJobLogs } from "../lib/job-log";
import { describeEdit, resolveEdit, type EditOperation } from "../lib/edit-options";
import { DEFAULT_IMPORT_OPTIONS } from "../lib/import-options";
import { supportsImageUpload } from "../lib/plugin-version";
import { redis } from "../lib/redis";
import { getS3Credentials, saveS3 } from "../lib/settings";
import { clientFor, checkStore, createStore, listStores } from "../lib/stores";
import { applyOptions } from "../lib/transform";
import type { JobState } from "../lib/jobs";
import { GopApiError } from "../lib/gop-client";
import type { Product } from "../lib/gop-client";
import { makeAccount, type TestAccount } from "./accounts";

type Store = Awaited<ReturnType<typeof listStores>>[number];

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

const PHASE = process.argv[2];

async function seed(): Promise<void> {
  console.log("\nStage 1 — create the site and queue a run (standing in for the web process)\n");

  // Three accounts, because everything below is owned by one of them now. The
  // admin exists so the "administrator started it on a member's behalf" case in
  // stage 6 has an administrator to start it.
  const alice = await makeAccount("alice@e2e.test");
  const bob = await makeAccount("bob@e2e.test");
  const admin = await makeAccount("admin@e2e.test", "admin");

  console.log(`ACCOUNT_ALICE=${alice.id}`);
  console.log(`ACCOUNT_BOB=${bob.id}`);
  console.log(`ACCOUNT_ADMIN=${admin.id}`);

  // Alice's and the administrator's buckets are complete; Bob's is left
  // unconfigured in stage 6. That difference is what stage 6 leans on: if the
  // worker still read one global settings row, Bob's S3 run would quietly
  // succeed using somebody else's bucket.
  await saveS3(alice.id, {
    enabled: true,
    accessKeyId: "AKIAALICEE2EONLY",
    secretAccessKey: "alice-secret-never-logged",
    bucket: "bucket-alice",
    region: "ap-southeast-1",
    publicUrl: "",
    prefix: "",
  });

  await saveS3(admin.id, {
    enabled: true,
    accessKeyId: "AKIAADMINE2EONLY",
    secretAccessKey: "admin-secret-never-logged",
    bucket: "bucket-admin",
    region: "eu-west-1",
    publicUrl: "",
    prefix: "",
  });

  const store = await createStore(alice.id, {
    url: process.env.PLUGIN_URL!,
    pin: "",
    apiKey: process.env.PLUGIN_API_KEY!,
    apiSecret: process.env.PLUGIN_API_SECRET!,
    urlRewrite: false,
    // PHP's built-in server serves the plugin directory directly, without the
    // /wp-content/plugins/ prefix a real WordPress site has.
    baseUrlOverride: process.env.PLUGIN_URL!,
    label: "e2e",
  });

  const result = await checkStore(store);

  check(
    "the PHP plugin accepts the HMAC signature built by the TypeScript client",
    result.ok,
    result.message,
  );

  if (!result.ok) {
    process.exit(1);
  }

  const raw: Product[] = [
    {
      name: "Áo Thun E2E Một",
      slug: "ao-thun-e2e-mot",
      sku: "E2E-1",
      price: "150000",
      instock: true,
      categories: ["E2E > Áo"],
      images: ["https://cdn.test/e2e-1.jpg"],
    },
    {
      name: "Áo Hoodie E2E Hai",
      slug: "ao-hoodie-e2e-hai",
      sku: "E2E-2",
      instock: true,
      attributes: [{ name: "Size", values: ["S", "M"] }],
      variations: [
        { sku: "E2E-2-S", price: "200000", instock: true, attributes: [{ name: "Size", value: "S" }] },
        { sku: "E2E-2-M", price: "250000", instock: true, attributes: [{ name: "Size", value: "M" }] },
      ],
    },
    // No name — the plugin must reject this row alone, not the whole batch.
    { name: "", sku: "E2E-BAD" } as Product,
  ];

  const options = {
    ...DEFAULT_IMPORT_OPTIONS,
    storeId: store.id,
    // Flattening off, so the variable-product path is the one under test.
    flattenVariants: false,
    keepProductAttributes: true,
    threads: 2,
  };

  const products = applyOptions(raw, options, { sourceId: "e2e-fixture" });

  check("the transform gives every product an idempotency_key", products.every((p) => !!p.idempotency_key));
  check(
    "the slug gets a random suffix",
    products[0].slug !== "ao-thun-e2e-mot" && products[0].slug!.startsWith("ao-thun-e2e-mot-"),
    products[0].slug,
  );

  const job = await enqueueImport({
    storeId: store.id,
    storeUrl: process.env.PLUGIN_URL!,
    sourceLabel: "e2e-fixture.csv",
    options,
    products,
    createdBy: alice.id,
  });

  check("the run enters the queue as queued", job.status === "queued");

  console.log(`\nJOB_ID=${job.id}`);

  await importQueue.close();
  await redis.quit();

  // Exit for real: from here on the "web process" is gone.
  process.exit(failed === 0 ? 0 : 1);
}

async function verify(): Promise<void> {
  const jobId = process.env.JOB_ID!;

  console.log("\nStage 3 — read the results back (a NEW process, after the worker ran)\n");

  let state = await getJobState(jobId);

  // The worker runs in the background; wait for the run to finish.
  for (let attempt = 0; attempt < 60 && state && (state.status === "queued" || state.status === "running"); attempt++) {
    await sleep(1000);
    state = await getJobState(jobId);
  }

  check("the run still exists after the process that queued it exited", state !== null);

  if (state === null) {
    await redis.quit();
    process.exit(1);
  }

  check("the run completed", state.status === "completed", `status=${state.status} error=${state.error}`);
  check("all 3 products were processed", state.processed === 3, `processed=${state.processed}`);
  check("2 succeeded", state.succeeded === 2, `succeeded=${state.succeeded}`);
  check("1 failed (the row with no name)", state.failed === 1, `failed=${state.failed}`);

  const results = await getResults(jobId);

  check("there are 3 result rows", results.length === 3, `len=${results.length}`);
  const failedRow = results.find((result) => !result.ok);

  check(
    "the failed row reports the missing_name code",
    failedRow?.error?.code === "missing_name",
    JSON.stringify(failedRow?.error),
  );

  /*
   * The failure is recorded IN FULL, not summarised.
   *
   * The screen used to cut this with a CSS ellipsis, so the one useful part of a
   * message — the field name, the constraint, the value — was the part removed. The
   * column stores `text` with no length limit, and nothing in the path to it should
   * shorten the message either. Asserted here because "the operator can read the
   * error" is a property of the whole path, not of the CSS alone.
   */
  check(
    "and the message reaches the results table whole, not truncated",
    (failedRow?.error?.message ?? "").length > 0 &&
      !(failedRow?.error?.message ?? "").endsWith("…") &&
      !(failedRow?.error?.message ?? "").endsWith("..."),
    failedRow?.error?.message ?? "(no message)",
  );

  /* ---- the failures are kept as a list the operator can act on ---- */

  const failedIndexes = results.filter((result) => !result.ok).map((result) => result.index);

  check(
    "the failed rows are individually identifiable by their original row index",
    failedIndexes.length === 1 && failedIndexes[0] === 2,
    JSON.stringify(failedIndexes),
  );

  const products = await getJobProducts(jobId);

  check(
    "and each one maps back to the staged product, which is what makes a resend possible",
    failedIndexes.every((index) => products[index] !== undefined),
    `staged=${products.length} failedIndexes=${JSON.stringify(failedIndexes)}`,
  );
  check(
    "the variable product came back with 2 variations",
    (results.find((result) => result.sku === "E2E-2")?.variation_ids?.length ?? 0) === 2,
  );
  check(
    "row indexes preserve the order of the original array",
    results.map((result) => result.index).join(",") === "0,1,2",
    results.map((result) => result.index).join(","),
  );

  const alice = { id: state.createdBy, email: "alice@e2e.test", role: "member" as const };

  check("the run records the account that owns it", state.createdBy !== "", state.createdBy);

  const stores = await listStores(alice.id);
  check("the site survives a restart, and belongs to its account", stores.length === 1);
  check(
    "a different account sees none of it",
    (await listStores(`${alice.id}-not-a-real-account`)).length === 0,
  );

  await verifyPurge(jobId, stores[0], alice);
  await verifyWholeSelectionRemoval(stores[0], alice);
  await verifyWriteModes(stores[0], alice);
  await verifyBulkEdit(stores[0], alice);
  await verifyPerAccountS3(stores[0], alice);
  await verifyImageUpload(stores[0], alice);

  console.log(`\n${"-".repeat(50)}\nPassed: ${passed}   Failed: ${failed}`);

  await importQueue.close();
  await redis.quit();
  await closeDatabase().catch(() => undefined);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * Stage 4 — remove exactly the products the import just created.
 *
 * Runs on the same worker as stage 2, so it also tests that the worker branches
 * correctly on `job.kind`: one queue, one cancel mechanism, two code paths.
 *
 * The final proof does not come from this app's own database but from asking
 * the plugin again: after the removal, looking those ids up must return zero.
 */
async function verifyPurge(
  importJobId: string,
  store: Store,
  owner: TestAccount,
): Promise<void> {
  console.log("\nStage 4 — remove what was just created (same worker, different job.kind)\n");

  const ids = await createdProductIds(importJobId);
  check("the app remembers the product ids the import created", ids.length === 2, `ids=${ids}`);

  const client = await clientFor(store);

  const before = await client.lookupProducts({ product_ids: ids });
  check("the plugin\u2019s lookup finds exactly those products", before.total === ids.length, `total=${before.total}`);
  check(
    "the lookup returns names, SKUs and variation counts",
    before.products.every((product) => product.name !== "") &&
      before.products.some((product) => product.variation_count === 2),
    JSON.stringify(before.products.map((product) => [product.sku, product.variation_count])),
  );

  const purgeJob: JobState = await enqueuePurge({
    storeId: store.id,
    // Taken from the stored site rather than the environment: this stage is a
    // DIFFERENT process and has no PLUGIN_URL.
    storeUrl: store.url,
    sourceLabel: "e2e purge",
    options: {
      storeId: store.id,
      selection: { kind: "run", runId: importJobId },
      deleteImages: true,
      threads: 2,
      batchSize: 50,
    },
    products: before.products.map((product) => ({
      product_id: product.product_id,
      sku: product.sku,
      name: product.name,
    })),
    createdBy: owner.id,
  });

  check("the removal run is queued with kind=purge", purgeJob.kind === "purge");

  let state = await getJobState(purgeJob.id);
  for (
    let attempt = 0;
    attempt < 60 && state && (state.status === "queued" || state.status === "running");
    attempt++
  ) {
    await sleep(1000);
    state = await getJobState(purgeJob.id);
  }

  check(
    "the removal run completed",
    state?.status === "completed",
    `status=${state?.status} error=${state?.error}`,
  );
  check("every product was removed", state?.succeeded === ids.length, `succeeded=${state?.succeeded}`);

  const purgeResults = await getResults(purgeJob.id);

  check(
    "each row keeps the name of the product it removed",
    purgeResults.every((result) => (result.name ?? "") !== ""),
    JSON.stringify(purgeResults.map((result) => result.name)),
  );
  check(
    "each row reports rows removed per table",
    purgeResults.every((result) => (result.removed?.posts ?? 0) > 0),
    JSON.stringify(purgeResults.map((result) => result.removed)),
  );
  check(
    "the variable product took its variations with it (1 parent + 2 variations)",
    purgeResults.some((result) => (result.removed?.posts ?? 0) === 3),
    JSON.stringify(purgeResults.map((result) => result.removed?.posts)),
  );

  // The real proof: ask the site itself.
  const after = await client.lookupProducts({ product_ids: ids });
  check("nothing is left on the site", after.total === 0, `total=${after.total}`);
}

/**
 * Stage 5 — one removal run covers the WHOLE selection.
 *
 * The behaviour this replaces: a removal only ever took 500 products, because
 * the summary lookup caps at 500 and the run was built from what it returned.
 * "Every product on the site" against a 3000-product shop removed 500, showed a
 * warning, and reported success — so the test that matters is the one the old
 * code could not have passed: seed more than 500, select everything, run ONCE,
 * and ask the site whether anything is left.
 */
const WHOLE_SELECTION_COUNT = 620;

async function verifyWholeSelectionRemoval(store: Store, owner: TestAccount): Promise<void> {
  console.log(
    `\nStage 5 — seed ${WHOLE_SELECTION_COUNT} products, then remove every one of them in ONE run\n`,
  );

  const raw: Product[] = Array.from({ length: WHOLE_SELECTION_COUNT }, (_ignored, index) => ({
    name: `Bulk E2E ${index + 1}`,
    slug: `bulk-e2e-${index + 1}`,
    sku: `BULK-${index + 1}`,
    price: "10000",
    instock: true,
  }));

  const options = {
    ...DEFAULT_IMPORT_OPTIONS,
    storeId: store.id,
    threads: 4,
    batchSize: 50,
  };

  const importJob = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "bulk-fixture.csv",
    options,
    products: applyOptions(raw, options, { sourceId: "e2e-bulk" }),
    createdBy: owner.id,
  });

  const imported = await waitFor(importJob.id, 180);

  check(
    `all ${WHOLE_SELECTION_COUNT} products were created`,
    imported?.succeeded === WHOLE_SELECTION_COUNT,
    `succeeded=${imported?.succeeded} status=${imported?.status} error=${imported?.error}`,
  );

  const client = await clientFor(store);

  // The summary lookup still caps at 500 — that cap is real and stays. It is
  // what made the old removal cover 500 products.
  const page = await client.lookupProducts({ all: true, limit: 500 });
  check(
    "the summary lookup still returns at most one page",
    page.products.length === 500 && page.total >= WHOLE_SELECTION_COUNT,
    `shown=${page.products.length} total=${page.total}`,
  );

  // The ids-only mode is what removes the ceiling on what one run covers.
  const everything = await client.lookupProductIds({ all: true });
  check(
    "the ids-only lookup returns every matching id in one call",
    everything.ids.length === everything.total &&
      everything.ids.length >= WHOLE_SELECTION_COUNT &&
      !everything.truncated,
    `ids=${everything.ids.length} total=${everything.total} truncated=${everything.truncated}`,
  );

  const purgeJob = await enqueuePurge({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "e2e purge — every product on the site",
    createdBy: owner.id,
    options: {
      storeId: store.id,
      selection: { kind: "all", confirm: true },
      deleteImages: true,
      threads: 4,
      batchSize: 50,
    },
    // Detail for the page that would have been displayed; bare ids for the
    // rest — exactly what app/api/purge/route.ts stages.
    products: everything.ids.map((productId) => {
      const shown = page.products.find((product) => product.product_id === productId);
      return {
        product_id: productId,
        sku: shown?.sku ?? "",
        name: shown?.name ?? "",
      };
    }),
  });

  check(
    "the run is staged with EVERY matched product, not one page of them",
    purgeJob.total === everything.total,
    `staged=${purgeJob.total} matched=${everything.total}`,
  );

  const purged = await waitFor(purgeJob.id, 300);

  check(
    "the removal run completed",
    purged?.status === "completed",
    `status=${purged?.status} error=${purged?.error}`,
  );

  // The proof does not come from this app's own counters but from asking the
  // site. The previous behaviour would have left ~120 products behind here
  // while reporting success.
  const after = await client.lookupProducts({ all: true, limit: 1 });
  check("the site has nothing left", after.total === 0, `still on the site: ${after.total}`);
}

/**
 * Stage 5b — the three write modes, over HTTP, against the real plugin.
 *
 * The claim under test is the one §2.4 exists for and the one that cannot be
 * checked by reading code: "Update only" creates NOTHING. So the assertion is not
 * about counters this app keeps — it asks the SITE how many products it holds,
 * before and after, and requires the number not to have moved.
 *
 * Runs on an empty site (stage 5 removed everything), so every count below is
 * about rows this stage created.
 */
async function verifyWriteModes(store: Store, owner: TestAccount): Promise<void> {
  console.log("\nStage 5b — skip / create-or-update / update-only, against the real plugin\n");

  const client = await clientFor(store);

  const EXISTING = 6;
  const NEW = 6;

  const row = (index: number, price: string): Product => ({
    name: `Write Mode ${index}`,
    sku: `WM-${index}`,
    price,
    regular_price: price,
    instock: true,
    description: `<p>Description of Write Mode ${index}</p>`,
    categories: ["Write Mode Cat"],
  });

  /* ---------------------------------------------- half of them are created */

  const firstHalf = Array.from({ length: EXISTING }, (_ignored, index) => row(index + 1, "100000"));

  const createOptions = { ...DEFAULT_IMPORT_OPTIONS, storeId: store.id, threads: 2, batchSize: 50 };

  const seedJob = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "write-modes-seed.csv",
    options: createOptions,
    products: applyOptions(firstHalf, createOptions, { sourceId: "e2e-wm-seed" }),
    createdBy: owner.id,
  });

  const seeded = await waitFor(seedJob.id, 120);
  check(
    `${EXISTING} products were created to update later`,
    seeded?.succeeded === EXISTING,
    `succeeded=${seeded?.succeeded} error=${seeded?.error}`,
  );

  const afterSeed = await client.lookupProducts({ all: true, limit: 1 });
  check(
    `the site holds exactly ${EXISTING} products`,
    afterSeed.total === EXISTING,
    `total=${afterSeed.total}`,
  );

  /* ------------------------------------------ /products/exists, over HTTP */

  const existsAnswer = await client.productsExist([
    ...firstHalf.map((product) => product.sku!),
    "WM-DOES-NOT-EXIST-1",
    "WM-DOES-NOT-EXIST-2",
  ]);

  check(
    "/products/exists finds the ones that are there",
    existsAnswer.found.length === EXISTING,
    `found=${existsAnswer.found.length}`,
  );
  check(
    "/products/exists reports the ones that are not",
    existsAnswer.missing.length === 2 &&
      existsAnswer.missing.every((sku) => sku.startsWith("WM-DOES-NOT-EXIST")),
    `missing=${existsAnswer.missing.join(",")}`,
  );
  check(
    "/products/exists carries the current price, so a preview can show site → file",
    existsAnswer.found.every((entry) => entry.price === "100000"),
    existsAnswer.found.map((entry) => `${entry.sku}=${entry.price}`).join(" "),
  );

  /* ---------------------------------------------------------- update_only */

  // A file where HALF the rows are new — the fixture §5 asks for.
  const mixed = [
    ...Array.from({ length: EXISTING }, (_ignored, index) => row(index + 1, "150000")),
    ...Array.from({ length: NEW }, (_ignored, index) => row(EXISTING + index + 1, "150000")),
  ];

  const updateOnlyOptions = {
    ...DEFAULT_IMPORT_OPTIONS,
    storeId: store.id,
    writeMode: "update_only" as const,
    threads: 2,
    batchSize: 50,
  };

  const updateOnlyJob = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "write-modes-mixed.csv",
    options: updateOnlyOptions,
    products: applyOptions(mixed, updateOnlyOptions, { sourceId: "e2e-wm-mixed" }),
    createdBy: owner.id,
  });

  const updatedOnly = await waitFor(updateOnlyJob.id, 120);

  check(
    'in "Update only" the rows already on the site succeed',
    updatedOnly?.succeeded === EXISTING,
    `succeeded=${updatedOnly?.succeeded} error=${updatedOnly?.error}`,
  );
  check(
    'in "Update only" the new rows FAIL rather than being published',
    updatedOnly?.failed === NEW,
    `failed=${updatedOnly?.failed}`,
  );

  /*
   * THE assertion of this stage, and it is asked of the SITE.
   *
   * Not "the run reported no creates" — the run's own counters are exactly what
   * would lie if the mode were broken. The site's product count must be the number
   * it was before.
   */
  const afterUpdateOnly = await client.lookupProducts({ all: true, limit: 1 });
  check(
    '"Update only" created NOTHING — the site holds the same number of products',
    afterUpdateOnly.total === EXISTING,
    `before=${EXISTING} after=${afterUpdateOnly.total}`,
  );

  const updateResults = await getResults(updateOnlyJob.id);

  check(
    "every row of the update run is accounted for",
    updateResults.length === EXISTING + NEW,
    `rows=${updateResults.length}`,
  );

  const notOnSite = updateResults.filter((result) => result.error?.code === "not_on_site");
  check(
    "the failed rows say why, with a code that tells them apart from a site error",
    notOnSite.length === NEW,
    `not_on_site=${notOnSite.length} codes=${[
      ...new Set(updateResults.filter((r) => !r.ok).map((r) => r.error?.code)),
    ].join(",")}`,
  );

  /*
   * The old price is on record, per row.
   *
   * This is what makes the run its own audit trail: the site has overwritten the
   * old prices and nothing else in this app kept them, so if `changed` did not
   * carry `from` there would be no way to know what a 3,000-product reprice
   * replaced.
   */
  const priced = updateResults.filter((result) => result.ok && result.changed?.regular_price);

  check(
    "each updated row records the price it changed FROM and TO",
    priced.length === EXISTING &&
      priced.every(
        (result) =>
          result.changed?.regular_price?.from === "100000" &&
          result.changed?.regular_price?.to === "150000",
      ),
    priced
      .map((r) => `${r.sku}:${r.changed?.regular_price?.from}→${r.changed?.regular_price?.to}`)
      .join(" "),
  );

  check(
    "an update touched the price and NOT the description",
    priced.every((result) => result.changed?.description === undefined),
    priced
      .map((r) => `${r.sku}:${Object.keys(r.changed ?? {}).join("+")}`)
      .join(" "),
  );

  // And the site agrees, read back through the lookup the way WooCommerce would.
  const repriced = await client.lookupProducts({ skus: firstHalf.map((p) => p.sku!), limit: 50 });
  check(
    "the site itself shows the new price",
    repriced.products.length === EXISTING &&
      repriced.products.every((product) => product.price === "150000"),
    repriced.products.map((product) => `${product.sku}=${product.price}`).join(" "),
  );

  /* ------------------------------------------------------ create_or_update */

  const bothOptions = {
    ...DEFAULT_IMPORT_OPTIONS,
    storeId: store.id,
    writeMode: "create_or_update" as const,
    threads: 2,
    batchSize: 50,
  };

  const bothRows = [
    ...Array.from({ length: EXISTING }, (_ignored, index) => row(index + 1, "180000")),
    ...Array.from({ length: NEW }, (_ignored, index) => row(EXISTING + index + 1, "180000")),
  ];

  const bothJob = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "write-modes-both.csv",
    options: bothOptions,
    products: applyOptions(bothRows, bothOptions, { sourceId: "e2e-wm-both" }),
    createdBy: owner.id,
  });

  const both = await waitFor(bothJob.id, 120);

  check(
    '"Create or update" published every row',
    both?.succeeded === EXISTING + NEW && both?.failed === 0,
    `succeeded=${both?.succeeded} failed=${both?.failed} error=${both?.error}`,
  );

  const afterBoth = await client.lookupProducts({ all: true, limit: 1 });
  check(
    '"Create or update" created exactly the rows that were missing, and no more',
    afterBoth.total === EXISTING + NEW,
    `expected=${EXISTING + NEW} after=${afterBoth.total}`,
  );

  const bothResults = await getResults(bothJob.id);

  check(
    "the updated half records 150,000 → 180,000",
    bothResults.filter(
      (result) =>
        result.changed?.regular_price?.from === "150000" &&
        result.changed?.regular_price?.to === "180000",
    ).length === EXISTING,
    bothResults
      .filter((r) => r.changed)
      .map((r) => `${r.sku}:${r.changed?.regular_price?.from}→${r.changed?.regular_price?.to}`)
      .join(" "),
  );

  check(
    "row indexes survive a batch answered in two halves",
    bothResults.every((result, position) => result.index === position),
    bothResults.map((r) => r.index).join(","),
  );

  /* -------------------------------------------------- skip, still unchanged */

  /*
   * `createdProductIds` must NOT hand the removal screen products this run only
   * repriced.
   *
   * "Everything one import run created" is a destructive selection with a label
   * that promises something specific. In this run 6 rows were created and 6 were
   * updated in place, so the list has to be 6 — feeding it 12 would delete half a
   * customer's existing catalogue.
   */
  const createdByBoth = await createdProductIds(bothJob.id);
  const updatedByBoth = await updatedProductIds(bothJob.id);

  check(
    '"Everything this run created" counts only what it CREATED, not what it repriced',
    createdByBoth.length === NEW,
    `created=${createdByBoth.length} expected=${NEW}`,
  );
  check(
    "and the products it merely changed are recorded separately",
    updatedByBoth.length === EXISTING,
    `updated=${updatedByBoth.length} expected=${EXISTING}`,
  );
  check(
    "the two sets do not overlap",
    createdByBoth.every((id) => !updatedByBoth.includes(id)),
    `created=${createdByBoth.join(",")} updated=${updatedByBoth.join(",")}`,
  );

  /* -------------------------------------------------- skip, still unchanged */

  /*
   * The DEFAULT mode must behave exactly as it did before any of this existed.
   *
   * Re-running the SAME staged array rather than calling `applyOptions` again,
   * because `applyOptions` gives every row a fresh random slug suffix and the
   * idempotency key is derived from the slug — so a second read of the same file
   * has different keys and legitimately creates a second set of products. That is
   * long-standing documented behaviour ("the preview is a contract": one file read
   * is one set of keys), and the app never re-reads either, since Start points at
   * the stored preview. Reusing the array is what an actual resend does.
   */
  const skipStaged = applyOptions(
    Array.from({ length: EXISTING }, (_ignored, index) => row(index + 1, "999000")),
    { ...bothOptions, writeMode: "skip" as const },
    { sourceId: "e2e-wm-skip" },
  );

  const firstSkip = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "write-modes-skip.csv",
    options: { ...bothOptions, writeMode: "skip" as const },
    products: skipStaged,
    createdBy: owner.id,
  });

  await waitFor(firstSkip.id, 120);

  const secondSkip = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "write-modes-skip.csv",
    options: { ...bothOptions, writeMode: "skip" as const },
    products: skipStaged,
    createdBy: owner.id,
  });

  const skipped = await waitFor(secondSkip.id, 120);

  check(
    '"Skip" is unchanged: the same staged rows come back as already present',
    skipped?.deduplicated === EXISTING,
    `deduplicated=${skipped?.deduplicated} succeeded=${skipped?.succeeded}`,
  );

  /*
   * And the precise claim: "Skip" left the products that were already there
   * completely alone.
   *
   * The first skip run staged the same six SKUs at 999,000 with fresh idempotency
   * keys, so it CREATED six more products rather than repricing the six at 180,000
   * — which is exactly the old behaviour, and exactly the reason the update modes
   * had to be built. So the six originals must still read 180,000, alongside six
   * new ones at 999,000.
   */
  const unchanged = await client.lookupProducts({ skus: firstHalf.map((p) => p.sku!), limit: 50 });

  const atOldPrice = unchanged.products.filter((product) => product.price === "180000").length;
  const atNewPrice = unchanged.products.filter((product) => product.price === "999000").length;

  check(
    '"Skip" repriced nothing — the products already there still hold their old price',
    atOldPrice === EXISTING,
    `at 180000: ${atOldPrice} (expected ${EXISTING}) — ${unchanged.products
      .map((product) => `${product.sku}=${product.price}`)
      .join(" ")}`,
  );
  check(
    '"Skip" created a second product per SKU instead, which is what it has always done',
    atNewPrice === EXISTING,
    `at 999000: ${atNewPrice} (expected ${EXISTING})`,
  );

  /* --------------------------------------- /maintenance/recalculate-prices */

  const recalculated = await client.recalculatePrices();
  check(
    "/maintenance/recalculate-prices answers, so the app can reach what wp-admin could",
    recalculated.recalculated === true && typeof recalculated.products === "number",
    JSON.stringify(recalculated),
  );

  /* -------------------------------------------- clean up for later stages */

  const leftover = await client.lookupProductIds({ all: true });
  if (leftover.ids.length > 0) {
    await client.deleteProducts(leftover.ids, { deleteImages: true });
  }

  const emptied = await client.lookupProducts({ all: true, limit: 1 });
  check(
    "the site is left empty for the stages that follow",
    emptied.total === 0,
    `total=${emptied.total}`,
  );
}

/**
 * Stage 5c — a bulk price change is a RUN, and its results are the only record of
 * the old prices.
 *
 * §2.5's requirement, asserted the way it has to be: not "the route answered 202",
 * but that the change went through the same queue, worker and log as an import, that
 * the site holds the new numbers, and that each row records what it replaced. Once
 * the site is written, `job_result.changed` is the only place the old price exists —
 * nothing else in this app kept it and the site has overwritten it.
 */
async function verifyBulkEdit(store: Store, owner: TestAccount): Promise<void> {
  console.log("\nStage 5c — a bulk price change, as a run\n");

  const client = await clientFor(store);

  const COUNT = 8;

  const raw: Product[] = Array.from({ length: COUNT }, (_ignored, index) => ({
    name: `Bulk Edit ${index + 1}`,
    sku: `BE-${index + 1}`,
    price: "200000",
    regular_price: "200000",
    instock: true,
    description: `<p>Description ${index + 1}</p>`,
    categories: ["Bulk Edit Cat"],
  }));

  const importOptions = { ...DEFAULT_IMPORT_OPTIONS, storeId: store.id, threads: 2, batchSize: 50 };

  const seedJob = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "bulk-edit-seed.csv",
    options: importOptions,
    products: applyOptions(raw, importOptions, { sourceId: "e2e-bulk-edit" }),
    createdBy: owner.id,
  });

  const seeded = await waitFor(seedJob.id, 120);
  check(
    `${COUNT} products were created to bulk-edit`,
    seeded?.succeeded === COUNT,
    `succeeded=${seeded?.succeeded} error=${seeded?.error}`,
  );

  /* ------------------------------- resolve the selection, as the route does */

  const page = await client.lookupProducts({ all: true, limit: 500 });

  check(
    "the lookup summary carries the regular price the arithmetic needs",
    page.products.every((product) => product.regular_price === "200000"),
    page.products.map((product) => `${product.sku}=${product.regular_price}`).join(" "),
  );

  const operation: EditOperation = {
    kind: "price",
    target: "regular_price",
    operation: "percent",
    value: 10,
    decimals: 0,
  };

  /*
   * Resolved through the SAME function the route and the confirmation screen use.
   *
   * That shared function is the point: the number the operator reads and the number
   * the worker writes come from one implementation, so they cannot drift. A second
   * copy of the arithmetic in the worker would be a second chance to be wrong.
   */
  const outcomes = page.products.map((product) =>
    resolveEdit(
      {
        product_id: product.product_id,
        sku: product.sku,
        name: product.name,
        status: product.status,
        price: product.price,
        regular_price: product.regular_price,
        sale_price: product.sale_price,
        stock: product.stock,
      },
      operation,
    ),
  );

  const items = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.item] : []));

  check(
    "every product resolved to an absolute new price, not a rule to re-apply",
    items.length === COUNT && items.every((item) => item.set.regular_price === "220000"),
    items.map((item) => `${item.sku}=${item.set.regular_price}`).join(" "),
  );

  check(
    "and each row carries what it was, so the run can quote it afterwards",
    items.every((item) => item.was.regular_price === "200000"),
    items.map((item) => `${item.sku} was ${item.was.regular_price}`).join(" "),
  );

  /* ------------------------------------------------------------ run it */

  const editJob = await enqueueEdit({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: describeEdit(operation),
    createdBy: owner.id,
    options: {
      storeId: store.id,
      operation,
      threads: 2,
      batchSize: 50,
      displayCurrency: "",
    },
    products: items,
  });

  check("a bulk edit is queued as its own kind of run", editJob.kind === "update", editJob.kind);
  check(
    "and it names what it does, so Activity reads as a sentence",
    editJob.sourceLabel === "Change regular price by +10%",
    editJob.sourceLabel,
  );

  const edited = await waitFor(editJob.id, 180);

  check(
    "the bulk edit completed",
    edited?.status === "completed",
    `status=${edited?.status} error=${edited?.error}`,
  );
  check(
    `all ${COUNT} products were changed`,
    edited?.succeeded === COUNT && edited?.failed === 0,
    `succeeded=${edited?.succeeded} failed=${edited?.failed}`,
  );

  /* --------------------------------------- the site holds the new numbers */

  const after = await client.lookupProducts({ all: true, limit: 500 });

  check(
    "the site itself shows the new price",
    after.products.every((product) => product.regular_price === "220000"),
    after.products.map((product) => `${product.sku}=${product.regular_price}`).join(" "),
  );

  check(
    "and nothing else moved — the descriptions and categories are untouched",
    after.products.every((product) => product.categories.includes("Bulk Edit Cat")),
    after.products.map((product) => product.categories.join("/")).join(" "),
  );

  /* -------------------- the results ARE the record of the old prices */

  const results = await getResults(editJob.id);

  check(
    "every row is on record",
    results.length === COUNT,
    `rows=${results.length}`,
  );

  check(
    "each row records the price it replaced and the price it wrote",
    results.every(
      (result) =>
        result.changed?.regular_price?.from === "200000" &&
        result.changed?.regular_price?.to === "220000",
    ),
    results
      .map((r) => `${r.sku}:${r.changed?.regular_price?.from}→${r.changed?.regular_price?.to}`)
      .join(" "),
  );

  check(
    "each row is marked as an update, so it can never be offered as something the run CREATED",
    results.every((result) => result.action === "updated"),
    results.map((r) => `${r.sku}=${r.action}`).join(" "),
  );

  const created = await createdProductIds(editJob.id);
  check(
    '"Everything this run created" is EMPTY for a bulk edit — it created nothing',
    created.length === 0,
    `created=${created.join(",")}`,
  );

  const updated = await updatedProductIds(editJob.id);
  check(
    "and all of them are recorded as changed",
    updated.length === COUNT,
    `updated=${updated.length}`,
  );

  /* ------------------------------------------------------------- the log */

  const logs = await getJobLogs(editJob.id, { limit: 500 });

  check(
    "the run wrote a log, like every other run",
    logs.length > 0,
    `lines=${logs.length}`,
  );
  check(
    "the log names the change in words, before any batch went out",
    logs.some(
      (line) => line.stage === "run" && line.message.includes("Change regular price by +10%"),
    ),
    logs
      .filter((line) => line.stage === "run")
      .map((line) => line.message)
      .join(" | ")
      .slice(0, 300),
  );
  check(
    "and it closes with a summary",
    logs.some((line) => line.stage === "finish"),
    logs.map((line) => line.stage).join(","),
  );

  /* ----------------------------- re-running is idempotent by construction */

  /*
   * The staged row carries an ABSOLUTE value, so sending it twice writes the same
   * number twice. This is exactly why the selection was resolved at preview time
   * rather than kept as a rule: a stored "+10%" resent would add another 10%.
   */
  const again = await enqueueEdit({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: describeEdit(operation),
    createdBy: owner.id,
    options: { storeId: store.id, operation, threads: 2, batchSize: 50, displayCurrency: "" },
    products: items,
  });

  const repeated = await waitFor(again.id, 180);

  check(
    "resending a bulk edit changes nothing further — the values are absolute, not a rule",
    repeated?.deduplicated === COUNT,
    `deduplicated=${repeated?.deduplicated} succeeded=${repeated?.succeeded}`,
  );

  const unchanged = await client.lookupProducts({ all: true, limit: 500 });
  check(
    "so the price is still 220000 and not 242000",
    unchanged.products.every((product) => product.regular_price === "220000"),
    unchanged.products.map((product) => `${product.sku}=${product.regular_price}`).join(" "),
  );

  /* -------------------------------------------- clean up for later stages */

  const leftover = await client.lookupProductIds({ all: true });
  if (leftover.ids.length > 0) {
    await client.deleteProducts(leftover.ids, { deleteImages: true });
  }
}

/**
 * Stage 6 — the worker uses the RUN OWNER's S3, and never anyone else's.
 *
 * Two runs, and the second is the dangerous one:
 *
 *  1. Bob owns a run asking for S3. Bob's S3 is enabled but incomplete. Alice's
 *     is complete. If the worker still read one settings row, this run would
 *     succeed using Alice's bucket; it must fail instead, naming the cause.
 *  2. The ADMIN starts a run on Alice's behalf — created with Alice as its
 *     owner, which is what the import route does when an administrator is
 *     inside someone's account. The admin's own S3 is complete. The run must
 *     reach for ALICE's configuration, not the administrator's.
 *
 * Neither needs AWS: what is under test is which account's row the worker
 * resolves, and an incomplete row fails deterministically and offline.
 */
async function verifyPerAccountS3(store: Store, alice: TestAccount): Promise<void> {
  console.log("\nStage 6 — a run uses its OWNER's S3 credentials, never another account's\n");

  const bobId = process.env.ACCOUNT_BOB ?? "";
  const adminId = process.env.ACCOUNT_ADMIN ?? "";

  if (bobId === "" || adminId === "") {
    check("the account ids reached stage 6", false, "ACCOUNT_BOB / ACCOUNT_ADMIN not set");
    return;
  }

  // Bob has keys typed in but S3 switched off — the ordinary state of an
  // account that has not finished setting it up. `saveS3` refuses to store an
  // enabled-but-incomplete configuration, so "off" is what half-configured
  // actually looks like.
  await saveS3(bobId, {
    enabled: false,
    accessKeyId: "AKIABOBE2EONLY",
    secretAccessKey: "bob-secret-never-logged",
    bucket: "",
    region: "",
    publicUrl: "",
    prefix: "",
  });

  check(
    "each account resolves its OWN bucket",
    (await getS3Credentials(alice.id))?.bucket === "bucket-alice" &&
      (await getS3Credentials(adminId))?.bucket === "bucket-admin",
    `alice=${(await getS3Credentials(alice.id))?.bucket} admin=${(await getS3Credentials(adminId))?.bucket}`,
  );

  check(
    "an account with no usable S3 resolves to nothing, never to a neighbour's",
    (await getS3Credentials(bobId)) === null,
  );

  const s3Options = {
    ...DEFAULT_IMPORT_OPTIONS,
    storeId: store.id,
    imageMode: "s3" as const,
    threads: 1,
    batchSize: 50,
  };

  const product: Product[] = [
    {
      name: "S3 Ownership Probe",
      slug: "s3-ownership-probe",
      sku: "S3-PROBE",
      price: "1000",
      instock: true,
      images: ["https://cdn.test/probe.jpg"],
    },
  ];

  // Bob owns a site of his own, because a run and its site must belong to the
  // same account — the worker refuses the pair otherwise.
  const bobStore = await createStore(bobId, {
    url: store.url,
    pin: "",
    apiKey: process.env.PLUGIN_API_KEY ?? store.apiKey,
    apiSecret: "unused-this-run-never-reaches-the-site",
    urlRewrite: false,
    baseUrlOverride: store.baseUrlOverride,
    label: "bob e2e",
  });

  const bobRun = await enqueueImport({
    storeId: bobStore.id,
    storeUrl: bobStore.url,
    sourceLabel: "bob s3 probe",
    options: { ...s3Options, storeId: bobStore.id },
    products: applyOptions(product, s3Options, { sourceId: "e2e-bob" }),
    createdBy: bobId,
  });

  const bobState = await waitFor(bobRun.id, 60);

  check(
    "a run whose owner has no S3 FAILS rather than borrowing another account's bucket",
    bobState?.status === "failed",
    `status=${bobState?.status}`,
  );
  check(
    "and the failure names the cause",
    (bobState?.error ?? "").includes("the account that owns it has no complete S3"),
    bobState?.error ?? "(no error recorded)",
  );
  check(
    "nothing was sent to the site",
    bobState?.processed === 0,
    `processed=${bobState?.processed}`,
  );

  // The administrator's own S3 is complete. A run they start on Alice's behalf
  // is owned by Alice, so it must resolve Alice's bucket.
  const onBehalf = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "started by the administrator, owned by alice",
    options: s3Options,
    products: applyOptions(product, s3Options, { sourceId: "e2e-on-behalf" }),
    // Exactly what app/api/import/route.ts writes when an administrator is
    // inside a member's account: the MEMBER, not the caller.
    createdBy: alice.id,
  });

  check(
    "a run an administrator started on a member's behalf is owned by the member",
    onBehalf.createdBy === alice.id,
    onBehalf.createdBy,
  );

  const onBehalfState = await waitFor(onBehalf.id, 90);

  // Alice's S3 is complete but its credentials are invented, so the upload
  // fails at AWS rather than at configuration. What matters here is that it got
  // that far at all: the run resolved a bucket, and the only bucket it could
  // have resolved is Alice's.
  check(
    "it passed the owner's S3 configuration check rather than the administrator's",
    (onBehalfState?.error ?? "").includes("no complete S3") === false,
    onBehalfState?.error ?? "(no error recorded)",
  );
}

/** Poll a run until it stops moving, or give up. */
/**
 * Images copied into the site's media library, over REAL HTTP to the real plugin.
 *
 * This is the one thing neither of the other two image suites can prove.
 * `tests/images-staging.ts` stubs the plugin and asserts what this side sends;
 * `GPM_toshstack/tests/integration.php` calls `ImageWriter` directly. What only this
 * harness reaches is the WIRE between them — and the wire is where this design is
 * least obvious, because the body is mostly base64 and the HMAC covers all of it.
 * `Auth::verify` signs `method \n path \n timestamp \n body`, so a megabyte of
 * base64 is a megabyte of signed material; if anything on either side normalised,
 * re-encoded or truncated the body, every upload would fail authentication and
 * nothing smaller than this would notice.
 */
async function verifyImageUpload(store: Store, alice: TestAccount): Promise<void> {
  console.log("\nImages copied into the site — over real HTTP\n");

  const imageHost = process.env.IMAGE_HOST;

  if (imageHost === undefined || imageHost === "") {
    check("IMAGE_HOST is set, so the image host is reachable", false, "IMAGE_HOST is empty");
    return;
  }

  const client = await clientFor(store);

  check(
    "the site reports a plugin new enough to accept image bytes",
    supportsImageUpload(store.pluginVersion),
    `pluginVersion=${store.pluginVersion}`,
  );

  /*
   * A megabyte, not a thumbnail. The point is a body large enough that base64
   * inflation and the HMAC over it are exercised for real — a 20-byte fixture would
   * pass whether or not the signing covers the bytes.
   */
  const bytes = Buffer.alloc(1024 * 1024);
  bytes.write("\xFF\xD8\xFF\xE0", 0, "binary");

  const sourceUrl = `${imageHost}/e2e-wire-probe.jpg`;

  const first = await client.uploadImages([
    { source_url: sourceUrl, content_type: "image/jpeg", bytes: bytes.toString("base64") },
  ]);

  check(
    "a 1 MB image survives base64 and the HMAC over the whole body",
    first[0]?.ok === true,
    JSON.stringify(first[0]),
  );
  check(
    "and comes back as a URL on the site itself",
    (first[0]?.url ?? "").startsWith(store.url) &&
      (first[0]?.url ?? "").includes("/wp-content/uploads/"),
    first[0]?.url,
  );
  check(
    "the server chose the filename, appending a hash of the source URL",
    /\/e2e-wire-probe-[0-9a-f]{8}\.jpg$/.test(first[0]?.url ?? ""),
    first[0]?.url,
  );

  /*
   * The SECOND upload is the proof that the first one really wrote a file.
   *
   * `skipped` is only ever true when the plugin found the file already on disk with
   * a matching size — so this asserts the write happened, from the outside, without
   * reaching into the container's filesystem. It is also the regression test for the
   * `-1`, `-2` duplicates the old `/images/fetch` left behind on every retry.
   */
  const second = await client.uploadImages([
    { source_url: sourceUrl, content_type: "image/jpeg", bytes: bytes.toString("base64") },
  ]);

  check(
    "sending it again writes nothing and reports skipped",
    second[0]?.ok === true && second[0]?.skipped === true,
    JSON.stringify(second[0]),
  );
  check(
    "and answers with the SAME URL — no -1 duplicate",
    second[0]?.url === first[0]?.url,
    `${first[0]?.url} vs ${second[0]?.url}`,
  );

  // Bytes that are not an image are refused on the bytes, not on the label.
  const lying = await client.uploadImages([
    {
      source_url: `${imageHost}/not-an-image.jpg`,
      content_type: "image/jpeg",
      bytes: Buffer.from("<!DOCTYPE html><title>404</title>").toString("base64"),
    },
  ]);

  check(
    "an HTML page labelled image/jpeg is refused by the site",
    lying[0]?.ok === false && (lying[0]?.error ?? "").includes("not a recognised image"),
    JSON.stringify(lying[0]),
  );

  /*
   * The route the previous build served must be gone, and gone LOUDLY.
   *
   * Asserted on the CODE and the STATUS, not on the wording. The plugin's sentence is
   * "No such route: POST /images/fetch", and a test matching that text would start
   * failing the day somebody improved the sentence — while a build that quietly
   * answered 200 would still pass it.
   */
  let removedRoute: { status: number; code: string; message: string } | null = null;

  try {
    await (
      client as unknown as { request: (m: string, r: string, b: unknown) => Promise<unknown> }
    ).request("POST", "/images/fetch", { images: [sourceUrl] });
  } catch (error) {
    removedRoute =
      error instanceof GopApiError
        ? { status: error.status, code: error.code, message: error.message }
        : { status: 0, code: "not-a-GopApiError", message: String(error) };
  }

  check(
    "the old /images/fetch route is gone, and refuses with unknown_route rather than half-working",
    removedRoute?.status === 404 && removedRoute.code === "unknown_route",
    JSON.stringify(removedRoute),
  );

  /*
   * And now the whole thing as an operator runs it: a real import in upload_site
   * mode, whose product must end up pointing at the site rather than at the source.
   */
  const options = {
    ...DEFAULT_IMPORT_OPTIONS,
    storeId: store.id,
    imageMode: "upload_site" as const,
    threads: 1,
    batchSize: 50,
  };

  const products: Product[] = [
    {
      name: "Ảnh vào thư viện",
      slug: "anh-vao-thu-vien",
      sku: "E2E-IMG-1",
      price: "125000",
      instock: true,
      images: [`${imageHost}/ok.jpg`, `${imageHost}/also-ok.png`],
    },
    {
      // The dead link must NOT stop this product from publishing — it keeps the
      // original URL and the run carries on.
      name: "Ảnh chết vẫn lên hàng",
      slug: "anh-chet-van-len-hang",
      sku: "E2E-IMG-2",
      price: "99000",
      instock: true,
      images: [`${imageHost}/missing.jpg`],
    },
  ];

  const run = await enqueueImport({
    storeId: store.id,
    storeUrl: store.url,
    sourceLabel: "e2e upload_site",
    options,
    products: applyOptions(products, options, { sourceId: "e2e-upload-site" }),
    createdBy: alice.id,
  });

  const state = await waitFor(run.id, 90);

  check(
    "an upload_site run completes",
    state?.status === "completed",
    `status=${state?.status} error=${state?.error}`,
  );
  check("both products were published", state?.succeeded === 2, `succeeded=${state?.succeeded}`);

  const onSite = await client.lookupProducts({ skus: ["E2E-IMG-1", "E2E-IMG-2"] });

  check(
    "the product whose images worked has an image on the site",
    onSite.products.find((product) => product.sku === "E2E-IMG-1")?.has_image === true,
    JSON.stringify(onSite.products.map((product) => [product.sku, product.has_image])),
  );
  check(
    "and the product with a dead link was still published",
    onSite.products.some((product) => product.sku === "E2E-IMG-2"),
    JSON.stringify(onSite.products.map((product) => product.sku)),
  );
}

async function waitFor(jobId: string, seconds: number): Promise<JobState | null> {
  let state = await getJobState(jobId);

  for (
    let attempt = 0;
    attempt < seconds && state && (state.status === "queued" || state.status === "running");
    attempt++
  ) {
    await sleep(1000);
    state = await getJobState(jobId);
  }

  return state;
}

if (PHASE === "seed") {
  void seed();
} else {
  void verify();
}
