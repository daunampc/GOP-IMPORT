import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { licenseKeys, users } from "@/db/schema";

import { auth } from "./auth";

/**
 * The access rules, in one place.
 *
 * This is the real boundary. Next 16's `proxy.ts` runs detached from the app
 * and may be deployed to a CDN, so it cannot be trusted to reach the database —
 * every page group and every route handler asks here instead.
 *
 * Three levels, each strictly stronger than the last:
 *   getSessionUser  — who is this, if anyone
 *   requireUser     — signed in
 *   requireActive   — signed in AND holding a valid licence
 *   requireAdmin    — signed in, licensed, and an admin
 */

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  licenseKeyId: string | null;
  /** Re-derived from the database on every call, never read from the session. */
  activated: boolean;
  licenseKey: string | null;
  disabled: boolean;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session?.user?.id) {
    return null;
  }

  // Re-read the account and its licence rather than trusting what the session
  // was minted with: revoking a key or disabling an account has to bite on the
  // next request, not whenever the session happens to expire.
  const [row] = await db
    .select({ user: users, license: licenseKeys })
    .from(users)
    .leftJoin(licenseKeys, eq(licenseKeys.id, users.licenseKeyId))
    .where(eq(users.id, session.user.id))
    .limit(1);

  if (!row) {
    return null;
  }

  const license = row.license;
  const activated =
    license !== null &&
    license.revokedAt === null &&
    (license.expiresAt === null || license.expiresAt.getTime() > Date.now());

  return {
    id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.user.role,
    licenseKeyId: row.user.licenseKeyId,
    activated,
    licenseKey: license?.key ?? null,
    disabled: row.user.disabledAt !== null,
  };
}

/** Signed in, or bounced to sign-in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();

  if (user === null) {
    redirect("/sign-in");
  }

  if (user.disabled) {
    redirect("/sign-in?reason=disabled");
  }

  return user;
}

/** Signed in and licensed, or bounced to activation. */
export async function requireActive(): Promise<SessionUser> {
  const user = await requireUser();

  if (!user.activated) {
    redirect("/activate");
  }

  return user;
}

/** Admin only. Members get the dashboard, not a 403 they cannot act on. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireActive();

  if (user.role !== "admin") {
    redirect("/");
  }

  return user;
}

/* ------------------------------------------------------------------- API */

/**
 * Guards for route handlers.
 *
 * These return a Response instead of redirecting: an API caller wants a status
 * code it can branch on, not an HTML sign-in page with status 200.
 */

export type ApiGuard =
  | { ok: true; user: SessionUser }
  | { ok: false; response: Response };

export async function apiRequireActive(): Promise<ApiGuard> {
  const user = await getSessionUser();

  if (user === null) {
    return {
      ok: false,
      response: Response.json({ error: "Not signed in." }, { status: 401 }),
    };
  }

  if (user.disabled) {
    return {
      ok: false,
      response: Response.json({ error: "This account is disabled." }, { status: 403 }),
    };
  }

  if (!user.activated) {
    return {
      ok: false,
      response: Response.json(
        { error: "No active licence on this account.", code: "license_required" },
        { status: 403 },
      ),
    };
  }

  return { ok: true, user };
}

export async function apiRequireAdmin(): Promise<ApiGuard> {
  const guard = await apiRequireActive();

  if (!guard.ok) {
    return guard;
  }

  if (guard.user.role !== "admin") {
    return {
      ok: false,
      response: Response.json({ error: "Administrators only." }, { status: 403 }),
    };
  }

  return guard;
}
