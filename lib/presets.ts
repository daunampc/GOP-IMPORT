import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { presets as presetsTable } from "@/db/schema";

import { importOptionsSchema } from "./import-options";

/**
 * Named sets of import options.
 *
 * The form has more than a dozen fields; whoever runs imports daily uses two or
 * three combinations and should not have to rebuild them each time.
 *
 * A preset deliberately does NOT carry a site. The site is a per-run choice,
 * and folding it in would mean picking the wrong preset sends stock to the
 * wrong shop.
 */

export interface Preset {
  id: string;
  name: string;
  createdAt: string;
  options: Record<string, unknown>;
}

const optionsSchema = importOptionsSchema.omit({ storeId: true });

export async function listPresets(ownerId: string): Promise<Preset[]> {
  const rows = await db
    .select()
    .from(presetsTable)
    .where(eq(presetsTable.createdBy, ownerId))
    .orderBy(presetsTable.name);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    options: row.options,
  }));
}

export async function savePreset(
  name: string,
  options: unknown,
  createdBy: string,
): Promise<Preset> {
  const parsed = optionsSchema.parse(options);
  const trimmed = name.trim();

  // Same name overwrites rather than creating a second entry — two presets with
  // one name in a picker is a thing nobody can use. Scoped to the account: the
  // uniqueness is on (created_by, name), so saving "Nightly feed" neither
  // overwrites another customer's preset of that name nor fails because they
  // got there first.
  const [row] = await db
    .insert(presetsTable)
    .values({
      id: randomUUID(),
      name: trimmed,
      createdBy,
      options: parsed as unknown as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: [presetsTable.createdBy, presetsTable.name],
      set: { options: parsed as unknown as Record<string, unknown> },
    })
    .returning();

  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    options: row.options,
  };
}

/** Ownership has already been established by `lib/ownership.ts` when this runs. */
export async function deletePreset(id: string): Promise<boolean> {
  const rows = await db
    .delete(presetsTable)
    .where(eq(presetsTable.id, id))
    .returning({ id: presetsTable.id });
  return rows.length > 0;
}

export async function countPresets(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(presetsTable)
    .where(eq(presetsTable.createdBy, ownerId));
  return row?.count ?? 0;
}
