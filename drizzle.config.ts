import { defineConfig } from "drizzle-kit";

/**
 * Reads the same environment variables as the app, so `pnpm db:generate` and
 * the running server can never disagree about which database they mean.
 */
const url =
  process.env.DATABASE_URL?.trim() ||
  `postgresql://${encodeURIComponent(process.env.DB_USERNAME ?? "postgres")}:` +
    `${encodeURIComponent(process.env.DB_PASSWORD ?? "")}@` +
    `${process.env.DB_HOST ?? "localhost"}:${process.env.DB_PORT ?? "5432"}/` +
    `${process.env.DB_DATABASE ?? "gop_import_product"}`;

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  casing: "snake_case",
});
