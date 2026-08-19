/**
 * PM2 — the two processes this application needs in production.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * TWO, not one. Without the worker, jobs sit in the queue for ever and the interface
 * shows "Queued" and never moves. That is the single most common way to deploy this
 * wrongly, so it is worth saying twice.
 *
 * No secrets live in this file, deliberately: it is safe to commit. Both processes read
 * `.env` — the web app because Next.js loads it on its own, and the worker because it
 * is told to with `--env-file` (see below).
 */

/*
 * Adjust this if the checkout is not here. `cwd` has to be absolute: PM2 resurrects
 * processes from a saved list after a reboot, with no memory of where you were standing
 * when you started them.
 */
const ROOT = "/var/www/easyobot";

module.exports = {
  apps: [
    {
      name: "easyobot-web",
      cwd: ROOT,

      /*
       * Next's binary directly rather than `pnpm start`. PM2 would otherwise be
       * supervising pnpm, which supervises Next — so a restart kills the wrapper and
       * PM2 reports the app as up while the server underneath it is gone.
       */
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3000",

      /*
       * ONE instance, fork mode, on purpose.
       *
       * Cluster mode would work — no request state lives in this process; runs are in
       * Postgres and the queue is in Redis — but each instance opens its own Postgres
       * pool of `DB_POOL_MAX` (10 by default). Four instances is forty connections
       * before the worker asks for any, and Postgres's own default ceiling is a hundred.
       * Raise `instances` only together with `DB_POOL_MAX` and Postgres's
       * `max_connections`.
       */
      instances: 1,
      exec_mode: "fork",

      env: { NODE_ENV: "production" },

      max_memory_restart: "1G",
      autorestart: true,

      /*
       * Nothing is written here that is not already in Postgres, so these are for
       * reading during an incident rather than a record to keep.
       */
      out_file: "/var/log/easyobot/web.out.log",
      error_file: "/var/log/easyobot/web.err.log",
      time: true,
    },

    {
      name: "easyobot-worker",
      cwd: ROOT,

      /*
       * `--env-file` IS LOAD-BEARING, and this is the one non-obvious line in the file.
       *
       * Next.js loads `.env` for the web app by itself. `worker/index.ts` is a plain
       * Node process that never goes through Next's bundler, and it imports no `dotenv`
       * — so without this flag it starts with an empty environment and
       * `connectionString()` quietly falls back to
       * `postgresql://postgres:@localhost:5432/gop_import_product`. On a server where
       * that database happens to exist, the worker connects to the WRONG ONE and the
       * failure looks like "jobs never run" rather than like a configuration mistake.
       *
       * `tsx --env-file` rather than `node --env-file --import tsx`: the latter does not
       * work with this project, which is CJS. Verified, not assumed.
       */
      script: "node_modules/.bin/tsx",
      args: "--env-file=.env worker/index.ts",
      interpreter: "none",

      /*
       * ONE worker process, and this one is not a preference.
       *
       * Concurrency inside the worker is `WORKER_CONCURRENCY` (4 by default), which is
       * how many RUNS it handles at once. A second process does not divide that work —
       * it doubles it. Two consequences, and the second is easy to miss:
       *
       *  - `GOP_IMAGE_DOWNLOAD_LANES` is a ceiling PER PROCESS, so two workers means
       *    twice as many image downloads in flight as the number you configured;
       *  - each process opens its own Postgres pool.
       *
       * Scale by raising `WORKER_CONCURRENCY` first. Only run a second process when one
       * machine is genuinely saturated, and halve the two numbers above when you do.
       */
      instances: 1,
      exec_mode: "fork",

      env: { NODE_ENV: "production" },

      max_memory_restart: "2G",
      autorestart: true,

      /*
       * A run can take hours, and PM2 must not decide that a busy worker is a hung one.
       * `kill_timeout` gives an in-flight batch time to finish on a deliberate restart.
       */
      kill_timeout: 30000,

      out_file: "/var/log/easyobot/worker.out.log",
      error_file: "/var/log/easyobot/worker.err.log",
      time: true,
    },
  ],
};
