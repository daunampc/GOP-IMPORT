import "server-only";

import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { secretReveals, users } from "@/db/schema";

/**
 * The record of every stored secret an administrator has read back.
 *
 * Revealing is a legitimate power — an operator repairing a customer's bucket or
 * a site whose API key was rotated needs the real value, and §2 grants it. This
 * file is the thing that stops the power from becoming an accident. Four rules,
 * and the whole design follows from them:
 *
 *  1. Reveal is an explicit action, never a default. No settings payload and no
 *     site payload carries a secret; one endpoint returns one secret for one
 *     account, and it has to be called on purpose. A secret that arrives with
 *     every page load ends up in browser caches, screenshots and bug reports.
 *
 *  2. Every reveal is recorded: who, what, for which account, when.
 *
 *  3. The record holds NO secret. `kind` and `subjectLabel` say which one was
 *     read — a site URL, a bucket name — never the value.
 *
 *  4. Nothing here reaches a log, a URL or an error message. `mask()` in
 *     `lib/crypto.ts` exists for anywhere a secret has to be referred to at all.
 */

export type RevealKind = "store_api_secret" | "s3_secret_key";

export interface RevealRecord {
  id: string;
  at: string;
  actorEmail: string;
  targetEmail: string;
  kind: RevealKind;
  subjectId: string | null;
  subjectLabel: string;
  ipAddress: string | null;
}

export interface RecordRevealInput {
  actor: { id: string; email: string };
  target: { id: string; email: string };
  kind: RevealKind;
  /** The store's id, or null for the account-level S3 key. */
  subjectId: string | null;
  /** Human-readable and never sensitive: a site URL, or a bucket name. */
  subjectLabel: string;
  /** The request, so the row can carry where it came from. */
  request: Request;
}

/**
 * Write the audit row.
 *
 * Awaited by its caller BEFORE the secret is put in the response: a reveal that
 * happened without a record is precisely the thing this table exists to make
 * impossible, so if the write fails the reveal fails with it.
 */
export async function recordReveal(input: RecordRevealInput): Promise<void> {
  const headers = input.request.headers;

  await db.insert(secretReveals).values({
    id: randomUUID(),
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    targetUserId: input.target.id,
    targetEmail: input.target.email,
    kind: input.kind,
    subjectId: input.subjectId,
    subjectLabel: input.subjectLabel,
    // Behind a proxy the socket address is the proxy's, so the forwarded header
    // is the only thing worth keeping. Its first entry is the client.
    ipAddress: headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: headers.get("user-agent"),
  });
}

export async function listReveals(limit = 200): Promise<RevealRecord[]> {
  const rows = await db
    .select()
    .from(secretReveals)
    .orderBy(desc(secretReveals.at))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    at: row.at.toISOString(),
    actorEmail: row.actorEmail,
    targetEmail: row.targetEmail,
    kind: row.kind,
    subjectId: row.subjectId,
    subjectLabel: row.subjectLabel,
    ipAddress: row.ipAddress,
  }));
}

/** An account's email, for naming the target of a reveal in the record. */
export async function emailOf(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return row?.email ?? null;
}
