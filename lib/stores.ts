/*
 * Do NOT import "server-only" here — this module is in the worker's import
 * graph. The `pg` dependency is what stops it reaching the browser: importing
 * it from a Client Component fails the build with a clear message.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { storeChecks, stores as storesTable, users } from "@/db/schema";

import { decrypt, encrypt } from "./crypto";
import { GopClient, type GopClientOptions, type SiteCredentials } from "./gop-client";
import { checkSiteLicense, describeLicenseError } from "./site-license";

/**
 * The connected-site registry, backing the Sites screen.
 *
 * Sites belong to ONE ACCOUNT. Two accounts may connect the same WooCommerce
 * site; each holds its own row with its own key and secret, and the plugin
 * authenticates per key, so neither can see or use the other's connection.
 *
 * Every ordinary read demands the owner. The administrator's cross-account view
 * has its own explicitly named way in — `listAllStores()`, `getStoreUnscoped()`
 * — rather than a flag on the normal path.
 *
 * `apiSecret` is encrypted before it reaches Postgres and never leaves the
 * server through an ordinary payload; every function that hands data to the UI
 * goes through `toPublic()`. The one exception is `revealApiSecret()`, which an
 * administrator has to ask for by name and which is recorded.
 */

export const storeInputSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Site URL is required")
    .transform((value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`))
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }, "That is not a valid URL"),

  /**
   * Plugin folder suffix on the site — `101055` means
   * `wp-content/plugins/gop-import_101055`. Empty uses the plain folder.
   */
  pin: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]*$/, "PIN may only contain letters, digits, dashes and underscores")
    .default(""),

  apiKey: z.string().trim().min(1, "API key is required"),
  apiSecret: z.string().trim().min(1, "API secret is required"),

  /** Enable when the site serves the plugin through a /GPM/<pin> rewrite. */
  urlRewrite: z.boolean().default(false),

  /**
   * Overrides the plugin path completely. Needed when the plugin is not at the
   * default location — a renamed wp-content, mu-plugins, or a reverse proxy.
   */
  baseUrlOverride: z.string().trim().default(""),

  label: z.string().trim().default(""),
});

export type StoreInput = z.infer<typeof storeInputSchema>;

export interface Store extends Omit<StoreInput, "apiSecret"> {
  id: string;
  /** The account this site belongs to. */
  ownerId: string;
  apiSecretEncrypted: string;
  connectedAt: string;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  lastCheckMs: number | null;
  pluginVersion: string | null;

  /**
   * The rest of what /health reports, kept exactly as the plugin sent it.
   *
   * These used to be squashed into a single message string and thrown away, so
   * "missing stored functions" and "wrong API key" looked identical: one red
   * dot. Keeping them whole lets the Sites screen say what to actually fix.
   */
  phpVersion: string | null;
  mysqlVersion: string | null;
  tablePrefix: string | null;
  /** `site_url` as reported by the plugin — used to build wp-admin links. */
  siteUrl: string | null;
  missingFunctions: string[];
}

/** One row of a site's connection-check history. */
export interface StoreCheckRecord {
  at: string;
  ok: boolean;
  elapsedMs: number;
  version: string | null;
  message: string;
}

/** Browser-safe projection — no secret. */
export type PublicStore = Omit<Store, "apiSecretEncrypted">;

export function toPublic(store: Store): PublicStore {
  const { apiSecretEncrypted: _ignored, ...rest } = store;
  return rest;
}

/**
 * `storeLabel` and `adminProductUrl` live in `lib/store-links.ts` because this
 * module pulls in `pg`, which a Client Component must never import. Re-exported
 * so server code still has a single entry point.
 */
export { adminProductUrl, storeLabel } from "./store-links";

/**
 * Build the plugin's base URL on a site.
 *
 * Two ways in: straight at the plugin folder, and the `/GPM/<pin>` rewrite for
 * hosts that answer 403 to direct wp-content requests.
 */
export function baseUrlFor(
  store: Pick<Store, "url" | "pin" | "urlRewrite"> & { baseUrlOverride?: string },
): string {
  if (store.baseUrlOverride && store.baseUrlOverride !== "") {
    return store.baseUrlOverride.replace(/\/$/, "");
  }

  const root = store.url.replace(/\/$/, "");

  if (store.urlRewrite && store.pin) {
    return `${root}/GPM/${store.pin}`;
  }

  /*
   * The deployed plugin's directory name.
   *
   * Renamed from `toshstack.dev` to `gop-import` with the rest of the product.
   * This is the one rename with a cost outside this codebase: a site whose
   * directory is still called `toshstack.dev` answers 404 until it is moved, or
   * until "Plugin base URL override" on the site's screen is pointed at the old
   * path. The override is the escape hatch, and it is why this is survivable.
   */
  const folder = store.pin ? `gop-import_${store.pin}` : "gop-import";
  return `${root}/wp-content/plugins/${folder}`;
}

export async function credentialsFor(store: Store): Promise<SiteCredentials> {
  return {
    baseUrl: baseUrlFor(store),
    apiKey: store.apiKey,
    apiSecret: decrypt(store.apiSecretEncrypted),
  };
}

/**
 * `options` is how a run's Stop signal and request deadline reach the wire — see
 * `GopClientOptions`. Everything that merely reads a site (health, terms,
 * lookups) leaves it out and gets the default deadline.
 */
export async function clientFor(store: Store, options?: GopClientOptions): Promise<GopClient> {
  return new GopClient(await credentialsFor(store), options);
}

/* --------------------------------------------------------------- mapping */

type Row = typeof storesTable.$inferSelect;

function toStore(row: Row): Store {
  return {
    id: row.id,
    ownerId: row.ownerId,
    label: row.label,
    url: row.url,
    pin: row.pin,
    apiKey: row.apiKey,
    apiSecretEncrypted: row.apiSecretEncrypted,
    urlRewrite: row.urlRewrite,
    baseUrlOverride: row.baseUrlOverride,
    connectedAt: row.connectedAt.toISOString(),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastCheckOk: row.lastCheckOk,
    lastCheckMessage: row.lastCheckMessage,
    lastCheckMs: row.lastCheckMs,
    pluginVersion: row.pluginVersion,
    phpVersion: row.phpVersion,
    mysqlVersion: row.mysqlVersion,
    tablePrefix: row.tablePrefix,
    siteUrl: row.siteUrl,
    missingFunctions: row.missingFunctions ?? [],
  };
}

/* ---------------------------------------------------------------- queries */

/** One account's sites, newest connection first. */
export async function listStores(ownerId: string): Promise<Store[]> {
  const rows = await db
    .select()
    .from(storesTable)
    .where(eq(storesTable.ownerId, ownerId))
    .orderBy(desc(storesTable.connectedAt));
  return rows.map(toStore);
}

/** A site, only if it belongs to this account. */
export async function getStore(id: string, ownerId: string): Promise<Store | null> {
  const [row] = await db
    .select()
    .from(storesTable)
    .where(and(eq(storesTable.id, id), eq(storesTable.ownerId, ownerId)))
    .limit(1);
  return row ? toStore(row) : null;
}

/**
 * A site whoever it belongs to.
 *
 * Two callers, both of which are outside the customer-to-customer boundary
 * rather than exceptions to it:
 *  - the worker, which runs with no session at all and has already been told
 *    which run it is executing;
 *  - the ownership guard in `lib/ownership.ts`, whose whole job is to compare
 *    this row's owner against the caller.
 *
 * Named `Unscoped` so that using it anywhere else looks wrong in review.
 */
export async function getStoreUnscoped(id: string): Promise<Store | null> {
  const [row] = await db.select().from(storesTable).where(eq(storesTable.id, id)).limit(1);
  return row ? toStore(row) : null;
}

/** A site plus the account it belongs to — the administrator's list. */
export interface OwnedStore extends Store {
  ownerEmail: string;
  ownerName: string;
}

/**
 * Every account's sites, with the owning account on every row.
 *
 * The administrator's cross-account read. Explicitly named rather than
 * `listStores(userId?)`, so nothing can reach it by leaving an argument out.
 */
export async function listAllStores(): Promise<OwnedStore[]> {
  const rows = await db
    .select({ store: storesTable, email: users.email, name: users.name })
    .from(storesTable)
    .innerJoin(users, eq(users.id, storesTable.ownerId))
    .orderBy(desc(storesTable.connectedAt));

  return rows.map((row) => ({
    ...toStore(row.store),
    ownerEmail: row.email,
    ownerName: row.name,
  }));
}

export async function createStore(ownerId: string, input: StoreInput): Promise<Store> {
  const [row] = await db
    .insert(storesTable)
    .values({
      id: randomUUID(),
      ownerId,
      label: input.label,
      url: input.url,
      pin: input.pin,
      apiKey: input.apiKey,
      apiSecretEncrypted: encrypt(input.apiSecret),
      urlRewrite: input.urlRewrite,
      baseUrlOverride: input.baseUrlOverride,
    })
    .returning();

  return toStore(row);
}

/**
 * Write to a site.
 *
 * Takes no owner: by the time anything calls this the caller's right to touch
 * this row has already been established by `lib/ownership.ts`, and asking for
 * the owner again here would suggest the check lives in two places.
 */
export async function updateStore(
  id: string,
  patch: Partial<Omit<Store, "id" | "ownerId" | "connectedAt">>,
): Promise<Store | null> {
  const values: Partial<typeof storesTable.$inferInsert> = {};

  if (patch.label !== undefined) values.label = patch.label;
  if (patch.url !== undefined) values.url = patch.url;
  if (patch.pin !== undefined) values.pin = patch.pin;
  if (patch.apiKey !== undefined) values.apiKey = patch.apiKey;
  if (patch.apiSecretEncrypted !== undefined) {
    values.apiSecretEncrypted = patch.apiSecretEncrypted;
  }
  if (patch.urlRewrite !== undefined) values.urlRewrite = patch.urlRewrite;
  if (patch.baseUrlOverride !== undefined) values.baseUrlOverride = patch.baseUrlOverride;
  if (patch.lastCheckedAt !== undefined) {
    values.lastCheckedAt = patch.lastCheckedAt === null ? null : new Date(patch.lastCheckedAt);
  }
  if (patch.lastCheckOk !== undefined) values.lastCheckOk = patch.lastCheckOk;
  if (patch.lastCheckMessage !== undefined) values.lastCheckMessage = patch.lastCheckMessage;
  if (patch.lastCheckMs !== undefined) values.lastCheckMs = patch.lastCheckMs;
  if (patch.pluginVersion !== undefined) values.pluginVersion = patch.pluginVersion;
  if (patch.phpVersion !== undefined) values.phpVersion = patch.phpVersion;
  if (patch.mysqlVersion !== undefined) values.mysqlVersion = patch.mysqlVersion;
  if (patch.tablePrefix !== undefined) values.tablePrefix = patch.tablePrefix;
  if (patch.siteUrl !== undefined) values.siteUrl = patch.siteUrl;
  if (patch.missingFunctions !== undefined) values.missingFunctions = patch.missingFunctions;

  if (Object.keys(values).length === 0) {
    return getStoreUnscoped(id);
  }

  const [row] = await db
    .update(storesTable)
    .set(values)
    .where(eq(storesTable.id, id))
    .returning();

  return row ? toStore(row) : null;
}

export async function deleteStore(id: string): Promise<boolean> {
  const rows = await db.delete(storesTable).where(eq(storesTable.id, id)).returning({
    id: storesTable.id,
  });
  return rows.length > 0;
}

/* ---------------------------------------------------------- check history */

const CHECK_HISTORY_LIMIT = 50;

export async function recordCheck(id: string, record: StoreCheckRecord): Promise<void> {
  await db.insert(storeChecks).values({
    id: randomUUID(),
    storeId: id,
    at: new Date(record.at),
    ok: record.ok,
    elapsedMs: record.elapsedMs,
    version: record.version,
    message: record.message,
  });
}

export async function listChecks(
  id: string,
  limit = CHECK_HISTORY_LIMIT,
): Promise<StoreCheckRecord[]> {
  const rows = await db
    .select()
    .from(storeChecks)
    .where(eq(storeChecks.storeId, id))
    .orderBy(desc(storeChecks.at))
    .limit(limit);

  return rows.map((row) => ({
    at: row.at.toISOString(),
    ok: row.ok,
    elapsedMs: row.elapsedMs,
    version: row.version,
    message: row.message,
  }));
}

/* ---------------------------------------------------------- health checks */

export interface CheckResult {
  storeId: string;
  url: string;
  ok: boolean;
  message: string;
  version: string | null;
  missingFunctions: string[];
  elapsedMs: number;
  php: string | null;
  mysql: string | null;
  tablePrefix: string | null;
  siteUrl: string | null;
}

/**
 * "Test connection" — calls the plugin's /health and records the outcome.
 *
 * Every failure becomes a CheckResult rather than an exception: when checking
 * many sites at once, one dead site must not destroy the results for the rest.
 */
export async function checkStore(store: Store): Promise<CheckResult> {
  const startedAt = Date.now();
  const base = { storeId: store.id, url: store.url };

  try {
    const client = await clientFor(store);
    const health = await client.health();
    const elapsedMs = Date.now() - startedAt;

    /*
     * The licence is part of whether this site is usable, so it is part of the check
     * rather than a separate screen: a site that answers /health perfectly and is
     * activated with somebody else's key cannot be published to, and the operator has
     * to learn that here rather than from a failed run.
     */
    const licence = await checkSiteLicense(store.ownerId, health.license);

    const ok = health.ok && health.missing_functions.length === 0 && licence.ok;
    const at = new Date().toISOString();

    const message = !licence.ok
      ? licence.message
      : ok
        ? `OK — plugin ${health.version}, PHP ${health.php}, MySQL ${health.mysql}`
        : `Missing ${health.missing_functions.length} stored function(s): ${health.missing_functions.join(", ")}. Open GPM Import → Status on the site and press Install.`;

    // Record everything /health returned, not a one-line summary of it.
    await updateStore(store.id, {
      lastCheckedAt: at,
      lastCheckOk: ok,
      lastCheckMessage: message,
      lastCheckMs: elapsedMs,
      pluginVersion: health.version,
      phpVersion: health.php,
      mysqlVersion: health.mysql,
      tablePrefix: health.table_prefix,
      siteUrl: health.site_url,
      missingFunctions: health.missing_functions,
    });

    await recordCheck(store.id, { at, ok, elapsedMs, version: health.version, message });

    return {
      ...base,
      elapsedMs,
      ok,
      message,
      version: health.version,
      missingFunctions: health.missing_functions,
      php: health.php,
      mysql: health.mysql,
      tablePrefix: health.table_prefix,
      siteUrl: health.site_url,
    };
  } catch (error) {
    // A site refusing everything because it is not activated must not read as a
    // broken site: the plugin's own code says which it is.
    const message = describeLicenseError(error) ?? (error instanceof Error ? error.message : String(error));
    const elapsedMs = Date.now() - startedAt;
    const at = new Date().toISOString();

    await updateStore(store.id, {
      lastCheckedAt: at,
      lastCheckOk: false,
      lastCheckMessage: message,
      lastCheckMs: elapsedMs,
    });

    await recordCheck(store.id, { at, ok: false, elapsedMs, version: null, message });

    return {
      ...base,
      elapsedMs,
      ok: false,
      version: null,
      missingFunctions: [],
      message,
      php: null,
      mysql: null,
      tablePrefix: null,
      siteUrl: null,
    };
  }
}

/** Check one account's connected sites in parallel. */
export async function checkAllStores(ownerId: string): Promise<CheckResult[]> {
  const all = await listStores(ownerId);
  return Promise.all(all.map((store) => checkStore(store)));
}

/** How many sites one account has connected. */
export async function countStores(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storesTable)
    .where(eq(storesTable.ownerId, ownerId));
  return row?.count ?? 0;
}

/**
 * A site's API secret, in plain text.
 *
 * The only way a stored site secret leaves the database. Guarded at the route
 * by `apiRequireAdmin()` and recorded in `secret_reveal` by that same route —
 * see `app/api/admin/reveal/store/[id]/route.ts`. A site secret in plain text
 * is equivalent to full write access to that site's database, so nothing else
 * calls this and nothing logs what it returns.
 */
export function revealApiSecret(store: Store): string {
  return decrypt(store.apiSecretEncrypted);
}

export { and, eq };
