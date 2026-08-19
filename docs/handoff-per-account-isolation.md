# Handoff — per-account isolation, with full administrator oversight

Paste everything below into a fresh Claude Code session. It assumes zero prior
context.

---

You are continuing work on GOP_IMPORT, a Next.js 16.3.1 web app that bulk
publishes products to WooCommerce sites through a PHP plugin. Six phases of
earlier work are finished and verified. This is one self-contained piece of work
on top of them.

## 0. Read before writing any code

1. `clients/manager-push-product-wordpress/AGENTS.md` — this is not the Next.js
   you know. Read the relevant guide under
   `clients/manager-push-product-wordpress/node_modules/next/dist/docs/` before
   writing code. At minimum: route handlers, async `params`/`searchParams`,
   caching, and the `RouteContext`/`PageProps`/`LayoutProps` helpers generated
   by `next typegen`.
2. `clients/manager-push-product-wordpress/README.md` — the data contract, the
   account model, and how a run survives a browser close.
3. `clients/manager-push-product-wordpress/db/schema.ts` — the whole data model
   is one file. Read it end to end; this task is mostly about it.
4. `clients/manager-push-product-wordpress/lib/session.ts` — the guards. They
   are the real security boundary.

## 1. The job

Two things at once:

**Customers are isolated from each other.** Treat an account like a customer
account at a shop: nothing about it is shared with another customer. Each
account has its own connected sites, its own runs, its own settings, its own
Amazon S3 credentials, its own presets and its own remembered CSV column maps.
One customer must not be able to see or touch another's anything — including by
pasting a known id into a URL.

**Administrators see and control everything.** An administrator operates the
service for its customers, so an administrator can read every account's data,
edit every account's settings, read every account's stored secrets in order to
repair them, and watch every account's runs.

The isolation is between customers. It is not between a customer and the
operator.

## 2. Decisions already taken by the owner — do not re-litigate

1. **Wipe all existing business data.** Do not migrate or backfill it. §4.1 says
   exactly what goes and what stays.
2. **Everything is per-account.** Three accounts means three separate sets of
   sites, runs, settings, S3 credentials, presets and column maps. Customers
   share nothing.
3. **Administrators have full rights over every account**: read all data, edit
   all settings, reveal stored secrets, cancel and manage any run, full
   oversight of every account's activity.
4. **Two accounts may connect the same WooCommerce site.** Each holds its own
   row with its own API key and secret; the plugin authenticates per key.
5. **Deleting an account takes its data with it** (cascade). A customer account
   that leaves does not leave sites and runs behind, owned by nobody.

### What "reveal stored secrets" means in practice

Today a site's `api_secret` and the S3 secret access key are encrypted at rest
with AES-256-GCM (`lib/crypto.ts`) and are **write-only** in the API: no route
returns them, and `getS3Public()` reports only whether one exists. Decision 3
changes that for administrators — they need the real value to repair a
customer's configuration.

Implement it, and implement these four things with it. They do not reduce what
an administrator can do; they stop a capability from becoming an accident:

- **Reveal is an explicit action, not a default.** A secret is returned by a
  dedicated endpoint the administrator has to call for one account at a time —
  never included in the ordinary settings or site payloads that every screen
  loads. A secret that arrives with every page load ends up in browser caches,
  screenshots and bug reports.
- **Every reveal is recorded**: who revealed what, for which account, when. An
  operator repairing a customer's bucket is normal; the record is what makes it
  possible to tell that apart from anything else later.
- **Secrets never reach a log, a URL or an error message.** Not the server log,
  not query strings, not an exception. `lib/crypto.ts` already exports `mask()`
  for anywhere a secret has to be referred to.
- **Every account sets its own secrets; only administrators read them back.** A
  member configures their own AWS keys and their own site credentials — that is
  the whole point of per-account settings, and nothing here restricts it. What a
  member cannot do is *reveal* a stored value, their own included: they
  overwrite it instead. So the only way a stored secret leaves the database is
  one named administrator action, which is what makes the audit trail mean
  something.

Consequence worth knowing while you build it: an administrator account now
carries every customer's AWS credentials and every customer's site credentials.
Its password is the key to all of them.

## 3. Where it stands — measured against the live database, not guessed

### The columns exist; almost nothing writes them

`job`, `preset` and `preview` all have a `created_by` column referencing
`user.id`. **Only one route in the entire app actually sets it**:
`app/api/purge/route.ts`. Verified against the live database:

```
RUNS by owner:
  (null — no owner):        5 runs   e.g. https://discoto.com/
  toshstack.dev@gmail.com:  2 runs   (the two removal runs)
  verify@localhost.test:    1 run    (a test run against a local plugin)
```

So:

- `app/api/import/route.ts` calls `enqueueImport()` **without** `createdBy` —
  every import started from the UI is owned by nobody.
- `app/api/import/preview/route.ts` calls `savePreview()` without the third
  argument — same.
- `app/api/presets/route.ts` does not record a creator either.

**Fix this first.** Until every creation path records its owner, each new run
arrives unowned and the isolation you are building has nothing to filter on.

### Reads that ignore ownership entirely

`listJobs()`, `jobsSnapshot()`, `listPresets()`, `getPreview()`,
`getPreviewProducts()` — none filter by user.

### Tables with no owner at all

| Table | Consequence |
|---|---|
| `store` | Every account sees and can use every connected site, with its credentials |
| `settings` | A **single row, `id = 1`**, holding import defaults AND the S3 access key / secret / bucket / region / public URL / prefix |
| `csv_map` | Keyed by column-set signature alone, so one account's mapping applies to everyone |

`settings` is the one real restructure. Every helper in `lib/settings.ts`
(`row()`, `getSettings`, `saveSettings`, `getS3Public`, `getS3Credentials`,
`saveS3`) assumes that single row exists and is the only one.

### Inherit ownership from a parent — leave the columns alone, but scope the reads

`job_item`, `job_result`, `job_batch` (cascade from `job`), `store_check`
(cascades from `store`).

### Stays global on purpose

`license_key` is minted by administrators for people who do not have an account
yet, so it cannot belong to the account that will claim it. `user`, `session`,
`account` and `verification` belong to better-auth.

### The guards, and the hole underneath them

`lib/session.ts` exports `apiRequireActive()` and `apiRequireAdmin()`, both
returning `{ ok: true, user }` or `{ ok: false, response }`. **All 25 API routes
already call one of them**, so the signed-in user is in scope everywhere — but
no route filters a list by that user, and no `[id]` route checks that the thing
it acts on belongs to the caller.

That second half is the security hole between customers. Today, knowing an id is
enough for one customer to cancel another's run, delete their site, or export
their results:

```
app/api/jobs/[id]/route.ts                 GET, DELETE
app/api/jobs/[id]/cancel/route.ts          POST
app/api/jobs/[id]/results/route.ts         GET
app/api/jobs/[id]/results/export/route.ts  GET
app/api/jobs/[id]/retry-failed/route.ts    POST
app/api/stores/[id]/route.ts               GET, PATCH, DELETE
app/api/stores/[id]/check/route.ts         POST
app/api/stores/[id]/maintenance/route.ts   POST
app/api/stores/[id]/terms/route.ts         GET
app/api/presets/[id]/route.ts              DELETE
app/api/import/preview/[id]/route.ts       GET
```

### Every call site that reads shared data today

Server components: `app/(app)/layout.tsx`, `app/(app)/page.tsx`,
`app/(app)/import/page.tsx`, `app/(app)/remove/page.tsx`,
`app/(app)/stores/page.tsx`, `app/(app)/stores/[id]/page.tsx`,
`app/(app)/settings/page.tsx`.

Route handlers: `app/api/jobs/route.ts`, `app/api/jobs/stream/route.ts`,
`app/api/jobs/cancel/route.ts`, `app/api/stores/route.ts`,
`app/api/stores/check/route.ts`, `app/api/presets/route.ts`,
`app/api/settings/route.ts`, `app/api/settings/s3/route.ts`,
`app/api/import/csv-map/route.ts`, plus the `[id]` routes above.

### The one that is easy to miss

`worker/index.ts` runs outside any request, so there is no session. It resolves
images through `lib/images.ts`, which calls `getS3Credentials()` — today that
reads the single global settings row. **After this change it must resolve the S3
credentials of the account that owns the run.** Get this wrong and one
customer's products upload into another customer's bucket.

## 4. What to build

Do it in this order; each step leaves the app working.

### 4.0 Record the owner (do this first)

Make every creation path write `created_by`: the import route, the preview
route, the preset route. The purge route already does — copy it.

### 4.1 Wipe, then migrate

No backfill. Per decision 1, the existing business data goes.

**Delete entirely:**

| Table | Note |
|---|---|
| `job`, `job_item`, `job_result`, `job_batch` | The children cascade from `job` |
| `store`, `store_check` | `store_check` cascades |
| `preview` | Transient anyway; they expire after an hour |
| `preset`, `csv_map` | |
| `settings` | Recreated per account |

**Keep:** `user`, `session`, `account`, `verification`, `license_key` — the
three accounts and their licences stay.

**Also delete the account `verify@localhost.test`** and anything left pointing
at it. It is a test account created during an earlier session, not the owner's.

Tell the owner plainly, once, before you run it: after the wipe they reconnect
their WooCommerce site and re-enter their AWS keys, because those rows are gone.

Then migrate:

- Add a **non-null** owner column to `store`, `csv_map` and `settings`. With the
  tables empty there is no default to invent and no inference to make — this is
  the whole reason the wipe makes the job simpler.
- Make `settings` per-account rather than a single `id = 1` row.
- Apply `on delete cascade` per decision 5 on every owner column.
- Add the indexes the new filters need. Every list query gains a
  `where owner = ?`; `job` is already indexed on `(status, created_at)` and
  `(store_id, created_at)`, so revisit those rather than merely adding to them.
- Add the table the reveal audit trail writes to (§2).

Generate with `drizzle-kit generate`, apply with `tsx db/migrate.ts`; commands
in §6. Back the database up first anyway — a wipe you meant is fine, a wipe of
the wrong database is not.

### 4.2 The data layer

Push the owner through `lib/stores.ts`, `lib/jobs.ts`, `lib/presets.ts`,
`lib/csv-maps.ts`, `lib/settings.ts`, `lib/preview.ts`, `lib/stats.ts`.

Make it impossible to forget rather than merely easy to remember: prefer a
signature that *demands* the owner (`listStores(userId)`) over one that accepts
it optionally (`listStores(userId?)`), so a missed call site is a type error
rather than a silent leak of one customer's data to another.

The administrator's cross-account view needs its own **explicitly named** way in
— `listAllStores()`, `allJobsSnapshot()`, `settingsFor(userId)` — rather than an
`includeEveryone` boolean threaded through the normal path. A flag that widens a
query is one typo away from putting every customer's data on an ordinary
customer's screen. The type system should make the two paths impossible to
confuse.

### 4.3 Ownership checks on every `[id]` route

For a member: a resource they do not own answers **404, not 403**. 403 confirms
the id exists, which tells them something about another customer.

For an administrator: allowed, on every one of those routes, read and write.

Put both halves in one shared helper so the rule lives in a single place, and so
that adding a route later means calling the helper rather than remembering the
policy.

### 4.4 The worker

Resolve per-account configuration from the run's owner. A run whose owner is
gone, or whose owner has no S3 credentials while the run asks for S3, must fail
the run with a message naming the cause — never fall back to another account's
credentials, and never silently behave like `keep_remote`. There is an existing
precedent for exactly this in `lib/images.ts`; follow it.

This is the single most dangerous part of the change. A member's run must use
that member's bucket even when an administrator started it on their behalf.

### 4.5 The interface

For a member, this is mostly invisible: the same screens, showing only their
own. Check that empty states still make sense for a brand-new account with no
sites, no runs and no S3 — several currently assume data exists somewhere.

The Settings S3 panel is administrator-only today (`canEditS3`). Every account
now has its own bucket, so **every account can edit its own**; the
administrator-only part is editing *someone else's*.

For an administrator, add what full oversight actually needs:

- a way to see all accounts' runs in one place, with the owning account on every
  row;
- a way to open one account and work as if inside it — its sites, its runs, its
  settings — with **unmistakable, persistent** indication of whose data is on
  screen. Not a badge in a corner. An administrator who forgets they are inside
  someone else's account is how 5000 products land in the wrong shop;
- the reveal action from §2, on the site and S3 credential screens.

### 4.6 Removal takes the whole selection in one run

Today a removal only ever takes **500 products per run**, and the owner wants
one run to finish the job.

Where the 500 comes from: `ProductDeleter::MAX_LOOKUP_LIMIT` in the plugin caps
what `POST /products/lookup` returns, `app/(app)/remove/remove-view.tsx` asks for
`limit: 500`, and the run is built from `lookup.products` — so "Every product on
the site" against a 3000-product shop removes 500 and shows a "the list is
longer than one page" warning telling you to run it again.

Change it so one confirmation removes everything the selection matched, while
keeping the property that makes the screen safe: **a filter is never what
executes — the operator confirms a known, counted set.** Concretely:

- give `POST /products/lookup` a mode that returns **ids only**, with no
  per-product summary, so tens of thousands of ids come back in one cheap call
  (the summary query is what makes 500 expensive, not the ids);
- keep showing a page of full detail — the first few hundred — for reading;
- stage the **complete** id list on the run, and make the count unmistakable on
  the confirm step: "this removes 3,412 products", not "this removes the 500
  below";
- the batching that remains is the plugin's `MAX_DELETE_BATCH` of 50 per HTTP
  request, which is a hard limit and stays. That is an internal detail of how
  one run is delivered, not a limit on what one run covers.

Removing tens of thousands of rows in one run also means: check that the
progress and per-row results screens hold up at that size (the results table
already paginates, `getResults` defaults to 500 with an offset), and that the
staged id list is not written as one enormous JSON blob without thinking about
it — `job_item` already exists for exactly this reason.

## 5. Verification

The existing suites must stay green, and this change needs tests that could not
have passed before it:

- `pnpm typecheck && pnpm lint && pnpm build` clean.
- `./tests/e2e.sh` green (it stands up Postgres, MySQL, the real PHP plugin,
  Redis and the worker, and asserts a run survives a process boundary — keep
  that property).
- **Customer isolation, asserted by id.** Two member accounts, each with a site
  and a run. Account B cannot: list A's runs or sites, read `/api/jobs/<A's id>`,
  cancel it, retry it, export its results, read `/api/stores/<A's id>`, check or
  maintain that site, delete A's preset, or read A's preview. B's settings and
  S3 credentials are a genuinely different row. Assert by **id**, not only by
  what the lists return: the list filter and the ownership check are two
  different bugs, and only the second is the security hole.
- **Administrator power.** An admin CAN read B's runs and sites, edit B's
  settings, cancel B's run, and reveal B's stored secrets — and every reveal
  writes an audit row naming the admin, the target account and the time.
- **A member cannot reveal a secret**, not even their own.
- **The worker uses the run owner's S3 credentials.** Two accounts with
  different buckets, one run each, and the right bucket used for each. Include
  the case where an administrator started the run on a member's behalf.
- **No secret in any log.** Grep the captured server output of the isolation
  test for the fixture secrets and assert nothing matches.
- **A removal covers the whole selection.** Seed more than 500 products on a
  test site, select "every product on the site", run it once, and assert the
  site has nothing left — the previous behaviour would leave the rest behind
  while reporting success.
- Walk it in a browser with **two accounts in two profiles**, in both themes:
  a member sees only their own; an admin can enter another account and it is
  obvious on screen whose data is showing.
- The design-system rule still holds:

```
grep -rnE '\b(bg|text|border)-(slate|gray|red|blue|emerald|amber)-[0-9]{2,3}\b' app components
```

must return nothing. The only permitted colour literal outside `globals.css` is
`themeColor` in `app/layout.tsx`, and it is commented as such.

Report honestly: separate what you verified and how from what you could not.
Do not call something done that has not been run.

## 6. Environment — read this or you will waste an hour

There is no Node.js on this machine. Docker is available. Every Node command
runs in a container against a Linux `node_modules` volume, so the host tree is
never polluted with Linux binaries.

Working directory for all commands:
`/Volumes/Personal/Company/toshstack.dev/clients/manager-push-product-wordpress`

Typecheck, lint and build. Always run typegen first if you deleted `.next`,
otherwise `RouteContext`/`PageProps`/`LayoutProps` are "Cannot find name" errors:

```bash
docker run --rm -v "$PWD":/app -v tsd-nm:/app/node_modules -w /app node:22-alpine \
  sh -c './node_modules/.bin/next typegen >/dev/null 2>&1;
          ./node_modules/.bin/tsc --noEmit &&
          ./node_modules/.bin/eslint &&
          ./node_modules/.bin/next build'
```

Database migrations:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$PWD":/app -v tsd-nm:/app/node_modules -w /app --env-file .env \
  -e DB_HOST=host.docker.internal node:22-alpine \
  sh -c './node_modules/.bin/drizzle-kit generate && ./node_modules/.bin/tsx db/migrate.ts'
```

Run the app against the real local Postgres and Redis. Credentials live in
`.env` (gitignored, chmod 600) — do not paste them anywhere. Inside a container,
`localhost` is the container, so use `host.docker.internal`:

```bash
docker run -d --name gop-web --add-host=host.docker.internal:host-gateway \
  -p 3100:3000 -v "$PWD":/app -v tsd-nm:/app/node_modules -w /app \
  --env-file .env -e DB_HOST=host.docker.internal \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e BETTER_AUTH_URL=http://localhost:3100 -e NODE_ENV=production \
  node:22-alpine ./node_modules/.bin/next start
```

The worker is a separate process and must be running for any job to move:

```bash
docker run -d --name gop-worker --add-host=host.docker.internal:host-gateway \
  -v "$PWD":/app -v tsd-nm:/app/node_modules -w /app --env-file .env \
  -e DB_HOST=host.docker.internal -e REDIS_URL=redis://host.docker.internal:6379 \
  node:22-alpine ./node_modules/.bin/tsx worker/index.ts
```

Postgres 17.9 and Redis 7 run on the host; the database is `gpm_import_product`.

The PHP plugin now lives in its **own checkout** at
`/Volumes/Personal/Company/GPM_toshstack/`, with its tests beside it
(`./tests/integration.sh`, 36/36) and `./build.sh` to package it. `tests/e2e.sh`
finds it automatically and honours `PLUGIN_DIR`. **This task needs no plugin
change** — the wire protocol and the `X-TSD-*` headers stay exactly as they are.

## 7. Traps already hit — do not rediscover these

- **`pg` does not work under Turbopack here.** It gets externalised to a hashed
  specifier that cannot resolve through pnpm's store, and the built server dies
  on its first query with `Cannot find package 'pg-<hash>'`.
  `serverExternalPackages` does not fix it. The driver is postgres.js
  (`drizzle-orm/postgres-js`). Do not switch back.
- **`ioredis`, `bullmq` and `postgres` must never reach a Client Component.**
  `lib/stores.ts`, `lib/jobs.ts` and `lib/purge.ts` import the database. Pure
  helpers a client needs live in `lib/store-links.ts`, `lib/plugin-version.ts`
  and `lib/purge-options.ts`. If the build says `Can't resolve 'net'`, a client
  component imported a server module.
- **Deleting `.next` breaks typecheck** until `next typegen` runs again.
- **`react-hooks/set-state-in-effect` is an error, not a warning.** Calling
  `setState` synchronously in an effect body fails lint. Patterns that work:
  derive the value instead of storing it; carry the key the data belongs to and
  compute "loading" from a mismatch; remount via `key`; or put the `setState`
  after an `await` inside an async IIFE.
- **Anything derived from "now" must not be rendered during SSR.** The server
  runs in UTC and the browser does not, so `Intl.DateTimeFormat`, "3 minutes
  ago" and elapsed timers all cause React hydration error #418. Use the existing
  `DateTime`, `RelativeTime`, `ElapsedTime` and `useHydrated` helpers in
  `components/ui/client-time.tsx`. `lib/format.ts` pins `en-GB` for the same
  reason.
- **Tailwind v4 has no `--duration-*` theme namespace.** The duration utilities
  are declared with `@utility` in `globals.css`.
- **The plugin caps batches at 50 products.** `MAX_BATCH_SIZE` is a hard limit,
  not a suggestion. `MAX_DELETE_BATCH` is the same for removals.
- **better-auth rejects a sign-in whose origin is not exactly
  `BETTER_AUTH_URL`.** This bites headless browsers: from inside a container,
  map `localhost` to the host gateway with Chrome's `--host-resolver-rules`
  rather than browsing to `host.docker.internal`, or every automated capture
  silently becomes the sign-in screen. See `docs/screenshots/README.md`.
- **A percentage height needs a parent with a real height.** A flex row with
  `items-end` shrinks its children to their content, so `height: 60%` inside
  resolves against zero and draws nothing. This is what made the dashboard's
  daily chart render blank.
- **An option must never silently decide whether a required field exists.**
  `addRandomSuffixToSlug` used to be the only thing that assigned a slug, so
  turning it off shipped every product with an empty `post_name` and WordPress
  published them at `domain.com/product//`. Already fixed on both sides — the
  option now controls the suffix only, `slugBase()` in `lib/transform.ts` walks
  slug → name → SKU → a deterministic hash, and `Normalizer::slug()` in the
  plugin does the same as defence in depth because `index.php` is a public API.
  There are tests for both. Worth knowing while you work: the slug feeds the
  idempotency key, so anything imported before the fix has a different key now
  and will not deduplicate against a re-import.

## 8. How to work

Work in steps and stop for a short report between them. Decide ordinary
questions yourself and say what you chose; §2 has already settled the ones that
matter.

Tell the owner before you run the wipe, then run it — they have asked for it and
know the site and AWS keys have to be re-entered afterwards.

If you have to cut scope for a technical reason, say which part and why rather
than quietly dropping it.
