import { and, eq, lt } from "drizzle-orm";

import { db } from "@/db";
import { csvMaps } from "@/db/schema";

import type { KnownDialect } from "./sources/csv";

/**
 * Remembered column mappings, keyed by the signature of a file's header row.
 *
 * Remembered per FORMAT rather than per file: two exports from the same system
 * share a header row, so a mapping corrected once is applied automatically the
 * next time.
 *
 * And per ACCOUNT. The signature is the hash of a header row, so two customers
 * exporting from the same shop platform produce the same signature while
 * meaning entirely different things by it — keyed on the signature alone, one
 * customer's correction silently became everybody's.
 */

export interface StoredCsvMap {
  signature: string;
  dialect: KnownDialect;
  columnMap: Record<string, string>;
  savedAt: string;
}

export async function getCsvMap(
  ownerId: string,
  signature: string,
): Promise<StoredCsvMap | null> {
  const [row] = await db
    .select()
    .from(csvMaps)
    .where(and(eq(csvMaps.ownerId, ownerId), eq(csvMaps.signature, signature)))
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    signature: row.signature,
    dialect: row.dialect as KnownDialect,
    columnMap: row.columnMap,
    savedAt: row.savedAt.toISOString(),
  };
}

export async function saveCsvMap(
  ownerId: string,
  signature: string,
  dialect: KnownDialect,
  columnMap: Record<string, string>,
): Promise<StoredCsvMap> {
  // Only keep pairs with a value: storing the blanks would make next time's
  // mapping table look configured when it is not.
  const cleaned = Object.fromEntries(
    Object.entries(columnMap).filter(
      ([, value]) => typeof value === "string" && value.trim() !== "",
    ),
  );

  const [row] = await db
    .insert(csvMaps)
    .values({ ownerId, signature, dialect, columnMap: cleaned, savedAt: new Date() })
    .onConflictDoUpdate({
      target: [csvMaps.ownerId, csvMaps.signature],
      set: { dialect, columnMap: cleaned, savedAt: new Date() },
    })
    .returning();

  return {
    signature: row.signature,
    dialect: row.dialect as KnownDialect,
    columnMap: row.columnMap,
    savedAt: row.savedAt.toISOString(),
  };
}

export async function deleteCsvMap(ownerId: string, signature: string): Promise<void> {
  await db
    .delete(csvMaps)
    .where(and(eq(csvMaps.ownerId, ownerId), eq(csvMaps.signature, signature)));
}

export { lt };
