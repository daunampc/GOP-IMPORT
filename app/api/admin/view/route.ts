import { cookies } from "next/headers";
import { z } from "zod";

import { apiRequireActive, apiRequireAdmin } from "@/lib/session";
import { VIEW_COOKIE, getAccount } from "@/lib/view";

/**
 * Enter and leave another account.
 *
 * The cookie this sets is NOT a capability. `lib/view.ts` re-authorises it from
 * the database on every single request, exactly as `getSessionUser()` re-reads
 * the licence rather than trusting what the session was minted with — so a
 * member who forges the cookie by hand gets their own data and nothing else,
 * and an administrator demoted to member stops being inside the account on
 * their very next request rather than whenever the session happens to expire.
 *
 * It is `httpOnly` all the same: nothing in the browser needs to read it, and a
 * cookie no script can touch is one fewer thing an XSS can flip.
 */

const bodySchema = z.object({
  userId: z.string().min(1, "Which account?"),
});

export async function POST(request: Request) {
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

  const account = await getAccount(parsed.data.userId);
  if (account === null) {
    return Response.json({ error: "No such account." }, { status: 404 });
  }

  const jar = await cookies();

  // Pointing it at yourself is "leave", not "enter your own account as if it
  // were someone else's" — otherwise the warning bar would be showing while the
  // data on screen is the administrator's own.
  if (account.id === guard.user.id) {
    jar.delete(VIEW_COOKIE);
    return Response.json({ actingAs: null });
  }

  jar.set(VIEW_COOKIE, account.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    // Session-length on purpose: closing the browser leaves the account. An
    // operator should have to say so again tomorrow.
  });

  return Response.json({ actingAs: { id: account.id, email: account.email, name: account.name } });
}

/**
 * Leave.
 *
 * Deliberately only requires an active account rather than an administrator: if
 * an administrator is demoted while inside someone else's account, they must
 * still be able to clear the cookie. (They already see their own data at that
 * point — the cookie stops being honoured — but leaving a dead cookie behind is
 * untidy in a place where tidiness is the feature.)
 */
export async function DELETE() {
  const guard = await apiRequireActive();
  if (!guard.ok) {
    return guard.response;
  }

  (await cookies()).delete(VIEW_COOKIE);

  return Response.json({ actingAs: null });
}
