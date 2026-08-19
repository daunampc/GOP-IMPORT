import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { accountLimits, jobs, stores, users } from "@/db/schema";

/**
 * What an administrator has allowed one account to do.
 *
 * Two rules, and everything here follows from them:
 *
 *  1. ABSENT MEANS ALLOWED. A new customer is not blocked because nobody has got
 *     round to configuring them; a limit exists only where an administrator made
 *     a decision. `DEFAULT_LIMITS` is that sentence in code.
 *
 *  2. ENFORCED SERVER-SIDE, always. The interface hides what an account cannot
 *     do, but hiding is a courtesy — the route handler is what makes it true. A
 *     switch that only greys out a button is a suggestion, and the API is a
 *     public surface with a session cookie in front of it and nothing else.
 *
 * `null` on a number means no ceiling; `0` means none allowed. Those are
 * different reachable states, so they are never conflated — which is why the
 * checks below test `=== null` rather than falsiness.
 */

export interface AccountLimits {
  importEnabled: boolean;
  removeEnabled: boolean;
  productEditEnabled: boolean;
  s3Allowed: boolean;
  maxStores: number | null;
  maxProductsPerRun: number | null;
  maxThreads: number | null;
}

export const DEFAULT_LIMITS: AccountLimits = {
  importEnabled: true,
  removeEnabled: true,
  productEditEnabled: true,
  s3Allowed: true,
  maxStores: null,
  maxProductsPerRun: null,
  maxThreads: null,
};

export const limitsSchema = z.object({
  importEnabled: z.boolean().default(true),
  removeEnabled: z.boolean().default(true),
  productEditEnabled: z.boolean().default(true),
  s3Allowed: z.boolean().default(true),
  // `nullable` rather than `optional`: clearing a ceiling has to be expressible.
  maxStores: z.coerce.number().int().min(0).max(10_000).nullable().default(null),
  maxProductsPerRun: z.coerce.number().int().min(0).max(1_000_000).nullable().default(null),
  maxThreads: z.coerce.number().int().min(1).max(32).nullable().default(null),
});

export async function limitsFor(ownerId: string): Promise<AccountLimits> {
  const [row] = await db
    .select()
    .from(accountLimits)
    .where(eq(accountLimits.ownerId, ownerId))
    .limit(1);

  if (!row) {
    return DEFAULT_LIMITS;
  }

  return {
    importEnabled: row.importEnabled,
    removeEnabled: row.removeEnabled,
    productEditEnabled: row.productEditEnabled,
    s3Allowed: row.s3Allowed,
    maxStores: row.maxStores,
    maxProductsPerRun: row.maxProductsPerRun,
    maxThreads: row.maxThreads,
  };
}

/** Administrators only — the route is what enforces that. */
export async function saveLimits(
  ownerId: string,
  input: unknown,
  updatedBy: string,
): Promise<AccountLimits> {
  const parsed = limitsSchema.parse(input);

  await db
    .insert(accountLimits)
    .values({ ownerId, ...parsed, updatedBy })
    .onConflictDoUpdate({
      target: accountLimits.ownerId,
      set: { ...parsed, updatedBy, updatedAt: new Date() },
    });

  return parsed;
}

/** Every account's limits at once, for the administrator's accounts list. */
export async function allLimits(): Promise<Record<string, AccountLimits>> {
  const rows = await db.select().from(accountLimits);

  const out: Record<string, AccountLimits> = {};
  for (const row of rows) {
    out[row.ownerId] = {
      importEnabled: row.importEnabled,
      removeEnabled: row.removeEnabled,
      productEditEnabled: row.productEditEnabled,
      s3Allowed: row.s3Allowed,
      maxStores: row.maxStores,
      maxProductsPerRun: row.maxProductsPerRun,
      maxThreads: row.maxThreads,
    };
  }
  return out;
}

/* ------------------------------------------------------------- enforcement */

/** A refusal, shaped so a route can return it directly. */
export type LimitCheck = { ok: true } | { ok: false; response: Response };

/**
 * The same verdict without a Response attached.
 *
 * The WORKER needs to ask these questions too, and it has no request to answer:
 * a run scheduled for tomorrow has to be re-checked when it fires, because an
 * account whose import permission was revoked in between must not publish. A
 * `Response` is meaningless there, so the verdict and its HTTP shape are now two
 * layers rather than one.
 */
export type LimitVerdict = { ok: true } | { ok: false; message: string };

function refuse(message: string): LimitCheck {
  // 403, not 404: unlike another customer's data, the existence of this
  // capability is not a secret — the account simply is not allowed to use it,
  // and saying so plainly is the only way they know to ask.
  return {
    ok: false,
    response: Response.json({ error: message, code: "not_permitted" }, { status: 403 }),
  };
}

function asCheck(verdict: LimitVerdict): LimitCheck {
  return verdict.ok ? { ok: true } : refuse(verdict.message);
}

/**
 * May this account start an import of this size?
 *
 * `threads` and `count` are checked here rather than clamped silently. Quietly
 * reducing 5000 products to a 1000-product ceiling would publish part of a
 * catalogue and report success — the operator has to be told, so they can decide.
 */
export async function importVerdict(
  ownerId: string,
  options: { count: number; threads: number },
): Promise<LimitVerdict> {
  const limits = await limitsFor(ownerId);

  if (!limits.importEnabled) {
    return {
      ok: false,
      message: "Importing is switched off for this account. Ask an administrator to enable it.",
    };
  }

  if (limits.maxProductsPerRun !== null && options.count > limits.maxProductsPerRun) {
    return {
      ok: false,
      message:
        `This run has ${options.count.toLocaleString("en-GB")} products, and this account is limited to ` +
        `${limits.maxProductsPerRun.toLocaleString("en-GB")} per run. Split the file, or ask an ` +
        `administrator to raise the limit.`,
    };
  }

  if (limits.maxThreads !== null && options.threads > limits.maxThreads) {
    return {
      ok: false,
      message:
        `This run asks for ${options.threads} parallel batches; this account is limited to ` +
        `${limits.maxThreads}. Lower "Parallel batches" in the import options.`,
    };
  }

  return { ok: true };
}

export async function checkImport(
  ownerId: string,
  options: { count: number; threads: number },
): Promise<LimitCheck> {
  return asCheck(await importVerdict(ownerId, options));
}

export async function removeVerdict(ownerId: string): Promise<LimitVerdict> {
  const limits = await limitsFor(ownerId);

  if (!limits.removeEnabled) {
    return {
      ok: false,
      message:
        "Removing products is switched off for this account. Ask an administrator to enable it.",
    };
  }

  return { ok: true };
}

export async function checkRemove(ownerId: string): Promise<LimitCheck> {
  return asCheck(await removeVerdict(ownerId));
}

/**
 * May this account change products that already exist?
 *
 * Its own switch, and its own worst case. An import that goes wrong adds products
 * somebody can delete; a bulk edit that goes wrong reprices a catalogue and
 * overwrites the only copy of what the prices were. So an operator can let a
 * customer import while withholding this.
 *
 * `maxProductsPerRun` is checked here too, against the same ceiling an import
 * obeys: a 5,000-product reprice is exactly as much work for the site as a
 * 5,000-product import, and an account limited to 1,000 is limited to 1,000. Refused
 * with the number named, never trimmed to fit.
 */
export async function productEditVerdict(
  ownerId: string,
  options: { count: number; threads: number },
): Promise<LimitVerdict> {
  const limits = await limitsFor(ownerId);

  if (!limits.productEditEnabled) {
    return {
      ok: false,
      message:
        "Changing products that already exist is switched off for this account. Ask an " +
        "administrator to enable it.",
    };
  }

  if (limits.maxProductsPerRun !== null && options.count > limits.maxProductsPerRun) {
    return {
      ok: false,
      message:
        `This change covers ${options.count.toLocaleString("en-GB")} products, and this account is ` +
        `limited to ${limits.maxProductsPerRun.toLocaleString("en-GB")} per run. Narrow the ` +
        `selection, or ask an administrator to raise the limit.`,
    };
  }

  if (limits.maxThreads !== null && options.threads > limits.maxThreads) {
    return {
      ok: false,
      message:
        `This run asks for ${options.threads} parallel batches; this account is limited to ` +
        `${limits.maxThreads}.`,
    };
  }

  return { ok: true };
}

export async function checkProductEdit(
  ownerId: string,
  options: { count: number; threads: number },
): Promise<LimitCheck> {
  return asCheck(await productEditVerdict(ownerId, options));
}

export async function checkS3(ownerId: string): Promise<LimitCheck> {
  const limits = await limitsFor(ownerId);

  if (!limits.s3Allowed) {
    return refuse(
      "Amazon S3 is not enabled for this account. Ask an administrator, or pick another image mode.",
    );
  }

  return { ok: true };
}

/** May this account connect one more site? */
export async function checkNewStore(ownerId: string): Promise<LimitCheck> {
  const limits = await limitsFor(ownerId);

  if (limits.maxStores === null) {
    return { ok: true };
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(stores)
    .where(eq(stores.ownerId, ownerId));

  const current = row?.count ?? 0;

  if (current >= limits.maxStores) {
    return refuse(
      limits.maxStores === 0
        ? "This account is not allowed to connect any sites."
        : `This account is limited to ${limits.maxStores} connected site` +
            `${limits.maxStores === 1 ? "" : "s"} and already has ${current}.`,
    );
  }

  return { ok: true };
}

/* ------------------------------------------------------- the operator's view */

export interface AccountRow {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  disabled: boolean;
  createdAt: string;
  limits: AccountLimits;
  /** True when an administrator has actually set limits for this account. */
  configured: boolean;
  stores: number;
  jobs: number;
}

/**
 * Every account with its limits — the administrator's accounts screen.
 *
 * `configured` matters on screen: "allowed everything because nobody decided"
 * and "allowed everything on purpose" look identical in the values alone, and an
 * operator auditing a customer needs to tell them apart.
 */
export async function listAccountsWithLimits(): Promise<AccountRow[]> {
  // Counts come from grouped sub-selects rather than N round trips: this is the
  // screen an operator opens to find the customer who just rang.
  const storeCounts = db
    .select({ owner: stores.ownerId, count: sql<number>`count(*)::int`.as("store_count") })
    .from(stores)
    .groupBy(stores.ownerId)
    .as("store_counts");

  const jobCounts = db
    .select({ owner: jobs.createdBy, count: sql<number>`count(*)::int`.as("job_count") })
    .from(jobs)
    .groupBy(jobs.createdBy)
    .as("job_counts");

  const [people, limits] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        disabledAt: users.disabledAt,
        createdAt: users.createdAt,
        stores: storeCounts.count,
        jobs: jobCounts.count,
      })
      .from(users)
      .leftJoin(storeCounts, eq(storeCounts.owner, users.id))
      .leftJoin(jobCounts, eq(jobCounts.owner, users.id))
      .orderBy(asc(users.createdAt)),
    allLimits(),
  ]);

  return people.map((person) => ({
    id: person.id,
    name: person.name,
    email: person.email,
    role: person.role,
    disabled: person.disabledAt !== null,
    createdAt: person.createdAt.toISOString(),
    limits: limits[person.id] ?? DEFAULT_LIMITS,
    configured: limits[person.id] !== undefined,
    stores: person.stores ?? 0,
    jobs: person.jobs ?? 0,
  }));
}
