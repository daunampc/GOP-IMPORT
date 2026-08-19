import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { jobSchedules, jobs, presets, previews, stores } from "@/db/schema";

import { apiRequireActive, type SessionUser } from "./session";

/**
 * "Does this caller get to touch this row?", in one place.
 *
 * The guards in `lib/session.ts` answer "who is this" — and every route already
 * called one. What no route did was check that the thing it was about to cancel,
 * delete or export belonged to the caller, so knowing an id was enough for one
 * customer to act on another's run, site, preset or preview. That was the hole,
 * and it is the half a list filter does not close: filtering the list and
 * checking the id are two different bugs, and only the second one is reachable
 * by pasting a URL.
 *
 * The rule lives here rather than in eleven route handlers so that adding a
 * twelfth route means calling this, not remembering a policy.
 *
 * TWO HALVES, and both matter:
 *
 *  - A MEMBER gets 404 for a resource they do not own — never 403. A 403 says
 *    "this exists, but not for you", which tells them a run with that id is real
 *    and therefore something about another customer. 404 says nothing. To a
 *    member, another account's data is indistinguishable from data that was
 *    never there.
 *
 *  - An ADMINISTRATOR is allowed, on every resource, read and write. The
 *    isolation here is between customers; it is not between a customer and the
 *    operator. An administrator who cannot open a customer's run cannot repair
 *    it either.
 */

export type OwnedKind = "job" | "store" | "preset" | "preview" | "schedule";

const NOT_FOUND: Record<OwnedKind, string> = {
  job: "No such run",
  store: "No such site",
  preset: "No such preset",
  preview: "No such preview",
  schedule: "No such schedule",
};

/** The account a row belongs to, or null when there is no such row. */
export async function ownerOf(kind: OwnedKind, id: string): Promise<string | null> {
  switch (kind) {
    case "job": {
      const [row] = await db
        .select({ owner: jobs.createdBy })
        .from(jobs)
        .where(eq(jobs.id, id))
        .limit(1);
      return row?.owner ?? null;
    }
    case "store": {
      const [row] = await db
        .select({ owner: stores.ownerId })
        .from(stores)
        .where(eq(stores.id, id))
        .limit(1);
      return row?.owner ?? null;
    }
    case "preset": {
      const [row] = await db
        .select({ owner: presets.createdBy })
        .from(presets)
        .where(eq(presets.id, id))
        .limit(1);
      return row?.owner ?? null;
    }
    case "schedule": {
      const [row] = await db
        .select({ owner: jobSchedules.createdBy })
        .from(jobSchedules)
        .where(eq(jobSchedules.id, id))
        .limit(1);

      return row?.owner ?? null;
    }

    case "preview": {
      const [row] = await db
        .select({ owner: previews.createdBy })
        .from(previews)
        .where(eq(previews.id, id))
        .limit(1);
      return row?.owner ?? null;
    }
  }
}

export type OwnedGuard =
  | {
      ok: true;
      user: SessionUser;
      /**
       * The account the resource ACTUALLY belongs to — not the caller's.
       *
       * Downstream work has to use this: an administrator acting on a member's
       * run must reach for the member's site credentials and the member's S3
       * bucket, not their own.
       */
      ownerId: string;
    }
  | { ok: false; response: Response };

/**
 * Signed in, licensed, and entitled to this specific row.
 *
 * Replaces the `apiRequireActive()` call at the top of an `[id]` route rather
 * than sitting beside it, so a route cannot end up with the first check and not
 * the second.
 */
export async function apiRequireOwned(kind: OwnedKind, id: string): Promise<OwnedGuard> {
  const guard = await apiRequireActive();

  if (!guard.ok) {
    return guard;
  }

  const owner = await ownerOf(kind, id);

  // Genuinely absent, and absent-to-you, answer identically on purpose.
  if (owner === null || (guard.user.role !== "admin" && owner !== guard.user.id)) {
    return {
      ok: false,
      response: Response.json({ error: NOT_FOUND[kind] }, { status: 404 }),
    };
  }

  return { ok: true, user: guard.user, ownerId: owner };
}

/**
 * The same rule for a server component, which renders `notFound()` rather than
 * returning a status code.
 *
 * Returns the owning account so the page can load the rest of its data from the
 * right account — see `app/(app)/stores/[id]/page.tsx`.
 */
export async function pageOwnerOf(
  kind: OwnedKind,
  id: string,
  user: SessionUser,
): Promise<string | null> {
  const owner = await ownerOf(kind, id);

  if (owner === null) {
    return null;
  }

  if (user.role !== "admin" && owner !== user.id) {
    return null;
  }

  return owner;
}
