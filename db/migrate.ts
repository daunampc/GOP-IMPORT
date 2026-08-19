/**
 * Applies pending migrations.
 *
 *   pnpm db:migrate
 *
 * Safe to run repeatedly: Drizzle records what it has applied.
 *
 * There is nothing to seed. `settings` used to be a single row pinned at
 * `id = 1`, created here so every read could assume it existed; it is now one
 * row per account, keyed by the owner, and there is no account to attach a row
 * to at migration time. `lib/settings.ts` creates an account's row the first
 * time that account reads its settings.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";

import { closeDatabase, db } from "./index";
import { settings } from "./schema";

async function main(): Promise<void> {
  console.log("[db] applying migrations…");
  await migrate(db, { migrationsFolder: "./db/migrations" });

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(settings);

  console.log(`[db] done. per-account settings rows: ${count}`);
}

void main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[db] migration failed:", error);
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
