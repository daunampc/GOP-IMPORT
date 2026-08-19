import { z } from "zod";

import { createLicense, listLicenses } from "@/lib/licenses";
import { apiRequireAdmin } from "@/lib/session";

export async function GET() {
  const guard = await apiRequireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ licenses: await listLicenses() });
}

const bodySchema = z.object({
  note: z.string().trim().max(200).default(""),
  count: z.coerce.number().int().min(1).max(50).default(1),

  /**
   * How many days the key lasts ONCE ACTIVATED. Null means it never expires.
   *
   * The ordinary way to give a key a lifetime: the countdown starts when the
   * customer redeems it, so a batch minted in advance to sell does not lose days
   * sitting unredeemed.
   *
   * One day is a valid answer and so is 3650 — the administrator decides, and there
   * is no fixed set of options. The ceiling is only there to catch a typo where
   * somebody means 30 and hits an extra digit twice.
   */
  validDays: z.coerce.number().int().min(1).max(3650).nullable().default(null),

  /**
   * A hard deadline regardless of activation. ISO date, or null.
   *
   * Kept alongside `validDays` for the case of a trial tied to a date rather than
   * to a duration. Both together is allowed: whichever comes first ends the key.
   */
  expiresAt: z.string().datetime().nullable().default(null),
});

export async function POST(request: Request) {
  const guard = await apiRequireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const licenses = await createLicense({
    note: parsed.data.note,
    count: parsed.data.count,
    validDays: parsed.data.validDays,
    expiresAt: parsed.data.expiresAt === null ? null : new Date(parsed.data.expiresAt),
    createdBy: guard.user.id,
  });

  return Response.json({ licenses }, { status: 201 });
}
