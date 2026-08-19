/**
 * Customer isolation, administrator power, and the reveal audit trail —
 * asserted over HTTP against a real running app.
 *
 * Why HTTP and not the lib layer: what is under test is what a SIGNED-IN CALLER
 * can reach. The guards, the ownership check and the session all live on the
 * request path, and a test that calls `listStores(id)` directly proves only that
 * the argument was passed.
 *
 * Why assertions BY ID and not only by what the lists return: the list filter
 * and the ownership check are two different bugs, and only the second one is the
 * security hole. Before this change every list was unfiltered AND every `[id]`
 * route was unguarded; fixing the filters alone would leave one customer able to
 * cancel another's run, delete their site or export their results by pasting an
 * id into a URL, while every screen looked correct.
 *
 * Setup uses the lib layer directly — creating rows is not what is being tested,
 * and it keeps the fixture independent of a live WooCommerce site. Every
 * ASSERTION goes through the running server.
 *
 * Run through tests/isolation.sh, never directly.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { closeDatabase, db } from "../db";
import { licenseKeys, previews, secretReveals, stores } from "../db/schema";
import { enqueueJob, getJobState, isScheduled } from "../lib/jobs";
import { savePreset } from "../lib/presets";
import { redis } from "../lib/redis";
import { saveS3 } from "../lib/settings";
import { createStore } from "../lib/stores";
import { DEFAULT_IMPORT_OPTIONS } from "../lib/import-options";

const BASE = process.env.APP_URL ?? "http://localhost:3000";

/*
 * The fixture secrets.
 *
 * Exported through the environment so tests/isolation.sh can grep the captured
 * server output for them afterwards. A secret must never reach a log, a URL or
 * an error message, and the only way to be sure is to look.
 */
const SECRETS = {
  aliceSite: "alice-site-secret-Q7bX2m",
  bobSite: "bob-site-secret-Z4kP9w",
  aliceS3: "alice-aws-secret-H3nR6t",
  bobS3: "bob-aws-secret-V8dL1c",
  password: "correct-horse-battery-staple",
};

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

/* ------------------------------------------------------------------ client */

/**
 * One signed-in browser.
 *
 * Keeps its own cookie jar, because the whole point is that two callers with
 * two sessions see two different things — sharing a jar would silently make
 * every assertion about the same account.
 */
class Client {
  private cookies = new Map<string, string>();

  constructor(readonly label: string) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{
    status: number;
    json: Record<string, unknown>;
    text: string;
    headers: Headers;
  }> {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        // better-auth rejects a sign-in whose origin is not exactly
        // BETTER_AUTH_URL, and it is the same value as BASE here.
        Origin: BASE,
        ...(this.cookies.size > 0 ? { Cookie: this.cookieHeader() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });

    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index > 0) {
        this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    }

    const text = await response.text();

    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A CSV export or a 204 is not JSON, and that is fine.
    }

    return { status: response.status, json, text, headers: response.headers };
  }

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  deleteCookie(name: string): void {
    this.cookies.delete(name);
  }
}

async function register(
  client: Client,
  name: string,
  email: string,
  licenseKey = "",
): Promise<void> {
  const result = await client.request("POST", "/api/register", {
    name,
    email,
    password: SECRETS.password,
    licenseKey,
  });

  if (result.status !== 201) {
    throw new Error(`register ${email} failed: ${result.status} ${result.text.slice(0, 300)}`);
  }
}

async function signIn(client: Client, email: string): Promise<void> {
  const result = await client.request("POST", "/api/auth/sign-in/email", {
    email,
    password: SECRETS.password,
  });

  if (result.status !== 200) {
    throw new Error(`sign-in ${email} failed: ${result.status} ${result.text.slice(0, 300)}`);
  }
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  console.log(`\nIsolation suite against ${BASE}\n`);

  /* ---------------------------------------------------------- the accounts */

  const admin = new Client("admin");
  const alice = new Client("alice");
  const bob = new Client("bob");

  // The first account ever created becomes the administrator and is issued a
  // licence automatically — no key needed, and none available yet.
  await register(admin, "Admin", "admin@isolation.test");
  await signIn(admin, "admin@isolation.test");

  const minted = await admin.request("POST", "/api/admin/licenses", { count: 2, note: "fixture" });
  const keys = (minted.json.licenses as Array<{ key: string }> | undefined) ?? [];
  check("the administrator can mint licence keys", keys.length === 2, JSON.stringify(minted.json).slice(0, 200));

  await register(alice, "Alice", "alice@isolation.test", keys[0].key);
  await register(bob, "Bob", "bob@isolation.test", keys[1].key);
  await signIn(alice, "alice@isolation.test");
  await signIn(bob, "bob@isolation.test");

  const aliceId = await idOf(alice);
  const bobId = await idOf(bob);
  const adminId = await idOf(admin);

  check("three separate accounts exist", new Set([aliceId, bobId, adminId]).size === 3);

  /* ------------------------------------------------- one of everything each */

  const fixtures = {
    alice: await fixturesFor(aliceId, "alice", SECRETS.aliceSite, SECRETS.aliceS3, "bucket-alice"),
    bob: await fixturesFor(bobId, "bob", SECRETS.bobSite, SECRETS.bobS3, "bucket-bob"),
  };

  /* ============================================================ ISOLATION */

  console.log("\n-- A member sees only their own --\n");

  const bobStores = await bob.request("GET", "/api/stores");
  const bobStoreIds = ((bobStores.json.stores as Array<{ id: string }>) ?? []).map((s) => s.id);
  check(
    "the site list excludes another account's sites",
    bobStoreIds.includes(fixtures.bob.storeId) && !bobStoreIds.includes(fixtures.alice.storeId),
    bobStoreIds.join(","),
  );

  const bobJobs = await bob.request("GET", "/api/jobs");
  const bobJobIds = [
    ...((bobJobs.json.queued as Array<{ id: string }>) ?? []),
    ...((bobJobs.json.running as Array<{ id: string }>) ?? []),
    ...((bobJobs.json.history as Array<{ id: string }>) ?? []),
  ].map((job) => job.id);
  check(
    "the run list excludes another account's runs",
    bobJobIds.includes(fixtures.bob.jobId) && !bobJobIds.includes(fixtures.alice.jobId),
    bobJobIds.join(","),
  );

  const bobPresets = await bob.request("GET", "/api/presets");
  check(
    "the preset list excludes another account's presets",
    ((bobPresets.json.presets as Array<{ id: string }>) ?? []).every(
      (preset) => preset.id !== fixtures.alice.presetId,
    ),
  );

  console.log("\n-- ...and cannot reach them BY ID. 404, never 403 --\n");

  // 403 would confirm the id exists, which is itself a fact about another
  // customer. To Bob, Alice's data must be indistinguishable from data that was
  // never there.
  const byId: Array<[string, string, string, unknown?]> = [
    ["read a run", "GET", `/api/jobs/${fixtures.alice.jobId}`],
    ["cancel a run", "POST", `/api/jobs/${fixtures.alice.jobId}/cancel`],
    // Every route added for Stop, scheduling and the group offer goes through the
    // same guard as the ones that were already here. Asserted BY ID rather than
    // assumed: filtering a list and checking an id are two different bugs, and
    // only the second is reachable by pasting a URL.
    ["stop a run", "POST", `/api/jobs/${fixtures.alice.jobId}/stop`],
    ["read a run's group siblings", "GET", `/api/jobs/${fixtures.alice.jobId}/cancel`],
    [
      "reschedule a run",
      "PATCH",
      `/api/jobs/${fixtures.alice.jobId}/schedule`,
      { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() },
    ],
    ["retry a run", "POST", `/api/jobs/${fixtures.alice.jobId}/retry-failed`],
    ["read a run's results", "GET", `/api/jobs/${fixtures.alice.jobId}/results`],
    ["export a run's results", "GET", `/api/jobs/${fixtures.alice.jobId}/results/export`],
    ["delete a run", "DELETE", `/api/jobs/${fixtures.alice.jobId}`],
    ["read a site", "GET", `/api/stores/${fixtures.alice.storeId}`],
    ["edit a site", "PATCH", `/api/stores/${fixtures.alice.storeId}`, { label: "hijacked" }],
    ["delete a site", "DELETE", `/api/stores/${fixtures.alice.storeId}`],
    ["check a site", "POST", `/api/stores/${fixtures.alice.storeId}/check`],
    [
      "run maintenance on a site",
      "POST",
      `/api/stores/${fixtures.alice.storeId}/maintenance`,
      { action: "clear-transients" },
    ],
    ["read a site's taxonomy", "GET", `/api/stores/${fixtures.alice.storeId}/terms`],
    ["delete a preset", "DELETE", `/api/presets/${fixtures.alice.presetId}`],
    ["read a preview", "GET", `/api/import/preview/${fixtures.alice.previewId}`],
  ];

  for (const [what, method, path, body] of byId) {
    const result = await bob.request(method, path, body);
    check(
      `B cannot ${what} of A's — 404`,
      result.status === 404,
      `got ${result.status} ${result.text.slice(0, 160)}`,
    );
  }

  const start = await bob.request("POST", "/api/import", {
    previewId: fixtures.alice.previewId,
    storeIds: [fixtures.bob.storeId],
  });
  check(
    "B cannot start a run from A's staged preview — 404",
    start.status === 404,
    `got ${start.status} ${start.text.slice(0, 160)}`,
  );

  /*
   * The product-management routes, by id.
   *
   * The list filter and the ownership check are two different bugs, and only the
   * second is reachable by pasting an id — so every one of these names A's SITE and
   * has to come back as though it did not exist. 404 and never 403: a 403 would
   * confirm the site is real, which is itself a fact about another customer.
   */
  const productRoutes: Array<[string, string, Record<string, unknown>]> = [
    ["list another account's products", "/api/products/lookup", { storeId: fixtures.alice.storeId }],
    [
      "edit a product on another account's site",
      "/api/products/update",
      { storeId: fixtures.alice.storeId, productId: 1, regularPrice: 1 },
    ],
    [
      "preview a bulk change on another account's site",
      "/api/products/bulk",
      {
        action: "preview",
        storeId: fixtures.alice.storeId,
        selection: { productIds: [1, 2, 3] },
        operation: { kind: "price", operation: "percent", value: -10 },
      },
    ],
    [
      "run a bulk change on another account's site",
      "/api/products/bulk",
      {
        action: "run",
        storeId: fixtures.alice.storeId,
        selection: { productIds: [1, 2, 3] },
        operation: { kind: "status", value: "draft" },
        confirmPhrase: "UPDATE",
      },
    ],
    [
      "delete products from another account's site",
      "/api/purge",
      {
        options: {
          storeId: fixtures.alice.storeId,
          selection: { kind: "ids", productIds: [1, 2, 3] },
        },
        ids: [1, 2, 3],
        confirmPhrase: "DELETE",
      },
    ],
  ];

  for (const [what, path, body] of productRoutes) {
    const result = await bob.request("POST", path, body);
    check(
      `B cannot ${what} — 404`,
      result.status === 404,
      `got ${result.status} ${result.text.slice(0, 160)}`,
    );
  }

  const purgeFromRun = await bob.request("POST", "/api/purge/lookup", {
    storeId: fixtures.bob.storeId,
    selection: { kind: "run", runId: fixtures.alice.jobId },
  });
  check(
    "B cannot turn A's run into a list of products to delete",
    purgeFromRun.status === 400 || purgeFromRun.status === 404,
    `got ${purgeFromRun.status} ${purgeFromRun.text.slice(0, 160)}`,
  );

  const bulkCancel = await bob.request("POST", "/api/jobs/cancel", {
    ids: [fixtures.alice.jobId],
  });
  check(
    "a bulk cancel naming A's run cancels nothing",
    (bulkCancel.json.count as number) === 0,
    JSON.stringify(bulkCancel.json),
  );
  check(
    "and A's run is genuinely untouched",
    (await getJobState(fixtures.alice.jobId))?.status === "queued",
  );

  /*
   * The bulk DELETE is the same hole as the bulk cancel and a worse outcome: a
   * cancel that leaked would stop a stranger's run, a delete that leaked would
   * destroy their history. Both ends are checked — the count it reports, and the
   * row still being there afterwards, because a route that answered "0 deleted"
   * while deleting would pass the first assertion alone.
   */
  const bulkDeletePlan = await bob.request("POST", "/api/jobs/delete", {
    ids: [fixtures.alice.jobId],
  });
  check(
    "B cannot even ask how many rows A's run would cost to delete",
    ((bulkDeletePlan.json.footprints as unknown[] | undefined)?.length ?? 0) === 0 &&
      (bulkDeletePlan.json.rows as number) === 0,
    JSON.stringify(bulkDeletePlan.json),
  );

  const bulkDelete = await bob.request("DELETE", "/api/jobs/delete", {
    ids: [fixtures.alice.jobId],
  });
  check(
    "a bulk delete naming A's run deletes nothing",
    (bulkDelete.json.count as number) === 0,
    JSON.stringify(bulkDelete.json),
  );
  check(
    "and A's run still exists",
    (await getJobState(fixtures.alice.jobId)) !== null,
  );

  console.log("\n-- separate settings, separate credentials --\n");

  const aliceSettings = await alice.request("GET", "/api/settings");
  const bobSettings = await bob.request("GET", "/api/settings");

  check(
    "each account's S3 configuration is a genuinely different row",
    (aliceSettings.json.s3 as { bucket: string }).bucket === "bucket-alice" &&
      (bobSettings.json.s3 as { bucket: string }).bucket === "bucket-bob",
    `${JSON.stringify(aliceSettings.json.s3)} / ${JSON.stringify(bobSettings.json.s3)}`,
  );

  await bob.request("PUT", "/api/settings", { ...(bobSettings.json.settings as object), historyLimit: 321 });
  const aliceAfter = await alice.request("GET", "/api/settings");
  check(
    "one account saving its settings does not touch another's",
    (aliceAfter.json.settings as { historyLimit: number }).historyLimit !== 321,
    JSON.stringify(aliceAfter.json.settings),
  );

  check(
    "no ordinary settings payload carries a secret",
    !aliceSettings.text.includes(SECRETS.aliceS3) && !bobSettings.text.includes(SECRETS.bobS3),
  );

  const bobStore = await bob.request("GET", `/api/stores/${fixtures.bob.storeId}`);
  check(
    "no site payload carries a secret, not even your own site's",
    !bobStore.text.includes(SECRETS.bobSite),
    bobStore.text.slice(0, 200),
  );

  console.log("\n-- a member cannot reveal a secret, not even their own --\n");

  const memberRevealS3 = await bob.request("POST", "/api/admin/reveal/s3", { userId: bobId });
  check(
    "a member cannot reveal their OWN AWS secret — 403",
    memberRevealS3.status === 403,
    `got ${memberRevealS3.status}`,
  );

  const memberRevealStore = await bob.request(
    "POST",
    `/api/admin/reveal/store/${fixtures.bob.storeId}`,
  );
  check(
    "a member cannot reveal their OWN site secret — 403",
    memberRevealStore.status === 403,
    `got ${memberRevealStore.status}`,
  );

  const memberEnter = await bob.request("POST", "/api/admin/view", { userId: aliceId });
  check("a member cannot enter another account — 403", memberEnter.status === 403);

  // A forged cookie is not a capability: `lib/view.ts` re-authorises it against
  // the database on every request, and a member is never an administrator.
  bob.setCookie("gop_view_account", aliceId);
  const forged = await bob.request("GET", "/api/stores");
  const forgedIds = ((forged.json.stores as Array<{ id: string }>) ?? []).map((s) => s.id);
  check(
    "forging the view cookie gets a member nothing",
    !forgedIds.includes(fixtures.alice.storeId) && forgedIds.includes(fixtures.bob.storeId),
    forgedIds.join(","),
  );
  bob.deleteCookie("gop_view_account");

  /* ====================================================== ADMIN POWER */

  console.log("\n-- an administrator sees and controls everything --\n");

  const allJobs = await admin.request("GET", "/api/admin/jobs");
  const allIds = [
    ...((allJobs.json.queued as Array<{ id: string }>) ?? []),
    ...((allJobs.json.running as Array<{ id: string }>) ?? []),
    ...((allJobs.json.history as Array<{ id: string }>) ?? []),
  ];
  check(
    "the administrator sees every account's runs in one place",
    allIds.some((job) => job.id === fixtures.alice.jobId) &&
      allIds.some((job) => job.id === fixtures.bob.jobId),
    allIds.map((job) => job.id).join(","),
  );
  check(
    "and every row names the account it belongs to",
    (allJobs.json.queued as Array<{ ownerEmail?: string }>).every(
      (job) => typeof job.ownerEmail === "string" && job.ownerEmail !== "",
    ),
  );

  const adminReadsB = await admin.request("GET", `/api/jobs/${fixtures.bob.jobId}`);
  check("an administrator can read a member's run", adminReadsB.status === 200, `got ${adminReadsB.status}`);

  const adminReadsBSite = await admin.request("GET", `/api/stores/${fixtures.bob.storeId}`);
  check("an administrator can read a member's site", adminReadsBSite.status === 200);

  // Entering an account: everything the administrator now reads and WRITES
  // belongs to that account.
  const entered = await admin.request("POST", "/api/admin/view", { userId: bobId });
  check("an administrator can enter another account", entered.status === 200);

  const insideStores = await admin.request("GET", "/api/stores");
  const insideIds = ((insideStores.json.stores as Array<{ id: string }>) ?? []).map((s) => s.id);
  check(
    "inside the account, the ordinary screens show that account's data",
    insideIds.includes(fixtures.bob.storeId) && !insideIds.includes(fixtures.alice.storeId),
    insideIds.join(","),
  );

  const insideSettings = await admin.request("GET", "/api/settings");
  await admin.request("PUT", "/api/settings", {
    ...(insideSettings.json.settings as object),
    historyLimit: 456,
  });
  await admin.request("DELETE", "/api/admin/view");

  const bobSeesEdit = await bob.request("GET", "/api/settings");
  check(
    "an administrator can edit a member's settings, and the edit lands on the MEMBER",
    (bobSeesEdit.json.settings as { historyLimit: number }).historyLimit === 456,
    JSON.stringify(bobSeesEdit.json.settings),
  );

  const adminOwn = await admin.request("GET", "/api/settings");
  check(
    "and not on the administrator's own",
    (adminOwn.json.settings as { historyLimit: number }).historyLimit !== 456,
    JSON.stringify(adminOwn.json.settings),
  );

  const adminCancels = await admin.request("POST", `/api/jobs/${fixtures.bob.jobId}/cancel`);
  check(
    "an administrator can cancel a member's run",
    adminCancels.status === 200,
    `got ${adminCancels.status} ${adminCancels.text.slice(0, 160)}`,
  );

  /*
   * The cancel above settled Bob's run, so Stop must now be REFUSED rather than
   * silently succeeding — the isolation here is between customers, not between a
   * customer and the operator, but "an administrator is allowed" does not mean
   * "an administrator may stop a run that has already stopped".
   *
   * 409 rather than 404 on purpose: the run exists and the administrator may see
   * it, so pretending otherwise would be the wrong lie.
   */
  const adminStopsSettled = await admin.request("POST", `/api/jobs/${fixtures.bob.jobId}/stop`);
  check(
    "stopping an already-cancelled run is refused with 409, not silently accepted",
    adminStopsSettled.status === 409,
    `got ${adminStopsSettled.status} ${adminStopsSettled.text.slice(0, 160)}`,
  );

  // Alice's run is still queued, so it is the one Stop can actually act on.
  const adminStops = await admin.request("POST", `/api/jobs/${fixtures.alice.jobId}/stop`);
  check(
    "an administrator can stop a member's live run",
    adminStops.status === 200,
    `got ${adminStops.status} ${adminStops.text.slice(0, 160)}`,
  );
  check(
    "and the response says plainly what a Stop cannot promise about the site",
    String(adminStops.json.warning ?? "").includes("can hold products that are not listed"),
    String(adminStops.json.warning ?? "(no warning)"),
  );

  const stoppedRun = await getJobState(fixtures.alice.jobId);
  check(
    "the stop is recorded on the run durably, with the mode that was used",
    stoppedRun?.cancelRequestedAt !== null && stoppedRun?.cancelMode === "stop",
    `cancelRequestedAt=${stoppedRun?.cancelRequestedAt} mode=${stoppedRun?.cancelMode}`,
  );

  /* ========================================================== REVEALS */

  console.log("\n-- reveal is explicit, administrator-only, and recorded --\n");

  const revealS3 = await admin.request("POST", "/api/admin/reveal/s3", { userId: bobId });
  check(
    "an administrator can reveal a member's AWS secret",
    revealS3.status === 200 && revealS3.json.secretAccessKey === SECRETS.bobS3,
    `got ${revealS3.status}`,
  );
  check(
    "the revealed secret is marked no-store, so nothing in between keeps a copy",
    (revealS3.headers.get("cache-control") ?? "").includes("no-store"),
    revealS3.headers.get("cache-control") ?? "(absent)",
  );

  const revealSite = await admin.request(
    "POST",
    `/api/admin/reveal/store/${fixtures.bob.storeId}`,
  );
  check(
    "an administrator can reveal a member's site secret",
    revealSite.status === 200 && revealSite.json.apiSecret === SECRETS.bobSite,
    `got ${revealSite.status}`,
  );
  check(
    "and it too is no-store",
    (revealSite.headers.get("cache-control") ?? "").includes("no-store"),
    revealSite.headers.get("cache-control") ?? "(absent)",
  );

  const rows = await db.select().from(secretReveals);

  check("every reveal wrote a record", rows.length === 2, `rows=${rows.length}`);
  check(
    "the record names the administrator, the account and the time",
    rows.every(
      (row) =>
        row.actorEmail === "admin@isolation.test" &&
        row.targetEmail === "bob@isolation.test" &&
        row.at instanceof Date,
    ),
    JSON.stringify(rows.map((row) => [row.actorEmail, row.targetEmail, row.kind])),
  );
  check(
    "and holds no secret itself",
    rows.every(
      (row) =>
        !JSON.stringify(row).includes(SECRETS.bobS3) &&
        !JSON.stringify(row).includes(SECRETS.bobSite),
    ),
  );
  check(
    "both kinds are recorded distinctly",
    new Set(rows.map((row) => row.kind)).size === 2,
    rows.map((row) => row.kind).join(","),
  );


  /* ============================================ ADMIN IS NOT A CUSTOMER */

  console.log("\n-- an administrator account does not publish products --\n");

  const adminImport = await admin.request("POST", "/api/import", {
    previewId: fixtures.bob.previewId,
    storeIds: [fixtures.bob.storeId],
  });
  check(
    "an administrator cannot start an import in their own account — 403",
    adminImport.status === 403 && adminImport.json.code === "admin_cannot_publish",
    `got ${adminImport.status} ${adminImport.text.slice(0, 160)}`,
  );

  const adminPurge = await admin.request("POST", "/api/purge", {
    options: { storeId: fixtures.bob.storeId, selection: { kind: "all", confirm: true } },
    ids: [1, 2, 3],
    confirmPhrase: "DELETE",
  });
  check(
    "an administrator cannot start a removal in their own account — 403",
    adminPurge.status === 403 && adminPurge.json.code === "admin_cannot_publish",
    `got ${adminPurge.status} ${adminPurge.text.slice(0, 160)}`,
  );

  /*
   * Changing a product is the same kind of act as publishing one, so it follows the
   * same rule — and both routes, because the navigation hiding a screen is a courtesy
   * and a bookmarked URL is not.
   */
  const adminEdit = await admin.request("POST", "/api/products/update", {
    storeId: fixtures.bob.storeId,
    productId: 1,
    regularPrice: 1000,
  });
  check(
    "an administrator cannot edit a product in their own account — 403",
    adminEdit.status === 403 && adminEdit.json.code === "admin_cannot_publish",
    `got ${adminEdit.status} ${adminEdit.text.slice(0, 160)}`,
  );

  const adminBulk = await admin.request("POST", "/api/products/bulk", {
    action: "preview",
    storeId: fixtures.bob.storeId,
    selection: { productIds: [1, 2] },
    operation: { kind: "status", value: "draft" },
  });
  check(
    "nor change products in bulk in their own account — 403",
    adminBulk.status === 403 && adminBulk.json.code === "admin_cannot_publish",
    `got ${adminBulk.status} ${adminBulk.text.slice(0, 160)}`,
  );

  // Inside a customer's account the same administrator MAY publish — that is
  // support work, and the run belongs to the customer.
  await admin.request("POST", "/api/admin/view", { userId: bobId });
  const insideImport = await admin.request("POST", "/api/import", {
    previewId: fixtures.bob.previewId,
    storeIds: [fixtures.bob.storeId],
  });
  check(
    "but inside a customer's account it is allowed",
    insideImport.status !== 403,
    `got ${insideImport.status} ${insideImport.text.slice(0, 160)}`,
  );

  /*
   * The same, for the product routes.
   *
   * `!== 403` rather than a success: Bob's fixture site does not answer, so this
   * fails at the network. What is under test is which side of the permission
   * boundary the request landed on, and 403 is the only status that would mean it
   * was refused as an administrator.
   */
  const insideEdit = await admin.request("POST", "/api/products/update", {
    storeId: fixtures.bob.storeId,
    productId: 1,
    regularPrice: 1000,
  });
  check(
    "and so is changing one of the customer's products",
    insideEdit.status !== 403,
    `got ${insideEdit.status} ${insideEdit.text.slice(0, 160)}`,
  );

  await admin.request("DELETE", "/api/admin/view");

  /* ==================================================== PER-ACCOUNT LIMITS */

  console.log("\n-- what an administrator switches off is enforced by the API --\n");

  const memberSetsLimits = await bob.request("PUT", "/api/admin/limits", {
    userId: bobId,
    importEnabled: true,
    removeEnabled: true,
    s3Allowed: true,
    maxStores: null,
    maxProductsPerRun: null,
    maxThreads: null,
  });
  check(
    "a member cannot set their own limits — 403",
    memberSetsLimits.status === 403,
    `got ${memberSetsLimits.status}`,
  );

  const setLimits = await admin.request("PUT", "/api/admin/limits", {
    userId: bobId,
    importEnabled: false,
    removeEnabled: false,
    productEditEnabled: false,
    s3Allowed: false,
    maxStores: 1,
    maxProductsPerRun: 10,
    maxThreads: 2,
  });
  check("an administrator can set an account's limits", setLimits.status === 200, `got ${setLimits.status}`);

  const blockedImport = await bob.request("POST", "/api/import", {
    previewId: fixtures.bob.previewId,
    storeIds: [fixtures.bob.storeId],
  });
  check(
    "import switched off is refused BY THE API, not merely hidden — 403",
    blockedImport.status === 403 && blockedImport.json.code === "not_permitted",
    `got ${blockedImport.status} ${blockedImport.text.slice(0, 200)}`,
  );

  /*
   * A SCHEDULED import is still an import.
   *
   * The tempting shape is to check the limits when the run fires and not when it
   * is scheduled, on the grounds that scheduling publishes nothing. That would
   * let an account with importing switched off fill the queue and find out at
   * 3am, which is both useless as feedback and a permission check happening in
   * the dark. Refused here, at the moment somebody can still do something about
   * it — and checked AGAIN by the worker when it fires, because these two
   * moments can be days apart.
   */
  const blockedSchedule = await bob.request("POST", "/api/import", {
    previewId: fixtures.bob.previewId,
    storeIds: [fixtures.bob.storeId],
    scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
  });
  check(
    "a SCHEDULED import is refused by the same switch as an immediate one — 403",
    blockedSchedule.status === 403 && blockedSchedule.json.code === "not_permitted",
    `got ${blockedSchedule.status} ${blockedSchedule.text.slice(0, 200)}`,
  );

  /*
   * Product editing has its OWN switch, and the worst case is why.
   *
   * An import that goes wrong adds products somebody can delete; a bulk edit that
   * goes wrong reprices a catalogue and overwrites the only copy of what the prices
   * were. So an operator can allow one and withhold the other, and both halves are
   * checked here — the single-product route and the bulk one, since a screen that
   * greyed out one button would still leave the other reachable.
   */
  const blockedEdit = await bob.request("POST", "/api/products/update", {
    storeId: fixtures.bob.storeId,
    productId: 1,
    regularPrice: 1000,
  });
  check(
    "product editing switched off is refused by the API — 403",
    blockedEdit.status === 403 && blockedEdit.json.code === "not_permitted",
    `got ${blockedEdit.status} ${blockedEdit.text.slice(0, 200)}`,
  );

  const blockedBulk = await bob.request("POST", "/api/products/bulk", {
    action: "preview",
    storeId: fixtures.bob.storeId,
    selection: { productIds: [1, 2] },
    operation: { kind: "price", operation: "percent", value: -10 },
  });
  check(
    "and a bulk change is refused at the PREVIEW, not only at the run — 403",
    blockedBulk.status === 403 && blockedBulk.json.code === "not_permitted",
    `got ${blockedBulk.status} ${blockedBulk.text.slice(0, 200)}`,
  );

  const blockedPurge = await bob.request("POST", "/api/purge", {
    options: { storeId: fixtures.bob.storeId, selection: { kind: "all", confirm: true } },
    ids: [1],
    confirmPhrase: "DELETE",
  });
  check(
    "removal switched off is refused by the API — 403",
    blockedPurge.status === 403 && blockedPurge.json.code === "not_permitted",
    `got ${blockedPurge.status} ${blockedPurge.text.slice(0, 200)}`,
  );

  const blockedS3 = await bob.request("PUT", "/api/settings/s3", {
    enabled: false,
    accessKeyId: "AKIANOPE",
    secretAccessKey: "",
    bucket: "",
    region: "",
    publicUrl: "",
    prefix: "",
  });
  check(
    "with S3 not allowed, the account cannot even store AWS keys — 403",
    blockedS3.status === 403 && blockedS3.json.code === "not_permitted",
    `got ${blockedS3.status} ${blockedS3.text.slice(0, 200)}`,
  );

  const blockedStore = await bob.request("POST", "/api/stores", {
    url: "https://second.isolation.test",
    apiKey: "second-key",
    apiSecret: "second-secret",
  });
  check(
    "a site over the ceiling is refused — 403",
    blockedStore.status === 403 && blockedStore.json.code === "not_permitted",
    `got ${blockedStore.status} ${blockedStore.text.slice(0, 200)}`,
  );

  // Switch import back on but keep a small per-run ceiling, to prove the SIZE
  // check is separate from the on/off switch.
  await admin.request("PUT", "/api/admin/limits", {
    userId: bobId,
    importEnabled: true,
    removeEnabled: true,
    productEditEnabled: true,
    s3Allowed: true,
    maxStores: 5,
    maxProductsPerRun: 0,
    maxThreads: null,
  });

  const bulkOverCeiling = await bob.request("POST", "/api/products/bulk", {
    action: "preview",
    storeId: fixtures.bob.storeId,
    selection: { productIds: [1, 2, 3] },
    operation: { kind: "status", value: "draft" },
  });
  check(
    "the per-run ceiling applies to a BULK EDIT too, not only to an import — 403",
    bulkOverCeiling.status === 403 && bulkOverCeiling.json.code === "not_permitted",
    `got ${bulkOverCeiling.status} ${bulkOverCeiling.text.slice(0, 200)}`,
  );

  const overCeiling = await bob.request("POST", "/api/import", {
    previewId: fixtures.bob.previewId,
    storeIds: [fixtures.bob.storeId],
  });
  check(
    "a run larger than the per-run ceiling is refused, not trimmed — 403",
    overCeiling.status === 403 && overCeiling.json.code === "not_permitted",
    `got ${overCeiling.status} ${overCeiling.text.slice(0, 200)}`,
  );
  check(
    "and the refusal says what the ceiling is",
    typeof overCeiling.json.error === "string" &&
      (overCeiling.json.error as string).includes("limited to"),
    String(overCeiling.json.error),
  );

  // An account nobody has configured is allowed everything — absent means
  // allowed, so a new customer is never blocked by default.
  const aliceStillWorks = await alice.request("GET", "/api/settings");
  check(
    "an account with no limits set is unaffected",
    aliceStillWorks.status === 200,
    `got ${aliceStillWorks.status}`,
  );

  /* ================================================== LICENSING */

  console.log("\n-- registering needs no key; using anything does --\n");

  await licensing(admin);

  /* ================================================== CSV FORMATS */

  console.log("\n-- the file format is detected, or named by hand --\n");

  await csvFormats(alice, fixtures.alice.storeId);

  /* ================================================== SCHEDULED RUNS */

  console.log("\n-- a scheduled run waits, shows as scheduled, and can be moved or cancelled --\n");

  await scheduling(alice, fixtures.alice);

  /* ================================================== NO-IMAGE FILTER */

  console.log("\n-- the no-image filter is refused on a plugin that would ignore it --\n");

  await noImageFilterGate(alice, fixtures.alice);

  /* ================================================== REPEATING RUNS */

  console.log("\n-- a repeating series is one account's, by id --\n");

  await repeatingRuns(alice, bob, fixtures.alice);

  /* ================================================== NOTIFICATIONS */

  console.log("\n-- the run-finished webhook: per account, secret never read back --\n");

  await webhookSettings(alice, bob);

  /* ================================================== IMAGE LINKS */

  console.log("\n-- image links are checked BEFORE the run, and only the owner's --\n");

  await imageChecks(alice, bob, aliceId);

  console.log(`\n${"-".repeat(50)}\nPassed: ${passed}   Failed: ${failed}`);

  await redis.quit().catch(() => undefined);
  await closeDatabase().catch(() => undefined);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * CSV format detection, through the real preview route with real multipart uploads.
 *
 * The WooCommerce case is the one that matters most: before this change the wizard
 * always sent `dialect: shopify`, so `detectDialect()` never ran and a valid Woo
 * export was read by the Shopify parser and reported two dozen errors about a
 * missing Handle column. That assertion fails on the old code.
 *
 * Driven over HTTP rather than by calling `parseCsv` directly, because the bug was
 * never in the parser — it was in what the request said, and only a request can
 * prove that.
 */
async function csvFormats(client: Client, storeId: string): Promise<void> {
  const options = { ...DEFAULT_IMPORT_OPTIONS, storeId, skipOnCsvError: false };

  /** One preview attempt with a file built in memory. */
  async function preview(
    csv: string,
    filename: string,
    extra: { dialect?: string; columnMap?: Record<string, string> } = {},
  ): Promise<{ status: number; dialect?: string; total?: number; columns?: string[]; error?: string; rows?: Array<Record<string, unknown>> }> {
    const form = new FormData();
    form.set("options", JSON.stringify(options));
    form.set("file", new File([csv], filename, { type: "text/csv" }));
    if (extra.dialect !== undefined) {
      form.set("dialect", extra.dialect);
    }
    if (extra.columnMap !== undefined) {
      form.set("columnMap", JSON.stringify(extra.columnMap));
    }

    // Not through Client.request: that sets a JSON content type, and multipart
    // needs the boundary fetch generates for it.
    const response = await fetch(`${BASE}/api/import/preview`, {
      method: "POST",
      headers: { Origin: BASE, Cookie: client.cookieHeader() },
      body: form,
    });

    const payload = (await response.json()) as {
      preview?: { dialect?: string; total?: number; columns?: string[]; rows?: Array<Record<string, unknown>> };
      error?: string;
      columns?: string[];
    };

    return {
      status: response.status,
      dialect: payload.preview?.dialect,
      total: payload.preview?.total,
      columns: payload.preview?.columns ?? payload.columns,
      rows: payload.preview?.rows,
      error: payload.error,
    };
  }

  const shopify = await preview(
    [
      "Handle,Title,Variant SKU,Variant Price,Published",
      "tee-one,Shopify Tee,SHOP-1,199000,TRUE",
      "tee-two,Shopify Hoodie,SHOP-2,299000,TRUE",
    ].join("\n"),
    "shopify.csv",
  );

  check(
    "a Shopify export is detected as shopify",
    shopify.dialect === "shopify" && shopify.total === 2,
    `dialect=${shopify.dialect} total=${shopify.total} error=${shopify.error}`,
  );

  /*
   * THE REGRESSION TEST. This is the file that used to report 24 errors about a
   * missing Handle column because the wizard forced the Shopify parser on it.
   */
  const woo = await preview(
    [
      "Type,SKU,Name,Regular price,Categories,In stock?",
      "simple,WOO-1,Woo Tee,199000,Clothing > Tees,1",
      "simple,WOO-2,Woo Hoodie,299000,Clothing > Hoodies,1",
    ].join("\n"),
    "woo.csv",
  );

  check(
    "a WooCommerce export is detected as woocommerce, NOT read as Shopify",
    woo.dialect === "woocommerce" && woo.total === 2,
    `dialect=${woo.dialect} total=${woo.total} error=${woo.error}`,
  );

  const etsy = await preview(
    [
      "TITLE,DESCRIPTION,PRICE,QUANTITY,SKU,TAGS,IMAGE1",
      'Etsy Mug,A mug,150000,4,ETSY-1,"gift,mug",https://cdn.test/mug.jpg',
    ].join("\n"),
    "etsy.csv",
  );

  check(
    "an Etsy export is detected as etsy",
    etsy.dialect === "etsy" && etsy.total === 1,
    `dialect=${etsy.dialect} total=${etsy.total} error=${etsy.error}`,
  );

  /* ---- a file nothing recognises ---- */

  const strangeCsv = [
    "Ten san pham,Gia ban,Ma hang,Anh",
    "San pham la,123000,LA-1,https://cdn.test/a.jpg",
    "San pham hai,456000,LA-2,https://cdn.test/b.jpg",
  ].join("\n");

  const unknown = await preview(strangeCsv, "strange.csv");

  check(
    "an unrecognised file is REFUSED rather than guessed at",
    unknown.status === 400,
    `got ${unknown.status} dialect=${unknown.dialect}`,
  );
  check(
    "and the refusal carries the real column list so the mapper can open on it",
    (unknown.columns ?? []).includes("Ten san pham"),
    JSON.stringify(unknown.columns),
  );

  /* ---- ...and the same file read as custom, with the columns named ---- */

  const custom = await preview(strangeCsv, "strange.csv", {
    dialect: "custom",
    columnMap: {
      name: "Ten san pham",
      price: "Gia ban",
      sku: "Ma hang",
      images: "Anh",
    },
  });

  check(
    "the SAME file imports once the columns are mapped as custom",
    custom.dialect === "custom" && custom.total === 2,
    `dialect=${custom.dialect} total=${custom.total} error=${custom.error}`,
  );
  check(
    "and the mapped values actually land on the products",
    custom.rows?.[0]?.name === "San pham la" && String(custom.rows?.[0]?.price) === "123000",
    JSON.stringify(custom.rows?.[0]),
  );

  /* ---- a two-column file: only the name is genuinely required ---- */

  const minimal = await preview(
    ["Product,Cost", "Just a name,50000", "Another,60000"].join("\n"),
    "minimal.csv",
    { dialect: "custom", columnMap: { name: "Product", price: "Cost" } },
  );

  check(
    "a two-column file imports — only the product name is required",
    minimal.dialect === "custom" && minimal.total === 2,
    `dialect=${minimal.dialect} total=${minimal.total} error=${minimal.error}`,
  );

  /* ---- an explicit choice beats detection ---- */

  const forced = await preview(
    [
      "Handle,Title,Variant SKU,Variant Price",
      "tee-one,Forced Tee,FORCE-1,199000",
    ].join("\n"),
    "shopify.csv",
    { dialect: "custom", columnMap: { name: "Title", sku: "Variant SKU", price: "Variant Price" } },
  );

  check(
    "naming a format by hand overrides what detection would have said",
    forced.dialect === "custom",
    `dialect=${forced.dialect} error=${forced.error}`,
  );
}

/**
 * Registration without a key, and a key that runs out.
 *
 * Two properties, and they pull in opposite directions, which is why both are
 * tested against a real server rather than reasoned about:
 *
 *  1. Registering is now OPEN — no key required. That widens who can create a row
 *     in `user`, so the test has to prove the account it creates can do nothing at
 *     all until a key is bound. An open door to an empty room is fine; an open door
 *     is not.
 *  2. A term is counted from ACTIVATION, not from minting. A key minted with one
 *     day must still have a full day when it is redeemed later, and must lock the
 *     account out once that day is gone — on the very next request, not whenever
 *     the session happens to lapse.
 */
async function licensing(admin: Client): Promise<void> {
  const carol = new Client("carol");

  /* ---- registering with no key at all ---- */

  const registered = await carol.request("POST", "/api/register", {
    name: "Carol",
    email: "carol@isolation.test",
    password: SECRETS.password,
    // No licenceKey field whatsoever — not an empty string, absent.
  });

  check(
    "an account can be created with NO licence key",
    registered.status === 201,
    `got ${registered.status} ${registered.text.slice(0, 200)}`,
  );
  check(
    "and it says plainly that a key is still needed",
    registered.json.activated === false && registered.json.needsKey === true,
    JSON.stringify(registered.json),
  );

  /*
   * No explicit sign-in here, deliberately.
   *
   * `POST /api/register` passes the request headers through to better-auth, so the
   * session cookie is already set on the response — the account is signed in the
   * moment it is created. Calling sign-in as well is a redundant request, and
   * better-auth rate-limits authentication: late in a long suite the extra call
   * came back 429 and took the whole run down. Proving the cookie works is also a
   * better assertion than proving sign-in works twice.
   */
  const carolId = await idOf(carol);
  check(
    "registering signs the account in, with no separate sign-in needed",
    carolId !== "",
    carolId,
  );

  /* ---- ...and can do absolutely nothing ---- */

  const lockedOut: Array<[string, string, string]> = [
    ["read its own sites", "GET", "/api/stores"],
    ["read its own runs", "GET", "/api/jobs"],
    ["read its own settings", "GET", "/api/settings"],
    ["connect a site", "POST", "/api/stores"],
    ["start an import", "POST", "/api/import"],
    ["start a removal", "POST", "/api/purge"],
    ["list products", "POST", "/api/products/lookup"],
    ["edit a product", "POST", "/api/products/update"],
    ["change products in bulk", "POST", "/api/products/bulk"],
    ["mint itself a key", "POST", "/api/admin/licenses"],
  ];

  for (const [what, method, path] of lockedOut) {
    // No body on a GET — undici rejects that outright, which is a test bug rather
    // than a finding about the app.
    const result = await carol.request(method, path, method === "GET" ? undefined : {});
    check(
      `an unactivated account cannot ${what} — 403`,
      result.status === 403,
      `got ${result.status} ${result.text.slice(0, 120)}`,
    );
  }

  const stillLocked = await carol.request("GET", "/api/settings");
  check(
    "and the refusal names the licence as the reason, so the screen can act on it",
    stillLocked.json.code === "license_required",
    JSON.stringify(stillLocked.json),
  );

  /* ---- a key with a one-day term ---- */

  const mintedDay = await admin.request("POST", "/api/admin/licenses", {
    count: 1,
    note: "one-day term",
    validDays: 1,
  });

  const dayKey = (mintedDay.json.licenses as Array<{ key: string; validDays: number | null; expiresAt: string | null }>)?.[0];

  check(
    "an administrator can mint a key with a term in days",
    mintedDay.status === 201 && dayKey?.validDays === 1,
    JSON.stringify(mintedDay.json).slice(0, 200),
  );
  check(
    "the term is NOT yet a deadline — nothing counts down before it is redeemed",
    dayKey?.expiresAt === null,
    `expiresAt=${dayKey?.expiresAt}`,
  );

  /* ---- redeeming it starts the clock ---- */

  const activatedAt = Date.now();
  const activation = await carol.request("POST", "/api/license/activate", { key: dayKey.key });

  check(
    "the account can activate the key itself",
    activation.status === 200 && activation.json.activated === true,
    `got ${activation.status} ${activation.text.slice(0, 200)}`,
  );

  const expiresAt = activation.json.expiresAt as string | null;

  check(
    "activation reports when the licence now runs out",
    typeof expiresAt === "string",
    String(expiresAt),
  );

  if (typeof expiresAt === "string") {
    const ahead = new Date(expiresAt).getTime() - activatedAt;
    const oneDay = 24 * 60 * 60 * 1000;
    check(
      "the deadline is one day from ACTIVATION, not from minting",
      Math.abs(ahead - oneDay) < 60_000,
      `${Math.round(ahead / 1000)}s ahead, expected ~${oneDay / 1000}s`,
    );
  }

  const nowWorks = await carol.request("GET", "/api/settings");
  check(
    "with the key activated the account works",
    nowWorks.status === 200,
    `got ${nowWorks.status} ${nowWorks.text.slice(0, 120)}`,
  );

  /* ---- and when it runs out, the door shuts again ---- */

  // Straight into Postgres: waiting a day is not a test. What is under test is
  // that the guard re-derives access from `expires_at` on every request, so
  // moving the deadline into the past must be enough on its own.
  await db
    .update(licenseKeys)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(licenseKeys.key, dayKey.key));

  const afterExpiry = await carol.request("GET", "/api/settings");
  check(
    "an expired licence locks the account out on the very NEXT request",
    afterExpiry.status === 403 && afterExpiry.json.code === "license_required",
    `got ${afterExpiry.status} ${afterExpiry.text.slice(0, 120)}`,
  );

  const reuse = await carol.request("POST", "/api/license/activate", { key: dayKey.key });
  check(
    "and re-entering the same expired key does not revive it",
    reuse.status === 400,
    `got ${reuse.status} ${reuse.text.slice(0, 160)}`,
  );

  /* ---- a member cannot give themselves a term ---- */

  const memberMints = await carol.request("POST", "/api/admin/licenses", {
    count: 1,
    validDays: 3650,
  });
  check(
    "a member cannot mint themselves a ten-year key",
    memberMints.status === 403,
    `got ${memberMints.status}`,
  );
}

/**
 * Scheduled runs, end to end through HTTP — everything except actually firing.
 *
 * The firing itself needs a worker and lives in tests/cancel.sh, which has one.
 * What is here is the part reachable from a browser: that a scheduled run is
 * DISTINGUISHABLE from a queued one on every screen that reads the snapshot, that
 * it can be moved, and that cancelling one while it waits still works — the last
 * of these being a path that already existed and had to survive.
 */
async function scheduling(
  client: Client,
  fixture: { storeId: string; previewId: string },
): Promise<void> {
  const dueAt = new Date(Date.now() + 6 * 60 * 60 * 1000);

  const created = await client.request("POST", "/api/import", {
    previewId: fixture.previewId,
    storeIds: [fixture.storeId],
    scheduledFor: dueAt.toISOString(),
  });

  const scheduledId = (created.json.jobs as Array<{ id: string }> | undefined)?.[0]?.id;

  check(
    "a run can be scheduled for later",
    created.status === 202 && typeof scheduledId === "string",
    `got ${created.status} ${created.text.slice(0, 200)}`,
  );

  if (scheduledId === undefined) {
    return;
  }

  const state = await getJobState(scheduledId);

  check(
    "it carries the time it is due",
    state?.scheduledFor !== null,
    `scheduledFor=${state?.scheduledFor}`,
  );

  /*
   * The status column keeps its original five members and `queued` is one of
   * them. Adding a sixth would have meant every `switch` on status across the
   * status bar, the dashboard, `computeStats` and the Activity filters either
   * handling it or failing at runtime — so "scheduled" is DERIVED from the
   * timestamp. This asserts both halves of that decision at once.
   */
  check(
    "the stored status is still one of the original five",
    state?.status === "queued",
    `status=${state?.status}`,
  );
  check(
    "but it is derived as scheduled, so no screen shows it as merely queued",
    state !== null && isScheduled(state),
  );

  const snapshot = await client.request("GET", "/api/jobs");
  const buckets = snapshot.json as {
    scheduled?: Array<{ id: string }>;
    queued?: Array<{ id: string }>;
  };

  check(
    "the snapshot puts it in the scheduled bucket",
    (buckets.scheduled ?? []).some((job) => job.id === scheduledId),
    JSON.stringify((buckets.scheduled ?? []).map((job) => job.id)),
  );
  check(
    "and NOT also in the queued bucket — a double count would inflate the status bar",
    !(buckets.queued ?? []).some((job) => job.id === scheduledId),
    JSON.stringify((buckets.queued ?? []).map((job) => job.id)),
  );

  // Moving it.
  const movedTo = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const moved = await client.request("PATCH", `/api/jobs/${scheduledId}/schedule`, {
    scheduledFor: movedTo.toISOString(),
  });

  check(
    "a scheduled run can be moved to a different time",
    moved.status === 200,
    `got ${moved.status} ${moved.text.slice(0, 200)}`,
  );
  check(
    "and the run records the new time",
    (await getJobState(scheduledId))?.scheduledFor === movedTo.toISOString(),
    `${(await getJobState(scheduledId))?.scheduledFor} vs ${movedTo.toISOString()}`,
  );

  const tooFar = await client.request("PATCH", `/api/jobs/${scheduledId}/schedule`, {
    scheduledFor: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString(),
  });
  check(
    "a year ahead is refused as a mistake rather than a plan — 400",
    tooFar.status === 400,
    `got ${tooFar.status} ${tooFar.text.slice(0, 200)}`,
  );

  // Cancelling while it waits. This path already existed — `requestCancel`
  // removes a `delayed` job — and it had to survive the rewrite.
  const cancelled = await client.request("POST", `/api/jobs/${scheduledId}/cancel`);
  check(
    "a scheduled run can be cancelled while it waits",
    cancelled.status === 200,
    `got ${cancelled.status} ${cancelled.text.slice(0, 200)}`,
  );

  const afterCancel = await getJobState(scheduledId);
  check(
    "and it settles as cancelled immediately, because it never started",
    afterCancel?.status === "cancelled",
    `status=${afterCancel?.status}`,
  );
  check(
    "a run that never started carries no stop warning — there is nothing uncertain",
    afterCancel?.error === null,
    String(afterCancel?.error),
  );

  const reschedulingSettled = await client.request(
    "PATCH",
    `/api/jobs/${scheduledId}/schedule`,
    { scheduledFor: new Date(Date.now() + 3_600_000).toISOString() },
  );
  check(
    "a cancelled run's schedule can no longer be changed — 409",
    reschedulingSettled.status === 409,
    `got ${reschedulingSettled.status} ${reschedulingSettled.text.slice(0, 200)}`,
  );
}

/** The signed-in account's id, read back through the app rather than assumed. */
async function idOf(client: Client): Promise<string> {
  const session = await client.request("GET", "/api/auth/get-session");
  const user = session.json.user as { id?: string } | undefined;

  if (!user?.id) {
    throw new Error(`could not read the session for ${client.label}: ${session.text.slice(0, 200)}`);
  }

  return user.id;
}

/**
 * One of everything, owned by one account.
 *
 * Built through the lib layer: creating rows is not what is under test, and
 * going through HTTP for the fixture would need a live WooCommerce site for the
 * run and a CSV upload for the preview.
 */
async function fixturesFor(
  ownerId: string,
  label: string,
  siteSecret: string,
  s3Secret: string,
  bucket: string,
): Promise<{ storeId: string; jobId: string; presetId: string; previewId: string }> {
  const store = await createStore(ownerId, {
    url: `https://${label}.isolation.test`,
    pin: "",
    apiKey: `${label}-api-key`,
    apiSecret: siteSecret,
    urlRewrite: false,
    baseUrlOverride: "",
    label,
  });

  await saveS3(ownerId, {
    enabled: true,
    accessKeyId: `AKIA${label.toUpperCase()}`,
    secretAccessKey: s3Secret,
    bucket,
    region: "ap-southeast-1",
    publicUrl: "",
    prefix: "",
  });

  // Queued and left that way: no worker runs in this suite, which is what makes
  // "cancel" a meaningful thing to try.
  const job = await enqueueJob({
    storeId: store.id,
    storeUrl: store.url,
    storeLabel: label,
    sourceLabel: `${label}-fixture.csv`,
    createdBy: ownerId,
    options: { ...DEFAULT_IMPORT_OPTIONS, storeId: store.id },
    items: [{ name: `${label} product`, sku: `${label.toUpperCase()}-1` }],
  });

  const preset = await savePreset(`${label} preset`, DEFAULT_IMPORT_OPTIONS, ownerId);

  /*
   * Inserted directly rather than through `lib/preview.ts`.
   *
   * That module opens with `import "server-only"`, which throws the moment it
   * is required outside a React Server Component — so a plain Node script
   * cannot call `savePreview` at all. Relaxing that guard to suit a fixture
   * would weaken a real protection for no benefit: what is under test here is
   * the READ path, `GET /api/import/preview/[id]`, which runs inside the server
   * where the guard belongs.
   */
  const previewId = randomUUID();

  await db.insert(previews).values({
    id: previewId,
    createdBy: ownerId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    meta: {
      id: previewId,
      createdAt: new Date().toISOString(),
      sourceLabel: `${label}.csv`,
      dialect: null,
      columns: ["name", "sku"],
      signature: null,
      options: { ...DEFAULT_IMPORT_OPTIONS, storeId: store.id },
      total: 1,
      images: 0,
      warnings: [],
      errors: [],
      skippedRows: 0,
      duplicateSkus: [],
      rows: [],
    },
    products: [{ name: `${label} product`, sku: `${label.toUpperCase()}-1` }],
  });

  return { storeId: store.id, jobId: job.id, presetId: preset.id, previewId };
}

/**
 * "Products with no image", and the version gate that has to stand in front of it.
 *
 * The danger is specific and it is not hypothetical: a plugin older than 3.7.0 does
 * not REFUSE `without_images`, it ignores it. So a site on an older build would answer
 * with the whole catalogue, the screen would present that as "products with no
 * picture", and the next press deletes them. The gate is the only thing between those
 * two moments, so it is asserted rather than assumed.
 *
 * The fixture store has never had a health check, so its plugin version is unknown —
 * which is its own refusal, and the right one: a filter that might be ignored is not
 * a filter to guess about.
 */
async function noImageFilterGate(
  alice: Client,
  fixture: { storeId: string },
): Promise<void> {
  const refused = await alice.request("POST", "/api/purge/lookup", {
    storeId: fixture.storeId,
    selection: { kind: "all", confirm: true },
    withoutImages: true,
  });

  check(
    "asking for products with no image is REFUSED when the plugin build is unknown",
    refused.status === 502,
    `status=${refused.status} ${JSON.stringify(refused.json).slice(0, 200)}`,
  );
  check(
    "and the refusal says WHY — that an older build ignores the filter rather than refusing it",
    /ignore/i.test(JSON.stringify(refused.json)) && JSON.stringify(refused.json).includes("3.7.0"),
    JSON.stringify(refused.json).slice(0, 300),
  );
  /*
   * Asserted on the SHAPE, not on a substring.
   *
   * The first version of this looked for the word "products" anywhere in the JSON and
   * failed the moment the refusal explained itself in a sentence containing it — a
   * test that broke on prose rather than on behaviour. What matters is that no product
   * DATA came back, so that is what is checked: the body carries a reason and nothing
   * else.
   */
  const refusedKeys = Object.keys((refused.json ?? {}) as Record<string, unknown>).sort();

  check(
    "it answers with a reason and no product data at all",
    refusedKeys.every((key) => key === "error" || key === "code") &&
      refusedKeys.includes("error"),
    `keys=${JSON.stringify(refusedKeys)}`,
  );

  // WITHOUT the filter the same request gets as far as the site — which is what shows
  // the gate is about this filter and not about the whole screen.
  const ordinary = await alice.request("POST", "/api/purge/lookup", {
    storeId: fixture.storeId,
    selection: { kind: "all", confirm: true },
  });

  check(
    "the same selection without the filter is NOT refused by the gate — it reaches the site",
    ordinary.status !== 502 ||
      !JSON.stringify(ordinary.json).includes("no image"),
    `status=${ordinary.status} ${JSON.stringify(ordinary.json).slice(0, 200)}`,
  );

  /*
   * The case the gate exists for, rather than the easy one.
   *
   * A KNOWN older build: 3.6.0 passes the product screen's own 3.2.0 requirement and
   * fails this one — which is the only way to see that the two gates are separate and
   * that the newer filter is what is being refused. Written straight to the row,
   * because the alternative is standing up a second fake site running a 3.6.0 plugin.
   */
  await db
    .update(stores)
    .set({ pluginVersion: "3.6.0" })
    .where(eq(stores.id, fixture.storeId));

  const older = await alice.request("POST", "/api/products/lookup", {
    storeId: fixture.storeId,
    withoutImages: true,
  });

  check(
    "a site on a KNOWN older build is refused, with the version it needs named",
    older.status === 502 && JSON.stringify(older.json).includes("3.7.0"),
    `status=${older.status} ${JSON.stringify(older.json).slice(0, 250)}`,
  );
  check(
    "and the refusal explains that an older build ignores the filter rather than refusing it",
    /ignore/i.test(JSON.stringify(older.json)),
    JSON.stringify(older.json).slice(0, 250),
  );

  // Left as it was found: a later phase reading this store must not inherit a version
  // this phase invented.
  await db
    .update(stores)
    .set({ pluginVersion: null })
    .where(eq(stores.id, fixture.storeId));
}

/**
 * §6 C2 — a repeating series, and the isolation that has to hold for it.
 *
 * A series carries a staged catalogue and publishes it to a site on a cadence, which
 * makes it one of the more dangerous things an account owns: taking somebody else's
 * over would mean writing to their shop on a timer. So the same rule as every other
 * `[id]` route — another account gets **404, never 403** — and it is asserted by id
 * rather than only by what the list returns, because the list filter and the
 * ownership check are two different bugs.
 */
async function repeatingRuns(
  alice: Client,
  bob: Client,
  fixture: { storeId: string; previewId: string },
): Promise<void> {
  const created = await alice.request("POST", "/api/schedules", {
    previewId: fixture.previewId,
    storeId: fixture.storeId,
    everyMinutes: 1440,
  });

  const schedule = (created.json as { schedule?: { id?: string; nextJobId?: string | null } })
    .schedule;

  check(
    "an account can set up a repeating run from its own staged preview",
    created.status === 201 && typeof schedule?.id === "string",
    `status=${created.status} ${JSON.stringify(created.json).slice(0, 200)}`,
  );

  if (schedule?.id === undefined) {
    return;
  }

  check(
    "and it comes with an occurrence already waiting",
    typeof schedule.nextJobId === "string",
    JSON.stringify(schedule).slice(0, 200),
  );

  const mine = await alice.request("GET", "/api/schedules");
  const theirs = await bob.request("GET", "/api/schedules");

  check(
    "it is in the owner's list",
    JSON.stringify(mine.json).includes(schedule.id),
    JSON.stringify(mine.json).slice(0, 200),
  );
  check(
    "and not in anybody else's",
    !JSON.stringify(theirs.json).includes(schedule.id),
    JSON.stringify(theirs.json).slice(0, 200),
  );

  /* ---- by id, which is the half a pasted URL reaches ---- */

  for (const [what, method, body] of [
    ["read", "GET", undefined],
    ["pause", "PATCH", { paused: true }],
    ["delete", "DELETE", undefined],
  ] as const) {
    const answer = await bob.request(method, `/api/schedules/${schedule.id}`, body);

    check(
      `B cannot ${what} another account's repeating series — 404, never 403`,
      answer.status === 404,
      `status=${answer.status} ${JSON.stringify(answer.json).slice(0, 160)}`,
    );
  }

  const stillThere = await alice.request("GET", `/api/schedules/${schedule.id}`);

  check(
    "and none of that touched it",
    stillThere.status === 200 &&
      ((stillThere.json as { schedule?: { paused?: boolean } }).schedule ?? {}).paused === false,
    `status=${stillThere.status} ${JSON.stringify(stillThere.json).slice(0, 200)}`,
  );

  /* ---- the owner's own controls ---- */

  const paused = await alice.request("PATCH", `/api/schedules/${schedule.id}`, { paused: true });

  check(
    "the owner can pause it, and the occurrence it had waiting is let go",
    paused.status === 200 &&
      ((paused.json as { schedule?: { paused?: boolean; nextJobId?: string | null } }).schedule ?? {})
        .paused === true &&
      ((paused.json as { schedule?: { nextJobId?: string | null } }).schedule ?? {}).nextJobId ===
        null,
    JSON.stringify(paused.json).slice(0, 200),
  );

  const gone = await alice.request("DELETE", `/api/schedules/${schedule.id}`);

  check("and delete it", gone.status === 200, `status=${gone.status}`);
  check(
    "after which it is not there for anybody, including the owner",
    (await alice.request("GET", `/api/schedules/${schedule.id}`)).status === 404,
  );
}

/**
 * §6 C3 — where an account is told a run has finished.
 *
 * Three properties, and the third is the one only an HTTP test can see: the URL is
 * checked against the same policy the image links are, because it is a string a
 * CUSTOMER typed and "make the server POST to this" is the whole of an SSRF.
 */
async function webhookSettings(alice: Client, bob: Client): Promise<void> {
  const secret = "alice-webhook-secret-R2vT8x";

  const saved = await alice.request("PUT", "/api/settings/webhook", {
    url: "https://hooks.example.test/alice",
    secret,
    failuresOnly: true,
  });

  check(
    "an account can set its own run-finished webhook",
    saved.status === 200,
    `status=${saved.status} ${JSON.stringify(saved.json).slice(0, 200)}`,
  );

  const read = await alice.request("GET", "/api/settings/webhook");
  const webhook = (read.json as { webhook?: Record<string, unknown> }).webhook ?? {};

  check(
    "reading it back says a secret is SET without saying what it is",
    webhook.secretConfigured === true && !JSON.stringify(read.json).includes(secret),
    JSON.stringify(read.json).slice(0, 200),
  );
  check(
    "and the URL and the switch come back as they were saved",
    webhook.url === "https://hooks.example.test/alice" && webhook.failuresOnly === true,
    JSON.stringify(webhook),
  );

  // Empty secret means "keep the stored one" — the form can be re-saved without
  // anybody retyping a secret they cannot read.
  await alice.request("PUT", "/api/settings/webhook", {
    url: "https://hooks.example.test/alice",
    secret: "",
    failuresOnly: false,
  });

  const kept = await alice.request("GET", "/api/settings/webhook");

  check(
    "re-saving with an empty secret keeps the stored one rather than clearing it",
    ((kept.json as { webhook?: { secretConfigured?: boolean } }).webhook ?? {})
      .secretConfigured === true,
    JSON.stringify(kept.json).slice(0, 200),
  );

  /*
   * The URL is a string a customer typed, so it gets the same treatment a CSV's
   * image link gets. Refused at SAVE time, which is where somebody can still act on
   * the answer.
   */
  const privateHost = await alice.request("PUT", "/api/settings/webhook", {
    url: "http://169.254.169.254/latest/meta-data/",
    secret: "",
    failuresOnly: false,
  });

  check(
    "a webhook aimed at a private or link-local address is REFUSED when it is saved",
    privateHost.status === 400,
    `status=${privateHost.status} ${JSON.stringify(privateHost.json).slice(0, 200)}`,
  );
  check(
    "with a reason that names the host rather than a validation code",
    JSON.stringify(privateHost.json).includes("169.254.169.254"),
    JSON.stringify(privateHost.json).slice(0, 200),
  );

  const scheme = await alice.request("PUT", "/api/settings/webhook", {
    url: "file:///etc/passwd",
    secret: "",
    failuresOnly: false,
  });

  check(
    "and so is a scheme that is not http or https",
    scheme.status === 400,
    `status=${scheme.status} ${JSON.stringify(scheme.json).slice(0, 200)}`,
  );

  /* ---- and it is one account's setting, not the installation's ---- */

  const strangers = await bob.request("GET", "/api/settings/webhook");
  const bobWebhook = (strangers.json as { webhook?: { url?: string } }).webhook ?? {};

  check(
    "another account's webhook is its own — empty, not A's",
    strangers.status === 200 && bobWebhook.url === "",
    JSON.stringify(strangers.json).slice(0, 200),
  );

  // Left off, so the notification does not fire during the rest of this suite.
  await alice.request("PUT", "/api/settings/webhook", {
    url: "",
    secret: "",
    failuresOnly: false,
  });
}

/**
 * §6 C4 — the image links, asked about before anything is written.
 *
 * A dead image URL is currently discovered halfway through a run: the products are
 * already being created, and the operator finds out from the log. One request per
 * DISTINCT link at the preview step catches it while there is still a decision to
 * make.
 *
 * Four outcomes have to be told apart, and three of them look the same to code
 * that only asks whether the request succeeded — which is why the fixture serves
 * one of each:
 *
 *   a live link, a 404, a 418, and a 200 that answers with a PAGE rather than an
 *   image. The last one is the case that fools a naive check, and it is a real
 *   shape: a CDN that answers "not found" with a styled HTML page and status 200.
 *
 * A fifth outcome has nothing to do with the host: a URL pointing at a private
 * address is refused WITHOUT being fetched. The links come out of a customer's
 * CSV, so this route would otherwise take arbitrary strings from an untrusted file
 * and make the server fetch them.
 */
async function imageChecks(alice: Client, bob: Client, aliceId: string): Promise<void> {
  const host = process.env.IMAGE_HOST ?? "http://tsd-iso-images:8090";

  const previewId = randomUUID();

  // Six links across three products, one of them REPEATED — so "distinct" is a
  // claim the test can check rather than a word in the response.
  const products = [
    {
      name: "Image probe A",
      sku: "IMG-A",
      images: [`${host}/ok.jpg`, `${host}/missing.jpg`],
    },
    {
      name: "Image probe B",
      sku: "IMG-B",
      // ok.jpg again: one image used by two products is one link to check.
      images: [`${host}/ok.jpg`, `${host}/page.html`, `${host}/teapot.jpg`],
    },
    {
      name: "Image probe C",
      sku: "IMG-C",
      images: ["http://127.0.0.1:9/private.jpg"],
    },
  ];

  await db.insert(previews).values({
    id: previewId,
    createdBy: aliceId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    meta: {
      id: previewId,
      createdAt: new Date().toISOString(),
      sourceLabel: "images.csv",
      dialect: null,
      columns: ["name", "sku", "images"],
      signature: null,
      options: DEFAULT_IMPORT_OPTIONS,
      total: products.length,
      images: 5,
      warnings: [],
      errors: [],
      skippedRows: 0,
      duplicateSkus: [],
      rows: [],
    },
    products,
  });

  const answer = await alice.request("POST", "/api/import/images", { previewId });
  const body = answer.json as {
    distinct?: number;
    checked?: number;
    ok?: number;
    warned?: number;
    failed?: number;
    truncated?: boolean;
    results?: Array<{ url: string; verdict: string; status: number | null }>;
  };

  check(
    "the owner can check their own file's image links",
    answer.status === 200,
    `status=${answer.status} ${JSON.stringify(body).slice(0, 200)}`,
  );

  check(
    "the six links across three products are five DISTINCT links",
    body.distinct === 5,
    `distinct=${body.distinct}`,
  );
  check(
    "all five were checked, and it says so rather than leaving it to be assumed",
    body.checked === 5 && body.truncated === false,
    `checked=${body.checked} truncated=${body.truncated}`,
  );
  check(
    "one link is fine",
    body.ok === 1,
    `ok=${body.ok} results=${JSON.stringify(body.results ?? []).slice(0, 400)}`,
  );

  const byUrl = new Map((body.results ?? []).map((result) => [result.url, result]));

  check(
    "the 404 is reported as a dead link, with its status",
    byUrl.get(`${host}/missing.jpg`)?.verdict === "not_found" &&
      byUrl.get(`${host}/missing.jpg`)?.status === 404,
    JSON.stringify(byUrl.get(`${host}/missing.jpg`)),
  );
  check(
    "the 418 is reported as a refusal rather than as a dead link",
    byUrl.get(`${host}/teapot.jpg`)?.verdict === "refused" &&
      byUrl.get(`${host}/teapot.jpg`)?.status === 418,
    JSON.stringify(byUrl.get(`${host}/teapot.jpg`)),
  );
  check(
    "the 200 that answers with a PAGE is not called fine — the case a naive check misses",
    byUrl.get(`${host}/page.html`)?.verdict === "not_an_image" &&
      byUrl.get(`${host}/page.html`)?.status === 200,
    JSON.stringify(byUrl.get(`${host}/page.html`)),
  );
  check(
    "a link pointing at a private address is refused WITHOUT being fetched",
    byUrl.get("http://127.0.0.1:9/private.jpg")?.verdict === "blocked",
    JSON.stringify(byUrl.get("http://127.0.0.1:9/private.jpg")),
  );
  check(
    "two links failed and one is only a warning, counted apart",
    body.failed === 3 && body.warned === 1,
    `failed=${body.failed} warned=${body.warned}`,
  );
  check(
    "the successful link is not listed — the list is what needs attention",
    !byUrl.has(`${host}/ok.jpg`),
    JSON.stringify([...byUrl.keys()]),
  );

  /* ---- the cap says both numbers rather than presenting a page as everything ---- */

  const capped = await alice.request("POST", "/api/import/images", { previewId, limit: 2 });
  const cappedBody = capped.json as {
    distinct?: number;
    checked?: number;
    truncated?: boolean;
  };

  check(
    "a capped check reports how many links there ARE as well as how many it read",
    capped.status === 200 &&
      cappedBody.distinct === 5 &&
      cappedBody.checked === 2 &&
      cappedBody.truncated === true,
    JSON.stringify(cappedBody),
  );

  /* ---- and the isolation, which is why this suite exists ---- */

  const stranger = await bob.request("POST", "/api/import/images", { previewId });

  check(
    "another account gets 404 for a preview that is not theirs, never 403",
    stranger.status === 404,
    `status=${stranger.status} ${JSON.stringify(stranger.json).slice(0, 200)}`,
  );
  check(
    "and the refusal tells them nothing about the file",
    !JSON.stringify(stranger.json).includes("IMG-A") &&
      !JSON.stringify(stranger.json).includes("distinct"),
    JSON.stringify(stranger.json).slice(0, 200),
  );
}

void main().catch(async (error) => {
  console.error(error);
  await redis.quit().catch(() => undefined);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
