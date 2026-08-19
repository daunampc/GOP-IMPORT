import {
  bigserial,
  boolean,
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres is the system of record for GOP_IMPORT.
 *
 * Redis keeps exactly two things now: the BullMQ queue, and the per-job cancel
 * flag. Everything durable — accounts, licence keys, stores, settings, jobs,
 * per-row results, batch timings — lives here, so flushing Redis loses a queue
 * position and nothing else.
 *
 * The auth tables (user/session/account/verification) are declared here rather
 * than left to better-auth's own migrator on purpose: one schema file and one
 * migration path beats two systems racing to create tables in the same database.
 *
 * ---------------------------------------------------------------------------
 * Every account owns its own everything.
 *
 * An account is a customer account at a shop: its connected sites, its runs, its
 * settings, its Amazon S3 credentials, its presets and its remembered column
 * maps belong to it and to nobody else. So every business table below carries an
 * owner column, and it is NOT NULL — a nullable owner is a row that belongs to
 * everyone, which is the same thing as a row that leaks.
 *
 * `on delete cascade` on every one of them: an account that leaves does not
 * leave sites and runs behind, owned by nobody.
 *
 * Deliberately NOT per-account:
 *  - `license_key`, minted by administrators for people who do not have an
 *    account yet, so it cannot belong to the account that will claim it;
 *  - `secret_reveal`, which is the operator's record of an administrator's
 *    action rather than any customer's data — see the table itself;
 *  - the four better-auth tables.
 *
 * The isolation is between customers. It is not between a customer and the
 * operator: an administrator reads and writes every account's data through the
 * explicitly named cross-account entry points in `lib/`, never through a
 * boolean threaded into the ordinary path.
 */

/* ------------------------------------------------------------------ accounts */

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),

  /**
   * The first account ever created becomes `admin`. Someone has to be able to
   * mint the first licence key, and a key cannot be required to create the
   * account that mints keys.
   */
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),

  /** Set when a licence key is activated. Null means the app stays locked. */
  licenseKeyId: text("license_key_id"),

  disabledAt: timestamp("disabled_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("session_user_idx").on(table.userId)],
);

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** bcrypt/scrypt hash for the email+password provider. Never a plain secret. */
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("account_user_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/* ------------------------------------------------------------------ licences */

export const licenseKeys = pgTable(
  "license_key",
  {
    id: text("id").primaryKey(),
    /** Shown to humans, e.g. GOP-4F2A-9C1D-7B33. Unique and case-normalised. */
    key: text("key").notNull().unique(),
    note: text("note").notNull().default(""),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    /** A key binds to exactly one account the moment it is used. */
    activatedBy: text("activated_by").references(() => users.id, { onDelete: "set null" }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),

    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /**
     * How long the key lasts ONCE ACTIVATED, in days. Null means it never expires.
     *
     * A duration rather than a deadline, and the difference is the whole point:
     * an administrator mints a batch of "30-day keys" in advance to sell, and a
     * key that sits unredeemed for three weeks must not arrive with three weeks
     * already spent. Nothing counts down until somebody redeems it.
     *
     * This is a term NOT YET APPLIED. It becomes `expires_at` exactly once, in
     * the same transaction that binds the key to an account — see
     * `activateLicense()`.
     */
    validDays: integer("valid_days"),

    /**
     * When the key actually dies. Null means it never does.
     *
     * THE single source of truth for "is this key still good", and the only one of
     * the two columns any access decision reads — which is why the two can never
     * disagree. `valid_days` decides what this becomes; once set, this is what
     * counts.
     *
     * Still settable directly, which is what lets an administrator issue a key
     * that expires on a fixed date regardless of when it is redeemed.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [index("license_activated_idx").on(table.activatedBy)],
);

/* -------------------------------------------------------------------- stores */

/**
 * A site one account has connected.
 *
 * Two accounts may connect the SAME WooCommerce site. Each holds its own row
 * with its own API key and secret, and the plugin authenticates per key — so
 * there is deliberately no unique index on `url`, and revoking one account's key
 * on the site does not touch the other's.
 */
export const stores = pgTable(
  "store",
  {
    id: text("id").primaryKey(),

    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    label: text("label").notNull().default(""),
    url: text("url").notNull(),
    pin: text("pin").notNull().default(""),
    apiKey: text("api_key").notNull(),
    /** AES-256-GCM. Never leaves the server except through one named admin action. */
    apiSecretEncrypted: text("api_secret_encrypted").notNull(),
    urlRewrite: boolean("url_rewrite").notNull().default(false),
    baseUrlOverride: text("base_url_override").notNull().default(""),

    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),

    /** Everything the plugin's /health route reports, kept whole. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastCheckOk: boolean("last_check_ok"),
    lastCheckMessage: text("last_check_message"),
    lastCheckMs: integer("last_check_ms"),
    pluginVersion: text("plugin_version"),
    phpVersion: text("php_version"),
    mysqlVersion: text("mysql_version"),
    tablePrefix: text("table_prefix"),
    siteUrl: text("site_url"),
    missingFunctions: jsonb("missing_functions").$type<string[]>().notNull().default([]),
  },
  // The Sites screen is exactly this query: one account's sites, newest
  // connection first.
  (table) => [index("store_owner_idx").on(table.ownerId, table.connectedAt)],
);

export const storeChecks = pgTable(
  "store_check",
  {
    id: text("id").primaryKey(),
    storeId: text("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    elapsedMs: integer("elapsed_ms").notNull(),
    version: text("version"),
    message: text("message").notNull(),
  },
  (table) => [index("store_check_store_idx").on(table.storeId, table.at)],
);

/* ---------------------------------------------------------------------- jobs */

/**
 * One table for both kinds of run.
 *
 * `import` and `purge` share every column that matters — target store, status,
 * counters, timing, per-row results — and splitting them would mean two of
 * everything downstream: two queues, two progress screens, two result tables.
 */
export const jobs = pgTable(
  "job",
  {
    id: text("id").primaryKey(),
    /**
     * `update` is a real third member rather than something derived.
     *
     * Contrast with "scheduled", which is deliberately DERIVED from
     * `scheduled_for` precisely so no screen switching on status could break. Here
     * there is no existing column from which "this run rewrote products that
     * already existed" could be inferred, so it has to be stored.
     *
     * A WARNING FOR WHOEVER ADDS A FOURTH. Adding this member did NOT produce a
     * single compile error, and it was expected to: every screen tests
     * `kind === "purge"` and treats everything else as an import, so a bulk edit
     * silently rendered as an import and would have printed "Created" over a
     * product it had merely repriced. The call sites had to be found with grep. The
     * fix was `JOB_KIND_LABELS` in `lib/job-display.ts` — a record keyed by
     * `JobKind`, which a new member DOES break at compile time. Add to that record,
     * and the badges follow.
     *
     * A TS-level enum, not a Postgres one, so adding a member needs no migration.
     */
    kind: text("kind", { enum: ["import", "purge", "update"] }).notNull().default("import"),

    storeId: text("store_id").references(() => stores.id, { onDelete: "set null" }),
    /** Copied at creation so history survives the store being removed. */
    storeUrl: text("store_url").notNull(),
    storeLabel: text("store_label").notNull(),

    /**
     * The account this run belongs to. NOT NULL and cascading.
     *
     * Not null because a run owned by nobody is a run every account can see, and
     * because it makes forgetting to record the owner a type error at the
     * creation site rather than a silent leak months later.
     *
     * A retry inherits the ORIGINAL run's owner, not the caller's: an
     * administrator resending a member's failed rows must leave the run — and
     * the S3 bucket the worker will use for it — in the member's account.
     */
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    sourceLabel: text("source_label").notNull(),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),

    total: integer("total").notNull().default(0),
    processed: integer("processed").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    /** Rows the plugin answered with `deduplicated: true` — already present. */
    deduplicated: integer("deduplicated").notNull().default(0),

    batches: integer("batches").notNull().default(0),
    batchesDone: integer("batches_done").notNull().default(0),
    /** Sum of the plugin's own `elapsed_ms`, across batches that ran in parallel. */
    pluginElapsedMs: real("plugin_elapsed_ms").notNull().default(0),

    /** Same click aimed at several stores shares a group id. */
    groupId: text("group_id"),
    /** Set when this run was created from another run's failed rows. */
    retryOf: text("retry_of"),

    options: jsonb("options").$type<Record<string, unknown>>().notNull(),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    /**
     * When somebody asked this run to stop. THE durable cancel record.
     *
     * This replaces the Redis cancel flag entirely, and the reason is that the
     * flag and this table could disagree. The flag was deleted by `finishJob()`
     * at the exact moment a cancelled run finished, so a BullMQ redelivery
     * afterwards found no flag and ran the whole payload again; and a cancel
     * that raced a finishing run left a flag with a 24-hour TTL that would
     * cancel an unrelated future redelivery of that id for no reason. Both bugs
     * are the same bug: two records of one fact, in two stores, with different
     * lifetimes.
     *
     * `lib/redis.ts` used to argue that a per-batch database round trip would be
     * "pure waste". It is not: a batch is up to 50 products over HTTP measured
     * in seconds, and this is one indexed primary-key lookup against a
     * connection that is already open. What it buys is that the cancel record
     * lives exactly as long as the run does, cascades with it, and is visible to
     * every screen without a second source of truth.
     *
     * Distinct from `status = 'cancelled'`: this is "stop was ASKED for", which
     * is what a lane reads between batches, and it is what lets the interface
     * honestly say "cancelling" while a lane finishes the batch already in
     * flight. The status becomes `cancelled` when the run actually stops.
     */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),

    /**
     * How the stop was asked for: gracefully, or immediately.
     *
     * `cancel` stops at the next batch boundary and lets an in-flight request
     * run to its deadline — no product is cut off mid-write. `stop` aborts the
     * in-flight request there and then, which is the only thing that helps a run
     * wedged in a request the site will never answer.
     *
     * Recorded rather than inferred because the two make different promises to
     * the operator, and after the fact the results table cannot tell you which
     * one they pressed.
     */
    cancelMode: text("cancel_mode", { enum: ["cancel", "stop"] }),

    /**
     * When a scheduled run is due to fire. Null for anything started now.
     *
     * A TIMESTAMP RATHER THAN A NEW `status` MEMBER, deliberately. Adding
     * `scheduled` to the status enum would mean every `switch` on status across
     * the status bar, the dashboard, `computeStats`, the Activity filters and
     * `toState()` either handles it or breaks at runtime — and a run that has not
     * fired yet genuinely IS queued, it is simply queued with a delay. So the
     * status stays one of the five it has always been, and "scheduled" is derived
     * from this column.
     *
     * The derivation is deliberately free of "now": a run is scheduled if it has
     * this timestamp and has not started, not if the timestamp is in the future.
     * Anything computed from the clock differs between the server render and the
     * first client render, which is React hydration error #418 — and a "fires
     * in 3 hours" countdown is exactly the shape that triggers it. The countdown
     * belongs in the client-time components; the bucketing must not need one.
     *
     * The staged payload is what makes this safe at all: `enqueueJob` writes
     * `job_item` inside the same transaction as the run row, so a run scheduled
     * for tomorrow does not depend on the preview, which expires in an hour.
     */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),

    /**
     * The repeating series this run is one occurrence OF — §6 C2.
     *
     * Null for every run that is not part of one, which is nearly all of them.
     * Deliberately a pointer on the run rather than a status: a repeat is not a
     * state a run is IN, it is a reason a run exists, and `JobStatus` still has
     * exactly its original five members.
     *
     * `set null` rather than `cascade` on purpose. Deleting the series must leave
     * its history alone: those runs happened, they have results somebody may need
     * to read next month, and they stop being "the next one" rather than stop
     * having existed.
     */
    scheduleId: text("schedule_id").references((): AnyPgColumn => jobSchedules.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    /*
     * Every list query now opens with `where created_by = ?`, so the previous
     * `(status, created_at)` index no longer leads with the most selective
     * column and was replaced rather than added to.
     *
     *  - owner_created: the Activity screen and the dashboard — one account's
     *    runs, newest first.
     *  - owner_status:  the status-bar snapshot — one account's running and
     *    queued runs.
     *  - created:       the administrator's cross-account run list, which has no
     *    owner in its WHERE clause at all.
     */
    index("job_owner_created_idx").on(table.createdBy, table.createdAt),
    index("job_owner_status_idx").on(table.createdBy, table.status, table.createdAt),
    index("job_created_idx").on(table.createdAt),
    index("job_store_idx").on(table.storeId, table.createdAt),
    index("job_group_idx").on(table.groupId),
  ],
);

/**
 * What a run DID, line by line, as it happened.
 *
 * Lives in Postgres for the same reason as everything else durable here: a log
 * that disappears on redeploy cannot explain last night's run, which is the only
 * time anybody goes looking for one. Cascades from `job`, so deleting a run takes
 * its log with it — and `jobFootprint()` counts these rows, because the "this will
 * delete N rows" figure on screen is a promise.
 *
 * `id` is a bigserial rather than a timestamp cursor: two lines written in the
 * same millisecond are ordinary, and a cursor that cannot distinguish them either
 * repeats lines or skips them.
 *
 * NEVER holds a payload, a header, an API key or an HMAC signature. Headers carry
 * the site's key and the payload is the customer's whole catalogue. `tests/e2e.sh`
 * and `tests/isolation.sh` grep this table for the fixture secrets, so that rule is
 * enforced by a failing test rather than by reviewer attention.
 */
export const jobLogs = pgTable(
  "job_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    level: text("level", { enum: ["debug", "info", "warn", "error"] })
      .notNull()
      .default("info"),
    /** Which part of the run this came from — lets the UI group and filter. */
    stage: text("stage", {
      enum: [
        "run",
        "limits",
        "s3",
        "images",
        "batch",
        "plugin",
        "cancel",
        "transients",
        "notify",
        "finish",
      ],
    }).notNull(),

    /** The batch this line belongs to, when it belongs to one. */
    batchIndex: integer("batch_index"),
    message: text("message").notNull(),
    /** Structured numbers behind the message — timings, counts, codes. */
    detail: jsonb("detail").$type<Record<string, unknown>>(),
  },
  // (job_id, id) rather than (job_id): every read is "this run's lines after N",
  // and the id has to be part of the index for that to be a range scan.
  (table) => [index("job_log_job_idx").on(table.jobId, table.id)],
);

/**
 * The payload a run works through.
 *
 * Kept out of `job` so listing the queue does not drag several megabytes of
 * product JSON along with it.
 */
export const jobItems = pgTable("job_item", {
  jobId: text("job_id")
    .primaryKey()
    .references(() => jobs.id, { onDelete: "cascade" }),
  items: jsonb("items").$type<unknown[]>().notNull(),
});

export const jobResults = pgTable(
  "job_result",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    /** Index in the original array, so results line up with the source rows. */
    index: integer("index").notNull(),

    ok: boolean("ok").notNull(),
    productId: integer("product_id"),
    sku: text("sku"),
    /**
     * Product name. Written by purge runs, where the row is the only record
     * left of what was removed — the product itself is gone.
     */
    name: text("name"),
    variationIds: jsonb("variation_ids").$type<number[]>(),
    deduplicated: boolean("deduplicated").notNull().default(false),
    /**
     * Rows the plugin removed per table, for purge runs.
     *
     * Kept per row rather than summed: "we deleted 40 products" is a claim,
     * while "this product took 1 post, 34 postmeta, 3 attachments and 2
     * comments with it" is evidence.
     */
    removed: jsonb("removed").$type<Record<string, number>>(),
    /**
     * Which fields an UPDATE row changed, and what each changed FROM.
     *
     * The `from` half is why this is a column rather than a counter. A run that
     * repriced 3,000 products is the ONLY record anywhere of what those prices
     * were — the site has overwritten them and nothing else in this app kept
     * them. So the run's own page is the audit trail, and the existing CSV export
     * carries it out of the app.
     *
     * Null rather than `{}` when nothing moved: "succeeded and changed nothing" is
     * already carried by `deduplicated`, and an empty object per row over a
     * 14,000-row run is bytes for no information.
     */
    changed: jsonb("changed").$type<Record<string, { from: string | string[]; to: string | string[] }>>(),
    /**
     * Whether this row CREATED the product or merely changed one already there.
     *
     * Not bookkeeping — it prevents a destructive lie. `/remove` offers
     * "Everything one import run created", and it builds that list from
     * `createdProductIds()`, which reads every successful row's `product_id`. In
     * a create-or-update run those ids include products the run only REPRICED and
     * did not create, so without this column that selection would delete a
     * customer's existing catalogue on the strength of a label saying it would not.
     *
     * Null on every row written before this existed, and on purge rows: an import
     * that could only create needs no discriminant, and reading null as "created"
     * is what those rows always meant.
     */
    action: text("action", { enum: ["created", "updated"] }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.index] }),
    index("job_result_ok_idx").on(table.jobId, table.ok),
  ],
);

export const jobBatches = pgTable(
  "job_batch",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    size: integer("size").notNull(),
    succeeded: integer("succeeded").notNull(),
    failed: integer("failed").notNull(),
    deduplicated: integer("deduplicated").notNull().default(0),
    /** What the plugin reported. Null when the batch died before it answered. */
    elapsedMs: real("elapsed_ms"),
    /** Wall clock on the worker side. Always present. */
    wallMs: integer("wall_ms").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.index] })],
);

/* ----------------------------------------------------------------- previews */

/**
 * A staged run, built once and reused when the user presses Start.
 *
 * This is what makes "what you previewed is what gets sent" literally true, and
 * it is why one file read can fan out to several stores.
 */
export const previews = pgTable(
  "preview",
  {
    id: text("id").primaryKey(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    meta: jsonb("meta").$type<Record<string, unknown>>().notNull(),
    products: jsonb("products").$type<unknown[]>().notNull(),
  },
  (table) => [
    index("preview_expiry_idx").on(table.expiresAt),
    index("preview_owner_idx").on(table.createdBy),
  ],
);

/* ----------------------------------------------------------------- settings */

/**
 * Configuration, ONE ROW PER ACCOUNT.
 *
 * This used to be a single row pinned at `id = 1`, which meant one set of import
 * defaults and — much worse — one set of Amazon S3 credentials shared by every
 * account in the installation. The primary key is now the owner, so a row
 * cannot exist without an account and an account cannot have two.
 *
 * A key/value bag would be more flexible and much worse: every read would need
 * a cast and a default, and nothing would tell you which keys exist.
 */
export const settings = pgTable("settings", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),

  defaultThreads: integer("default_threads").notNull().default(10),
  defaultBatchSize: integer("default_batch_size").notNull().default(50),
  defaultMode: text("default_mode").notNull().default("standard"),
  defaultImageMode: text("default_image_mode").notNull().default("keep_remote"),
  historyLimit: integer("history_limit").notNull().default(100),

  /**
   * Currency for DISPLAY, in the preview, the review table and the results.
   *
   * Empty by default, and that default is load-bearing: empty means "show the raw
   * number", which is exactly what every screen did before this column existed.
   * Defaulting to any actual currency would put a symbol in front of every price
   * for every existing account including the ones whose shops are in a different
   * currency — a regression dressed as a feature.
   *
   * It changes NOTHING on any site, and cannot. The plugin writes prices as plain
   * numbers into `postmeta` and WooCommerce renders them with the site's own
   * `woocommerce_currency`; stock WooCommerce has no per-product currency at all.
   * This is here because the operator could not see what they were publishing, not
   * because the shop needed telling. See `formatMoney` in `lib/format.ts`.
   */
  displayCurrency: text("display_currency").notNull().default(""),

  /* ---- Amazon S3 ---- */
  s3Enabled: boolean("s3_enabled").notNull().default(false),
  s3AccessKeyId: text("s3_access_key_id").notNull().default(""),
  /**
   * AES-256-GCM, same envelope as store API secrets.
   *
   * Every account sets its own; only an administrator can read one back, and
   * only through the one named reveal action that writes to `secret_reveal`.
   */
  s3SecretEncrypted: text("s3_secret_encrypted").notNull().default(""),
  s3Bucket: text("s3_bucket").notNull().default(""),
  s3Region: text("s3_region").notNull().default(""),
  /** Public base URL that replaces the S3 endpoint, e.g. a CloudFront domain. */
  s3PublicUrl: text("s3_public_url").notNull().default(""),
  /** Optional key prefix inside the bucket. */
  s3Prefix: text("s3_prefix").notNull().default(""),

  /* ---- Telling somebody a run has finished (§6 C3) ---- */

  /**
   * Where to POST when a run ends. Empty means notifications are off.
   *
   * Empty-means-off rather than a separate boolean, the same shape
   * `displayCurrency` uses: a switch that can disagree with the field beside it
   * is a switch somebody will leave on with an empty URL and wonder about.
   */
  notifyWebhookUrl: text("notify_webhook_url").notNull().default(""),

  /**
   * Shared secret the receiver verifies the signature with. AES-256-GCM at rest,
   * the same envelope as store API secrets and the S3 key.
   *
   * Provided by the ACCOUNT rather than generated here, and that follows from a
   * rule this app already keeps: a member cannot read a stored secret back, their
   * own included. A secret this app invented would have to be readable for the
   * receiver to be configured with it.
   */
  notifyWebhookSecretEncrypted: text("notify_webhook_secret_encrypted").notNull().default(""),

  /** Only send when something went wrong. Off, so a finished run always says so. */
  notifyFailuresOnly: boolean("notify_failures_only").notNull().default(false),

  /**
   * Telegram, as a SECOND channel for the same events — not a second event system.
   *
   * A webhook reaches a system; Telegram reaches a person, on the phone they already
   * have. Both are driven by the same run-finished hook and the same "only when
   * something went wrong" switch, so there is one answer to "when do I get told" and
   * two answers to "where".
   *
   * It cannot ride on the webhook field: Telegram wants `chat_id` and `text` in a
   * shape of its own, and the token belongs in a header-free URL this app builds.
   */
  notifyTelegramTokenEncrypted: text("notify_telegram_token_encrypted").notNull().default(""),
  /** Where to send it: a user, a group, or a channel like `@my_channel`. */
  notifyTelegramChatId: text("notify_telegram_chat_id").notNull().default(""),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* --------------------------------------------------------------- schedules */

/**
 * A run that happens again — §6 C2.
 *
 * Scheduling one run for tomorrow already worked. What did not exist was "every
 * night", and the shape of it is the whole design decision here.
 *
 * EACH OCCURRENCE IS AN ORDINARY RUN. A firing creates a NEW `job` row with its own
 * copy of the payload, its own results, its own log and its own Cancel. The
 * alternative — one job re-run on a BullMQ `repeat` — cannot work in this codebase
 * and it is worth saying why: `runJob` refuses to touch a run whose status is
 * terminal, which is exactly the guard that stops a redelivered job re-publishing a
 * catalogue. A repeating single row would either be refused by that guard or would
 * have to be exempted from it, and the guard is worth more than the convenience.
 *
 * So `JobStatus` is untouched, "scheduled" is still DERIVED from `scheduled_for`,
 * and every screen that switches on status keeps working without knowing this table
 * exists.
 *
 * THE PAYLOAD LIVES HERE, ONCE. Each occurrence gets a copy in `job_item`, but the
 * series holds the original — so deleting last night's run cannot break tonight's,
 * which it would if occurrence N+1 copied its products from occurrence N.
 *
 * What it deliberately is NOT: a file watcher. This re-sends the SAME staged data on
 * a cadence, because "the preview is a contract" — this app never re-reads a file.
 * That is genuinely useful for keeping a shop matching a price list somebody edits
 * in wp-admin, and it is useless for picking up a new export. The screen says so.
 */
export const jobSchedules = pgTable(
  "job_schedule",
  {
    id: text("id").primaryKey(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /** Where each occurrence publishes. One series, one site — like one run. */
    storeId: text("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    storeUrl: text("store_url").notNull(),
    storeLabel: text("store_label").notNull(),

    kind: text("kind", { enum: ["import", "purge", "update"] })
      .notNull()
      .default("import"),
    /** What the file was called, carried onto every occurrence. */
    sourceLabel: text("source_label").notNull(),
    options: jsonb("options").$type<Record<string, unknown>>().notNull(),
    /** The staged items, held once for the series. Copied into each occurrence. */
    payload: jsonb("payload").$type<unknown[]>().notNull(),

    /**
     * How often, in minutes. A plain interval rather than a cron expression:
     * a cron field is a second scheduling language to learn, to validate, to get
     * time zones wrong in, and every case this exists for is "every N hours".
     */
    everyMinutes: integer("every_minutes").notNull(),

    /** When the pending occurrence is due. Advanced from the PREVIOUS due time. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),

    /**
     * The occurrence currently waiting, and the reason a redelivery cannot double
     * the series: the worker only advances the schedule when the run it is holding
     * IS this one, and advancing replaces it in the same statement.
     */
    nextJobId: text("next_job_id"),

    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    /** Paused keeps the series and its payload, and stops it firing. */
    paused: boolean("paused").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("job_schedule_owner_idx").on(table.createdBy, table.createdAt)],
);

/* ------------------------------------------------------------------ presets */

export const presets = pgTable(
  "preset",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Import options minus the store — the store is a per-run choice. */
    options: jsonb("options").$type<Record<string, unknown>>().notNull(),
  },
  // Unique PER ACCOUNT, not globally. Saving "Nightly feed" must not overwrite
  // another customer's preset of the same name — nor fail because they got
  // there first.
  (table) => [uniqueIndex("preset_owner_name_idx").on(table.createdBy, table.name)],
);

/**
 * Remembered column mapping, keyed by the signature of a file's header row —
 * AND by the account, because two customers exporting from the same system
 * share a header row while meaning different things by it.
 */
export const csvMaps = pgTable(
  "csv_map",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    signature: text("signature").notNull(),
    dialect: text("dialect").notNull(),
    columnMap: jsonb("column_map").$type<Record<string, string>>().notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.signature] })],
);

/* ------------------------------------------------------------ account limits */

/**
 * What an administrator has switched on or off for one account.
 *
 * Deliberately a SEPARATE table from `settings`, and the separation is the whole
 * security property. `settings` is the account's own configuration — the account
 * edits it. This is the operator's configuration OF that account, and the account
 * must not be able to touch it. Two different owners of two different kinds of
 * data do not belong in one row that one API route writes.
 *
 * Absent row means "everything allowed": a new customer is not blocked by
 * default, and an administrator has to have made a decision for a limit to exist.
 * `DEFAULT_LIMITS` in `lib/limits.ts` is the same statement in code.
 *
 * A null number means no ceiling. Zero would mean "nothing allowed", which is a
 * different and reachable state — so the two cannot be conflated.
 *
 * Every one of these is enforced in the route handler, not merely hidden in the
 * interface. A switch that only greys a button out is a suggestion.
 */
export const accountLimits = pgTable("account_limit", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),

  /** Off means this account cannot start an import run at all. */
  importEnabled: boolean("import_enabled").notNull().default(true),
  /** Off means this account cannot remove products — the most dangerous one. */
  removeEnabled: boolean("remove_enabled").notNull().default(true),
  /**
   * Off means this account cannot change products that already exist.
   *
   * Its own switch rather than folded into `importEnabled`, because it is a
   * different capability with a different worst case: an import that goes wrong
   * adds products somebody can delete, while a bulk edit that goes wrong REPRICES a
   * catalogue and overwrites the only copy of what the prices were. An operator
   * should be able to let a customer import while withholding this.
   *
   * Absent means allowed, exactly like the others — a new customer is never blocked
   * because nobody configured them.
   */
  productEditEnabled: boolean("product_edit_enabled").notNull().default(true),
  /**
   * Off means this account may neither choose the S3 image mode nor edit its own
   * AWS keys. Named `s3Allowed` rather than `s3Enabled` so it cannot be confused
   * with `settings.s3Enabled`, which is the account's own on/off switch.
   */
  s3Allowed: boolean("s3_allowed").notNull().default(true),

  /** Null means no ceiling. Zero means none allowed. */
  maxStores: integer("max_stores"),
  maxProductsPerRun: integer("max_products_per_run"),
  maxThreads: integer("max_threads"),

  /** Who last changed this, so the accounts screen can say. */
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ----------------------------------------------------------- secret reveals */

/**
 * Every time an administrator reads a stored secret back.
 *
 * An administrator operating the service needs the real value to repair a
 * customer's configuration — a bucket with a rotated key, a site whose API
 * secret no longer matches. That capability is legitimate; this table is what
 * keeps it from becoming an accident. An operator repairing a customer's bucket
 * is ordinary, and the record is what makes it possible to tell that apart from
 * anything else, later, when nobody remembers.
 *
 * Deliberately NOT owned by the target account and NOT cascading with it: this
 * is the operator's record of what an administrator did, not the customer's
 * data, and an audit row that disappears when either party is deleted is worth
 * nothing. Both sides are `set null` with the email copied alongside, so the row
 * still names who and whom after the account is gone.
 *
 * It stores no secret. `kind` and `subject_label` say WHICH secret was read;
 * the value itself only ever travels in the response body of the one POST that
 * produced this row.
 */
export const secretReveals = pgTable(
  "secret_reveal",
  {
    id: text("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),

    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** Copied, so the record still names the administrator after the account goes. */
    actorEmail: text("actor_email").notNull(),

    targetUserId: text("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetEmail: text("target_email").notNull(),

    kind: text("kind", { enum: ["store_api_secret", "s3_secret_key"] }).notNull(),
    /** The store's id for a site secret; null for the account-level S3 key. */
    subjectId: text("subject_id"),
    /** Human-readable: the site's URL, or the bucket name. Never the secret. */
    subjectLabel: text("subject_label").notNull(),

    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("secret_reveal_at_idx").on(table.at),
    index("secret_reveal_actor_idx").on(table.actorId, table.at),
    index("secret_reveal_target_idx").on(table.targetUserId, table.at),
  ],
);
