/**
 * Test accounts, made straight in Postgres.
 *
 * `tests/e2e.ts` drives the lib layer, not HTTP, so it never signs in and never
 * needs a password hash — it needs account ROWS for the owner columns to point
 * at. `tests/isolation.ts` is the one that goes through the real registration
 * and sign-in routes, because what it is testing is what a signed-in caller can
 * reach.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { licenseKeys, users } from "../db/schema";

export interface TestAccount {
  id: string;
  email: string;
  role: "admin" | "member";
}

export async function makeAccount(
  email: string,
  role: "admin" | "member" = "member",
): Promise<TestAccount> {
  const id = randomUUID();
  const licenseId = randomUUID();

  await db.insert(users).values({ id, name: email, email, role });

  // Every guard re-derives "activated" from a real licence row rather than from
  // a flag on the account, so a test account without one is a locked account.
  /*
   * The SITE's key, when the harness has staged one.
   *
   * The plugin refuses a site whose key is not the connecting account's, which is the
   * whole "both halves carry the same key" property — so a suite that talks to a real
   * plugin has to give its accounts the key that plugin was activated with. Without
   * this the e2e suite fails with "activated with a DIFFERENT licence key", which is
   * the feature working and the fixture being wrong.
   *
   * Unset elsewhere, so `isolation.sh` keeps a distinct key per account and goes on
   * testing what it was testing.
   */
  const fallback = `GOP-TEST-${id.slice(0, 8).toUpperCase()}`;
  const wanted = process.env.E2E_LICENSE_KEY ?? "";
  let key = fallback;

  if (wanted !== "") {
    // Given to the FIRST account only. `license_key.key` is unique — as it must be,
    // since a key binds to one account — so the site's key goes to the account that
    // connects the site and everybody else keeps their own.
    const [taken] = await db
      .select({ id: licenseKeys.id })
      .from(licenseKeys)
      .where(eq(licenseKeys.key, wanted))
      .limit(1);

    if (taken === undefined) {
      key = wanted;
    }
  }

  await db.insert(licenseKeys).values({
    id: licenseId,
    key,
    note: "test fixture",
    activatedBy: id,
    activatedAt: new Date(),
  });

  await db.update(users).set({ licenseKeyId: licenseId }).where(eq(users.id, id));

  return { id, email, role };
}
