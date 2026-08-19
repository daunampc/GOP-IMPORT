import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { licenseKeys } from "@/db/schema";
import { normalizeKey } from "@/lib/licenses";

/**
 * Is this activation key good? — asked by the PLUGIN on a site, not by a browser.
 *
 * The other half of "the same key on both sides". A site enters the key its owner
 * activated here; the plugin asks this, stores the answer, and refuses to be written
 * to without it. The reverse direction is the fingerprint in the plugin's `/health`,
 * which lets this app confirm a site is running its own account's key.
 *
 * PUBLIC, and it has to be: the caller is a WordPress site with no session and no
 * account here. What that means for what it may say is the whole design of the
 * response — see below.
 *
 * A key counts as valid only when an ACCOUNT HAS ACTIVATED IT. A minted key nobody
 * has redeemed is not "in use", and a plugin licensed by one would be licensed by a
 * key that belongs to no customer — which is exactly the case "the keys must match"
 * exists to rule out.
 */

const bodySchema = z.object({
  key: z.string().min(1, "Missing the key"),
  /** Recorded in the answer only; the site says who is asking. */
  siteUrl: z.string().optional(),
  pluginVersion: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json({ valid: false, status: "malformed" }, { status: 400 });
  }

  const key = normalizeKey(parsed.data.key);

  const [row] = await db
    .select()
    .from(licenseKeys)
    .where(eq(licenseKeys.key, key))
    .limit(1);

  /*
   * What this may and may not say.
   *
   * It names the STATE of the key — unknown, revoked, expired, not yet activated,
   * active — because the person reading it is the site owner trying to work out why
   * their import is refused, and "invalid" alone would send them to support for
   * something they could have fixed themselves.
   *
   * It never names the ACCOUNT: no email, no id, no site list. A key is a bearer
   * token, and anybody holding one could otherwise ask this endpoint who its
   * customer is. The keys are random 60+ bit strings, so distinguishing "unknown"
   * from "expired" gives an enumeration attack nothing it could use.
   */
  if (row === undefined) {
    return Response.json({ valid: false, status: "unknown", expiresAt: null });
  }

  const expired = row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();

  const status =
    row.revokedAt !== null
      ? "revoked"
      : expired
        ? "expired"
        : row.activatedBy === null
          ? "not_activated"
          : "active";

  return Response.json({
    valid: status === "active",
    status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    /*
     * The same fingerprint the plugin computes and reports through `/health`:
     * SHA-256 of the normalised key. Returned so a site can confirm the two ends
     * agree on the algorithm — a mismatch here is a bug, not a licence problem.
     */
    fingerprint: createHash("sha256").update(key).digest("hex"),
  });
}
