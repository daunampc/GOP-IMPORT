/*
 * Do NOT import "server-only" here.
 *
 * This module is in worker/index.ts's import graph — a plain Node process that
 * never goes through Next.js's bundler, and `server-only` throws the moment it
 * is required outside a React Server Component.
 *
 * The guard against reaching the browser is that this module opens a TCP
 * connection: importing it from a Client Component fails the build.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/**
 * The Postgres connection.
 *
 * Uses postgres.js rather than `pg` deliberately. `pg` resolves sub-modules and
 * optional native bindings at runtime, and Turbopack turns that into an
 * external import it cannot resolve through pnpm's store — the built server
 * dies on its first query with "Cannot find package 'pg-<hash>'". postgres.js
 * is pure JavaScript with static imports, so it bundles correctly.
 *
 * Cached on globalThis in development: Next.js re-evaluates modules on every
 * hot reload, and without the cache each edit opens another pool until
 * Postgres starts refusing connections.
 */

declare global {
  var __gopSql: ReturnType<typeof postgres> | undefined;
}

export function connectionString(): string {
  if (process.env.DATABASE_URL?.trim()) {
    return process.env.DATABASE_URL.trim();
  }

  // Assembled from parts so a password containing `@`, `/` or `:` — which would
  // silently corrupt a hand-written URL — is escaped exactly once, here.
  const host = process.env.DB_HOST ?? "localhost";
  const port = process.env.DB_PORT ?? "5432";
  const user = encodeURIComponent(process.env.DB_USERNAME ?? "postgres");
  const password = encodeURIComponent(process.env.DB_PASSWORD ?? "");
  const database = process.env.DB_DATABASE ?? "gop_import_product";

  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

export const sql =
  globalThis.__gopSql ??
  postgres(connectionString(), {
    max: Number.parseInt(process.env.DB_POOL_MAX ?? "10", 10),
    idle_timeout: 30,
    // A handler that cannot get a connection should fail fast and say so,
    // rather than hang until the browser gives up.
    connect_timeout: 8,
    onnotice: () => {},
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__gopSql = sql;
}

export const db = drizzle(sql, { schema });

export type Database = typeof db;
export { schema };

/** Closes the connection. Only the worker and CLI scripts should call this. */
export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
}

export interface DatabaseHealth {
  ok: boolean;
  latencyMs: number;
  message: string;
  version: string | null;
  database: string | null;
}

/**
 * Answers "is the database reachable" in one call.
 *
 * Postgres now holds accounts, licences, sites and every run's history, so
 * losing it is not a degraded mode — it is the whole app down. The Settings
 * screen needs somewhere to say that plainly.
 */
export async function checkDatabase(): Promise<DatabaseHealth> {
  const startedAt = Date.now();

  try {
    const rows = await sql<
      Array<{ version: string; database: string }>
    >`select version() as version, current_database() as database`;

    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      version: rows[0]?.version ?? null,
      database: rows[0]?.database ?? null,
      message: "Connected",
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      version: null,
      database: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
