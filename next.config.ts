import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Packages that must stay real Node imports instead of being bundled.
   *
   * Both are server-only libraries with dynamic requires that a bundler cannot
   * follow. The Postgres driver is postgres.js, which needs no such help — see
   * the note in db/index.ts for why it is not `pg`.
   */
  serverExternalPackages: ["ioredis", "bullmq"],
};

export default nextConfig;
