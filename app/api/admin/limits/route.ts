import { z } from "zod";

import { limitsSchema, listAccountsWithLimits, saveLimits } from "@/lib/limits";
import { apiRequireAdmin } from "@/lib/session";
import { getAccount } from "@/lib/view";

/**
 * What each account is allowed to do.
 *
 * Administrators only, and separate from `/api/settings` on purpose: settings are
 * the account's own configuration and the account writes them, while these are the
 * operator's configuration OF the account and the account must never write them.
 * One route serving both would be one bug away from letting a customer raise their
 * own ceiling.
 */
export async function GET() {
  const guard = await apiRequireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ accounts: await listAccountsWithLimits() });
}

const bodySchema = z.object({ userId: z.string().min(1) }).and(limitsSchema);

export async function PUT(request: Request) {
  const guard = await apiRequireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const { userId, ...limits } = parsed.data;

  const account = await getAccount(userId);
  if (account === null) {
    return Response.json({ error: "No such account." }, { status: 404 });
  }

  return Response.json({
    limits: await saveLimits(userId, limits, guard.user.id),
    account: account.email,
  });
}
