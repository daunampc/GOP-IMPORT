/*
 * Do NOT import "server-only" here — the worker reads this too.
 */

import { createHash } from "node:crypto";
import { and, eq, isNull, or, gt } from "drizzle-orm";

import { db } from "@/db";
import { licenseKeys } from "@/db/schema";

import { GopApiError } from "./gop-client";
import { normalizeKey } from "./licenses";

/**
 * Is the SITE activated, and with THIS account's key?
 *
 * Two failures, and the whole point of this module is that they are different
 * sentences on screen rather than one "the site said no":
 *
 *  - **not activated** — the plugin has no valid key, so it refuses every request
 *    with a `license_*` code. The site is reachable and configured; somebody has to
 *    paste a key into wp-admin.
 *  - **the key does not match** — the plugin IS activated, with a key that is not the
 *    one this account redeemed. Someone pasted a neighbour's key, or a site was moved
 *    between accounts. This app refuses to publish to it, because writing a
 *    catalogue to a shop licensed to somebody else is not a mistake to make quietly.
 *
 * The comparison is on a FINGERPRINT, never a key: the plugin reports
 * `sha256(normalised key)` through `/health` and this computes the same hash from
 * the keys the account has activated. A leaked health response therefore hands over
 * nothing that can be redeemed.
 */

/** What the plugin's `/health` carries under `license`. */
export interface SiteLicenseReport {
  active?: boolean;
  code?: string;
  fingerprint?: string;
  expires_at?: string | null;
  verified_at?: string | null;
}

export function fingerprintOf(key: string): string {
  return createHash("sha256").update(normalizeKey(key)).digest("hex");
}

/** Every fingerprint this account is entitled to present. */
export async function accountFingerprints(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ key: licenseKeys.key })
    .from(licenseKeys)
    .where(
      and(
        eq(licenseKeys.activatedBy, ownerId),
        isNull(licenseKeys.revokedAt),
        // A key past its deadline cannot license a site any more than it can license
        // the account, and `or` keeps the ones that never expire.
        or(isNull(licenseKeys.expiresAt), gt(licenseKeys.expiresAt, new Date())),
      ),
    );

  return rows.map((row) => fingerprintOf(row.key));
}

export type SiteLicenseVerdict =
  | { ok: true }
  | { ok: false; code: "not_activated" | "key_mismatch" | "unknown"; message: string };

/**
 * Read the licence half of a `/health` answer and say whether a run may go ahead.
 *
 * `report` being absent means the site runs a plugin from before activation existed.
 * That is reported as `unknown` and treated as a REFUSAL rather than waved through:
 * an old plugin is a site nobody has activated, and the message says to update it
 * rather than leaving somebody to guess.
 */
export async function checkSiteLicense(
  ownerId: string,
  report: SiteLicenseReport | undefined,
): Promise<SiteLicenseVerdict> {
  if (report === undefined || typeof report.fingerprint !== "string") {
    return {
      ok: false,
      code: "unknown",
      message:
        "This site's plugin does not report an activation key, which means it is a build from " +
        "before activation existed. Update the plugin on the site, then activate it with this " +
        "account's licence key.",
    };
  }

  if (report.active !== true || report.fingerprint === "") {
    return {
      ok: false,
      code: "not_activated",
      message:
        "This site is not activated. Open GOP_IMPORT in its wp-admin and enter this account's " +
        `licence key${report.code === undefined ? "" : ` (the site says: ${report.code})`}.`,
    };
  }

  const allowed = await accountFingerprints(ownerId);

  if (allowed.length === 0) {
    return {
      ok: false,
      code: "key_mismatch",
      message:
        "This account has no licence key that is still valid, so there is nothing for the site's " +
        "key to match. Activate a key on this account first.",
    };
  }

  if (!allowed.includes(report.fingerprint)) {
    return {
      ok: false,
      code: "key_mismatch",
      message:
        "This site is activated with a DIFFERENT licence key from this account's. The two halves " +
        "must carry the same key. Enter this account's key in the site's wp-admin, or connect the " +
        "site from the account that owns the key it is using.",
    };
  }

  return { ok: true };
}

/**
 * Turn the plugin's own refusal into a sentence, when it refused before answering.
 *
 * With the gate covering every route, an unactivated site answers 403 with a
 * `license_*` code instead of any data — so this is what a caller sees first, and
 * "not activated" has to be said rather than "the site refused the request".
 */
export function describeLicenseError(error: unknown): string | null {
  if (!(error instanceof GopApiError) || !error.code.startsWith("license_")) {
    return null;
  }

  const what =
    error.code === "license_missing"
      ? "has no activation key yet"
      : error.code === "license_expired"
        ? "has an expired activation key"
        : error.code === "license_stale"
          ? "could not confirm its activation key with this app for too long"
          : "was refused when it checked its activation key";

  return (
    `This site ${what}, so its plugin is refusing every request. Open GOP_IMPORT in its ` +
    `wp-admin and activate it with this account's licence key. The site itself said: ` +
    `${error.message}`
  );
}
