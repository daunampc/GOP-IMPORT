import "server-only";

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users } from "@/db/schema";

import {
  apiRequireActive,
  requireActive,
  type ApiGuard,
  type SessionUser,
} from "./session";

/**
 * Whose data is on the screen.
 *
 * An administrator operates the service for its customers, so §4.5 asks for a
 * way to "open one account and work as if inside it — its sites, its runs, its
 * settings". This is that: one cookie naming an account, resolved once per
 * request, producing the `ownerId` that EVERY page and route then reads and
 * writes through.
 *
 * Three properties worth stating, because each of them is load-bearing:
 *
 *  1. The cookie is only ever honoured for an administrator. It is not a
 *     capability — it is a preference that gets re-authorised on every single
 *     request against the database, exactly like `getSessionUser()` re-reads the
 *     licence rather than trusting the session. A member who sets the cookie by
 *     hand gets their own data and nothing else.
 *
 *  2. `ownerId` is what creates as well as what reads. An import started while
 *     inside a member's account is the MEMBER's run — owned by them, listed for
 *     them, and (this is the dangerous part) executed by the worker against the
 *     member's S3 bucket. An administrator acting on someone's behalf must not
 *     quietly move that account's products into the administrator's bucket.
 *
 *  3. Because of 2, the indication on screen cannot be a badge in a corner. It
 *     is a persistent full-width bar rendered by the app shell, above
 *     everything, on every screen — see `components/shell/acting-as-bar.tsx`.
 *     An administrator who forgets they are inside someone else's account is how
 *     5000 products land in the wrong shop.
 */

export const VIEW_COOKIE = "gop_view_account";

export interface ActingAs {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
}

export interface ViewContext {
  /** Who is signed in. Never changes with the cookie. */
  user: SessionUser;
  /** Whose data this request reads and writes. */
  ownerId: string;
  /** Null when an administrator is in their own account, or for any member. */
  actingAs: ActingAs | null;
}

/**
 * Resolve the cookie, re-authorising it from scratch.
 *
 * Returns null for anyone who is not an administrator, for an unset cookie, for
 * an administrator pointing it at themselves, and for an account that has since
 * been deleted — so a stale cookie degrades to "your own data" rather than to an
 * error page.
 */
async function resolveActingAs(user: SessionUser): Promise<ActingAs | null> {
  if (user.role !== "admin") {
    return null;
  }

  const raw = (await cookies()).get(VIEW_COOKIE)?.value?.trim();

  if (!raw || raw === user.id) {
    return null;
  }

  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, raw))
    .limit(1);

  return row ?? null;
}

export async function requireView(): Promise<ViewContext> {
  const user = await requireActive();
  const actingAs = await resolveActingAs(user);

  return { user, ownerId: actingAs?.id ?? user.id, actingAs };
}

export type ApiViewGuard =
  | { ok: true; user: SessionUser; ownerId: string; actingAs: ActingAs | null }
  | { ok: false; response: Response };

/**
 * An administrator account is not a customer account.
 *
 * It exists to run the service: accounts, runs, keys and the sites customers
 * connect. It does not publish products of its own, so the creation routes refuse
 * it — unless it is INSIDE a customer's account, where publishing on their behalf
 * is support work and the run belongs to them.
 *
 * Refused at the route rather than only hidden in the navigation, because the
 * navigation is a courtesy and the API is the boundary.
 */
export function refusePublishingAsAdmin(guard: {
  user: SessionUser;
  actingAs: ActingAs | null;
}): Response | null {
  if (guard.user.role !== "admin" || guard.actingAs !== null) {
    return null;
  }

  return Response.json(
    {
      error:
        "An administrator account does not publish products. Open the customer's account " +
        "from the Accounts screen and run it there, so the run belongs to them — and uses " +
        "their site and their S3 bucket.",
      code: "admin_cannot_publish",
    },
    { status: 403 },
  );
}

/**
 * The route-handler form.
 *
 * Every route that reads or writes account-scoped data uses this INSTEAD of
 * `apiRequireActive()`, so a screen opened inside another account and the API
 * calls that screen makes cannot disagree about whose data they mean.
 */
export async function apiRequireView(): Promise<ApiViewGuard> {
  const guard: ApiGuard = await apiRequireActive();

  if (!guard.ok) {
    return guard;
  }

  const actingAs = await resolveActingAs(guard.user);

  return {
    ok: true,
    user: guard.user,
    ownerId: actingAs?.id ?? guard.user.id,
    actingAs,
  };
}

/* ----------------------------------------------------------------- accounts */

/*
 * The accounts LIST lives in `lib/limits.ts` as `listAccountsWithLimits()`.
 *
 * It used to be duplicated here without the permissions, and two near-identical
 * account queries is how one of them quietly stops matching the other.
 */

/** One account, for naming it on screen and in an audit row. */
export async function getAccount(id: string): Promise<ActingAs | null> {
  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  return row ?? null;
}
