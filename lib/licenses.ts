import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { licenseKeys, users } from "@/db/schema";

/**
 * Licence keys.
 *
 * The rule: an account cannot use the app until a key is bound to it, and a
 * key binds to exactly one account, once. Keys are minted by an admin.
 *
 * The very first account ever created is exempt — somebody has to be able to
 * mint the first key, and requiring a key to create the account that mints keys
 * is a locked door with the key inside.
 */

const GROUPS = 3;
const GROUP_LENGTH = 4;
/**
 * Crockford-style alphabet: no I, L, O, U. Keys get read aloud and typed by
 * hand, and those four are where transcription errors come from.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface License {
  id: string;
  key: string;
  note: string;
  createdAt: string;
  activatedAt: string | null;
  activatedByEmail: string | null;
  revokedAt: string | null;
  /**
   * The term, in days, that has NOT yet been applied. Null means no term.
   *
   * Read together with `expiresAt`: a key with `validDays: 30` and
   * `expiresAt: null` has thirty days waiting for it and has not been redeemed;
   * once redeemed, `expiresAt` is set and this stays only as a record of what was
   * sold.
   */
  validDays: number | null;
  expiresAt: string | null;
  status: LicenseStatus;
}

export type LicenseStatus = "available" | "active" | "revoked" | "expired";

export function generateKey(): string {
  const groups: string[] = [];

  for (let group = 0; group < GROUPS; group++) {
    let out = "";
    // randomBytes rather than Math.random: a guessable licence key is not a
    // licence.
    const bytes = randomBytes(GROUP_LENGTH);
    for (let index = 0; index < GROUP_LENGTH; index++) {
      out += ALPHABET[bytes[index] % ALPHABET.length];
    }
    groups.push(out);
  }

  return `GOP-${groups.join("-")}`;
}

/** Uppercase and strip stray spaces so "gop 4f2a…" pasted from chat still works. */
export function normalizeKey(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

function statusOf(row: typeof licenseKeys.$inferSelect): LicenseStatus {
  if (row.revokedAt !== null) {
    return "revoked";
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() < Date.now()) {
    return "expired";
  }
  return row.activatedBy === null ? "available" : "active";
}

export async function listLicenses(): Promise<License[]> {
  const rows = await db
    .select({
      license: licenseKeys,
      email: users.email,
    })
    .from(licenseKeys)
    .leftJoin(users, eq(users.id, licenseKeys.activatedBy))
    .orderBy(desc(licenseKeys.createdAt));

  return rows.map(({ license, email }) => ({
    id: license.id,
    key: license.key,
    note: license.note,
    createdAt: license.createdAt.toISOString(),
    activatedAt: license.activatedAt?.toISOString() ?? null,
    activatedByEmail: email,
    revokedAt: license.revokedAt?.toISOString() ?? null,
    validDays: license.validDays,
    expiresAt: license.expiresAt?.toISOString() ?? null,
    status: statusOf(license),
  }));
}

/**
 * Mint keys.
 *
 * Two ways to give a key a lifetime, and they answer different questions:
 *
 *  - `validDays` — "this key is good for 30 days of use". The countdown starts
 *    when somebody redeems it, so a batch minted in advance to sell does not rot
 *    on the shelf. This is the usual case.
 *  - `expiresAt` — "this key is dead after the 31st, redeemed or not". For a
 *    trial tied to a fixed date rather than to a duration.
 *
 * Both together is allowed and is not a contradiction: the term applies at
 * activation, and the hard deadline still cuts it short. Whichever comes first
 * wins, because `statusOf()` only ever reads `expiresAt`.
 */
export async function createLicense(input: {
  note?: string;
  expiresAt?: Date | null;
  validDays?: number | null;
  createdBy: string;
  count?: number;
}): Promise<License[]> {
  const count = Math.max(1, Math.min(input.count ?? 1, 50));
  const made: License[] = [];

  for (let index = 0; index < count; index++) {
    const [row] = await db
      .insert(licenseKeys)
      .values({
        id: randomUUID(),
        key: generateKey(),
        note: input.note?.trim() ?? "",
        createdBy: input.createdBy,
        expiresAt: input.expiresAt ?? null,
        validDays: input.validDays ?? null,
      })
      .returning();

    made.push({
      id: row.id,
      key: row.key,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      activatedAt: null,
      activatedByEmail: null,
      revokedAt: null,
      validDays: row.validDays,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      status: "available",
    });
  }

  return made;
}

/**
 * Revoking does not delete.
 *
 * The row stays so the history of who activated what survives; the app simply
 * stops accepting it, and any account holding it loses access at the next
 * check.
 */
export async function revokeLicense(id: string): Promise<boolean> {
  const rows = await db
    .update(licenseKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(licenseKeys.id, id), isNull(licenseKeys.revokedAt)))
    .returning({ id: licenseKeys.id });

  return rows.length > 0;
}

export interface ActivationResult {
  ok: boolean;
  error?: string;
  licenseId?: string;
  /**
   * When the key now dies, resolved at activation. Null means never.
   *
   * Returned so the activation screen can say "you have 30 days" at the moment it
   * matters, rather than leaving someone to find out on the day it stops working.
   */
  expiresAt?: string | null;
}

/**
 * Bind a key to an account.
 *
 * Done in a transaction with a conditional UPDATE so two people racing with
 * the same key cannot both win: the second one finds zero rows updated and is
 * told the key is taken.
 */
export async function activateLicense(
  userId: string,
  rawKey: string,
): Promise<ActivationResult> {
  const key = normalizeKey(rawKey);

  if (key === "") {
    return { ok: false, error: "Enter a licence key." };
  }

  return db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(licenseKeys)
      .where(eq(licenseKeys.key, key))
      .limit(1);

    if (!found) {
      return { ok: false, error: "That licence key does not exist." };
    }

    if (found.revokedAt !== null) {
      return { ok: false, error: "That licence key has been revoked." };
    }

    if (found.expiresAt !== null && found.expiresAt.getTime() < Date.now()) {
      return { ok: false, error: "That licence key has expired." };
    }

    if (found.activatedBy !== null && found.activatedBy !== userId) {
      return { ok: false, error: "That licence key is already in use on another account." };
    }

    /*
     * The term becomes a deadline HERE, and nowhere else.
     *
     * `valid_days` is what was sold; `expires_at` is what is enforced. Setting it
     * in the same statement that claims the key — rather than in a second write
     * afterwards — is what makes it impossible to end up with a key bound to an
     * account but with no expiry applied. A crash between two writes would have
     * produced exactly that: a 30-day key that never expires.
     *
     * Only when `expires_at` is not already set. An administrator who issued a
     * hard deadline as well keeps it, and a key being re-activated by the same
     * account does not get its clock reset — otherwise re-entering your own key
     * would be a free renewal.
     */
    const term =
      found.validDays !== null && found.expiresAt === null
        ? new Date(Date.now() + found.validDays * 24 * 60 * 60 * 1000)
        : found.expiresAt;

    // Conditional on still being unclaimed — this is the race guard.
    const claimed = await tx
      .update(licenseKeys)
      .set({ activatedBy: userId, activatedAt: new Date(), expiresAt: term })
      .where(and(eq(licenseKeys.id, found.id), isNull(licenseKeys.activatedBy)))
      .returning({ id: licenseKeys.id });

    if (claimed.length === 0 && found.activatedBy !== userId) {
      return { ok: false, error: "That licence key was just claimed by someone else." };
    }

    await tx.update(users).set({ licenseKeyId: found.id }).where(eq(users.id, userId));

    return { ok: true, licenseId: found.id, expiresAt: term?.toISOString() ?? null };
  });
}

/**
 * Is this account allowed in right now?
 *
 * Checked on every request rather than trusted from the session, so revoking a
 * key takes effect on the next page load instead of whenever the session
 * happens to expire.
 */
export async function isActivated(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ license: licenseKeys })
    .from(users)
    .leftJoin(licenseKeys, eq(licenseKeys.id, users.licenseKeyId))
    .where(eq(users.id, userId))
    .limit(1);

  if (!row?.license) {
    return false;
  }

  return statusOf(row.license) === "active";
}

/** Are there any accounts at all? Decides whether sign-up needs a key. */
export async function userCount(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  return row?.count ?? 0;
}
