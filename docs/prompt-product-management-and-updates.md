# Next task: updating products, checking SKUs, and a product manager for customers

## Tóm tắt cho chủ sản phẩm (tiếng Việt)

Bốn việc, làm theo thứ tự này:

1. **Plugin: thêm route cập nhật sản phẩm** (`POST /products/update`). Hiện plugin
   chỉ tạo, chưa bao giờ sửa — nên không đổi được giá hay tồn kho hàng loạt. Đây là
   thiếu sót lớn nhất.
2. **Plugin: thêm route kiểm SKU đã tồn tại** (`POST /products/exists`), để preview
   cảnh báo TRƯỚC khi chạy thay vì biết sau.
3. **Web: màn hình quản lý sản phẩm cho tài khoản khách** (`/products`) — xem, tìm,
   sửa giá/tồn kho, sửa hàng loạt, xoá lẻ. Đây là chức năng mới lớn nhất và nó phụ
   thuộc việc 1.
4. **Web: tự thử lại lỗi tạm thời** ở mức batch, thay vì bắt bấm tay.

Cộng thêm plugin route `recalculate-prices` (nhỏ, gộp cùng đợt) và bốn cải thiện
nhỏ ở §6.

**Đã bỏ khỏi phạm vi:** dọn run mồ côi. Run mắc ở "Cancelling" trên máy chủ dev là
do chủ sản phẩm tự import rồi dừng, không phải lỗi cần sửa.

---

## 0. Read before writing any code

1. `clients/manager-push-product-wordpress/AGENTS.md` — this is not the Next.js you
   know. Read the relevant guide under
   `clients/manager-push-product-wordpress/node_modules/next/dist/docs/` before
   writing code: route handlers, async `params`/`searchParams`, and the
   `RouteContext`/`PageProps`/`LayoutProps` helpers from `next typegen`.
2. `clients/manager-push-product-wordpress/README.md` — the data contract, the
   account model, how a run survives a browser close, and the **Not verified**
   section, which is honest and worth trusting.
3. `docs/superpowers/specs/2026-08-17-csv-detect-logs-license-design.md` — the last
   task's design, including two corrections it makes to its own earlier claims.
   Read those corrections; they are about traps in this codebase.
4. `lib/gop-client.ts` — the wire protocol, the request deadline, `GopAbortError`.
5. `lib/jobs.ts`, `worker/index.ts` — the queue, the run engine, the cancel record.
6. `lib/ownership.ts`, `lib/view.ts`, `lib/limits.ts` — the three things every new
   route must go through. Non-negotiable.
7. The plugin: `/Volumes/Personal/Company/GPM_toshstack/` — `index.php` (the whole
   dispatch table is 40 lines), `src/Import/ProductImporter.php`,
   `src/Import/ProductDeleter.php`, `src/Import/Normalizer.php`.

## 1. Measured facts — verified by reading the source, do not re-derive

### 1.1 The plugin has exactly six routes

From `index.php`'s `dispatch()`:

```
GET  /health
GET  /terms/{taxonomy}
POST /products/batch
POST /products/lookup
POST /products/delete
POST /images/fetch
POST /maintenance/clear-transients
```

Anything else answers `404 unknown_route`.

### 1.2 The plugin CANNOT update a product. This is the whole reason for this task.

`src/Import/ProductImporter.php`, in `importOne()`:

```php
$existing = $this->findByIdempotencyKey($idempotencyKey);
if ($existing !== null) {
    return $existing + ['deduplicated' => true];   // and changes NOTHING
}
```

There is no `updateProduct`, no upsert, no partial write. `src/Import/` contains
only `ProductImporter`, `ProductDeleter`, `Normalizer`, `MetaBuilder` and
`ValidationException`.

**Consequence:** prices and stock cannot be changed in bulk at all. The only route
today is delete-then-reimport, which loses the `product_id`, the reviews, the URL
and anything pointing at it. For a real shop prices change weekly, so this is the
most frequent operation the tool cannot do.

### 1.3 The app never asks whether a SKU already exists on the site

`lib/preview.ts` has `findDuplicateSkus`, which finds SKUs repeated **inside the
file**. Nothing anywhere calls `lookupProducts({ skus })` before a run. So a file
whose SKUs already exist on the site imports as new products (a different
idempotency key means a different product), and the operator finds out afterwards.

### 1.4 There is no product management screen

The app has `/import`, `/remove`, `/process`, `/stores`, `/settings`, `/admin`. There
is **no** screen that lists what is on a site. `/remove` uses `lookupProducts` to
build a deletion list and then throws the list away.

### 1.5 A run does not retry

`lib/jobs.ts`: `attempts: 1`. A `request_timeout` — the most common transient
failure, and one the last task made properly attributable — requires a human to
press "Resend the failures".

### 1.6 Lookup ceilings, which are real and stay

`MAX_LOOKUP_PAGE = 500` (per-product summary), `MAX_LOOKUP_IDS = 100_000`
(`ids_only` mode). A product manager listing a 50,000-product catalogue has to page
through the summary lookup; it cannot ask for everything at once.

## 2. What to build

### 2.1 Plugin: `POST /products/update`

The single most valuable thing in this task, and the most dangerous. It writes over
products that are on sale.

- Match by `sku`, or by `idempotency_key` when one is supplied. Ambiguity — two
  products with the same SKU — is an error for that row, never a guess.
- **Partial update.** Only fields PRESENT in the request are written. A payload of
  `{sku, price}` changes the price and must not blank the description, the images,
  the categories or the stock. This is the property the whole feature rests on:
  anything else turns a price sync into catalogue destruction.
- Distinguish "absent" from "empty". `{"description": ""}` means *clear it*;
  omitting `description` means *leave it alone*. JSON `null` should be refused
  rather than guessed at.
- Return, per row: `ok`, `product_id`, and **which fields actually changed**, so the
  app can report "340 products, 340 prices changed, 0 descriptions touched" instead
  of a bare success count.
- Keep the existing transaction shape from `importOne`: begin, write, commit, and
  roll back the whole row on any failure. A half-updated product is worse than an
  unchanged one.
- Update the WooCommerce lookup table and clear the product's transients, exactly
  as the import path does. Writing `postmeta` alone leaves the old price showing on
  category pages, which is the bug that makes people think the tool did nothing.
- Variations: updating a variation by its own SKU must work. Do NOT rebuild the
  variation set from scratch — deleting and recreating variations changes their ids
  and breaks anything referencing them.

Add `MAX_UPDATE_BATCH` and make it 50, matching `MAX_BATCH_SIZE`, for the same
reason the others are 50.

### 2.2 Plugin: `POST /products/exists`

Cheap and small. Takes `{ skus: string[] }` (cap it, 1000 per request is sensible),
answers which exist, with `product_id`, `name` and current `price` for each. Feeds
§2.4 and the import preview.

### 2.3 Plugin: `POST /maintenance/recalculate-prices`

The README already records that this is missing: wp-admin's Maintenance tab can do
it, the app cannot reach it. Variable products imported by this tool can show wrong
min/max prices on category pages, which is the first price a shopper sees. Small
route, reuses whatever wp-admin's own button calls.

### 2.4 Web: an import mode that updates

In the import options, replace the implicit behaviour with an explicit choice:

| Mode | What it does |
|---|---|
| Skip if it already exists | today's behaviour, and the default — nothing changes for anybody |
| Create or update | new products created, existing ones updated |
| **Update only** | never creates anything |

"Update only" is the one that matters most and it is not an edge case: it is
"re-sync the prices of a catalogue I already have" without a mistyped row quietly
creating a product.

The preview must use §2.2 to say, BEFORE the run, how many rows exist and how many
do not — "1,240 rows: 1,198 already on the site and would be updated, 42 new". A
number that arrives after the run is not a preview.

### 2.5 Web: `/products` — product management for a customer account

The new screen, and it is what turns this from an import tool into something an
account holder uses daily.

- Pick one connected site, then list its products through `lookupProducts`.
  **Respect the 500-per-page ceiling honestly** — page through it and say what is
  being shown, never imply the first page is everything. That specific dishonesty
  is a bug this codebase has already fixed once in the removal flow; do not
  reintroduce it here.
- Search by name and SKU, filter by category, status and type. Search must be
  diacritic-insensitive — `foldVietnamese` already exists and is used elsewhere.
- Per product: price, sale price, stock, status, type, variation count, image count,
  categories, and a link to it in wp-admin (`adminProductUrl` exists).
- **Edit one product** — price, sale price, stock, status, categories — through
  §2.1. Show the old value beside the new one before saving.
- **Bulk edit**, which is the real value: select products (or a whole filter) and
  change price by a percentage, by a fixed amount, or to a fixed value; change stock
  or status. This runs as a **run** through the existing queue, worker, log and
  cancel machinery — not as a synchronous request. A price change across 3,000
  products has exactly the same needs as an import: progress, a log, Cancel, Stop,
  per-row results.
- Delete one or several, reusing `/products/delete` and the existing confirmation
  discipline.
- **A bulk price change gets a preview and a confirmation showing the actual
  numbers** — "340 products: 199,000 → 219,000, 450,000 → 495,000, …" for the first
  twenty — in the manner of the removal screen. A percentage applied to the wrong
  filter is how a whole catalogue gets mispriced, and a count alone cannot catch it.

Add it to the navigation, the `⌘K` palette and the `g`-shortcuts, next to Import and
Remove. It is a customer capability: an **administrator account must not have it**
in its own account, the same rule `refusePublishingAsAdmin` already enforces for
Import and Remove — an administrator manages products from *inside* a customer's
account.

### 2.6 Web: retry transient failures automatically

Retry the **batch**, not the run, 2–3 times with backoff, only for `request_timeout`
and network-level failures — never for a plugin error like `missing_name`, which will
fail identically for ever. Log every attempt, so "it worked on the third try" is
visible rather than looking like it worked first time. The idempotency key already
makes this safe.

Do **not** change `attempts: 1` on the queue job. Retrying a whole run is a different
and worse thing; the comment where that is set explains why, and it still holds.

## 3. Decisions already taken — do not re-litigate

1. **New routes only; no existing route changes.** The `X-TSD-*` headers and the
   `tsd_` stored-function prefix stay. Every site running the current plugin keeps
   working — but a site must UPDATE the plugin to get these features, and that cost
   must be stated in the README and in the site screen's version check.
2. **Partial update is not optional.** A `/products/update` that overwrites absent
   fields with empty values is not acceptable, however much simpler it is.
3. **Bulk edits are runs.** They go through the queue, the worker, the log and the
   cancel/Stop machinery. Not a loop inside a route handler.
4. **Ownership and the account model are unchanged.** Every new route goes through
   `apiRequireOwned` or `apiRequireView`, and a member touching another account's
   data answers **404, never 403**.
5. **Per-account switches are enforced server-side**, in the route handler. Decide
   whether bulk product editing needs its own switch in `account_limit` beside
   `importEnabled` and `removeEnabled` — it probably does, since it can reprice a
   catalogue — and if you add one, `absent means allowed` still applies.
6. **The design system holds.** No raw colour classes; this must stay empty:
   ```bash
   grep -rnE '\b(bg|text|border)-(slate|gray|red|blue|emerald|amber)-[0-9]{2,3}\b' app components
   ```
7. **Do not "fix" the stuck run** on the dev database. The run sitting at
   "Cancelling" was created by the owner importing and stopping; it is data, not a
   defect.

## 4. Traps already hit — every one of these cost real time

### 4.1 Environment

There is **no Node.js and no PHP on this machine.** Docker only. Working directory
for everything:
`/Volumes/Personal/Company/toshstack.dev/clients/manager-push-product-wordpress`

**Use ABSOLUTE paths in every command.** The shell's working directory is the repo
root, not the app, and it does not reliably persist between commands. A `tsc` run
from the repo root prints its **help text and exits 1** — and if you pipe that
through `grep -E "error"`, the help text contains the word "error" and you will
report a clean build that never ran. This happened.

Typecheck, lint and build:

```bash
APP=/Volumes/Personal/Company/toshstack.dev/clients/manager-push-product-wordpress
docker run --rm -v "$APP":/app -v tsd-nm:/app/node_modules -w /app node:22-alpine \
  sh -c './node_modules/.bin/next typegen &&
          ./node_modules/.bin/tsc --noEmit &&
          ./node_modules/.bin/eslint &&
          ./node_modules/.bin/next build'
```

Do **not** send `next typegen` to `/dev/null` — it hides a real failure, and it hid
one for a whole session.

Migrations:

```bash
docker run --rm --add-host=host.docker.internal:host-gateway \
  -v "$APP":/app -v tsd-nm:/app/node_modules -w /app --env-file "$APP/.env" \
  -e DB_HOST=host.docker.internal node:22-alpine \
  sh -c './node_modules/.bin/drizzle-kit generate && ./node_modules/.bin/tsx db/migrate.ts'
```

**Generating a migration is not applying it.** Generate then forget to run
`db/migrate.ts` and the app answers 500 with `column … does not exist`, which shows
up in the browser as a blank page and React error #441. This happened.

The app and worker run as `gop-web` and `gop-worker`. **Recreate them; never
`docker restart`.** A restart fails with an esbuild `TransformError` about a
platform-specific binary. This happened, and it is already documented, and it
happened anyway.

The PHP plugin is its own checkout at `/Volumes/Personal/Company/GPM_toshstack/`,
v3.1.0, with `./tests/integration.sh` (38/38), `./tests/run.php` (35/35),
`./tests/wordpress-e2e.sh` and `./build.sh`. The deployed directory name is
`gop-import`. `wp-cli` runs in its own container, so `localhost` there is not the
web server.

### 4.2 TypeScript and React

- **`tsx -e` compiles to CJS**, so a one-liner cannot use top-level await. Anything
  touching the database must be a FILE. Put throwaway scripts outside the app tree
  and copy them in, and delete them in a way that survives the command timing out —
  a leftover `.tmp-*.ts` breaks lint.
- **`react-hooks/purity` is an error.** `Date.now()` or `new Date()` in a render
  body fails the build, *even inside a `hydrated &&` guard*. Move the clock read
  into a plain helper in another module (as `formatRelative` and `isWithin` in
  `lib/format.ts` do) or into an event handler.
- **`react-hooks/set-state-in-effect` is an error.** Derive the value instead.
- **Hydration error #418**: anything from "now" must not render during SSR. Use
  `DateTime`, `RelativeTime`, `ElapsedTime`, `useHydrated` from
  `components/ui/client-time.tsx`. A stale `.next` also produces a phantom #418 —
  build clean before believing one.
- **`ioredis`, `bullmq` and `postgres` must never reach a Client Component.** Pure
  helpers a client needs live in `lib/store-links.ts`, `lib/plugin-version.ts`,
  `lib/purge-options.ts`, `lib/job-display.ts`, `lib/sources/csv-dialect.ts`.
  `Can't resolve 'net'` means a client component imported a server module.
  **`import type` is erased and is always safe** — a previous task wrongly claimed
  otherwise in a spec and had to correct it. Only VALUE imports matter.
- **`import "server-only"` throws outside an RSC.** It is in `lib/preview.ts`,
  `lib/ownership.ts`, `lib/view.ts`, `lib/audit.ts`, `lib/build-products.ts`. A
  plain Node script cannot import those; insert rows with drizzle directly, as
  `tests/isolation.ts` does for previews.
- **Deleting `.next` breaks typecheck** until `next typegen` runs again.
- **`pg` does not work under Turbopack here.** The driver is postgres.js.

### 4.3 Tests

- **better-auth rate-limits sign-in** and answers 429 late in a long suite.
  `POST /api/register` already sets the session cookie, so a freshly registered
  account is signed in — do not call sign-in as well.
- **No body on a GET** in the test client; undici rejects it outright.
- `drizzle-kit` needs a TTY for rename prompts: a migration that both drops and adds
  a column in one table cannot be generated headlessly. Split it. And **read the
  generated SQL** — it has emitted a composite primary key before the column it
  names.
- **zsh does not word-split unquoted variables.** Build docker flags as an array.

### 4.4 Data honesty rules this codebase already holds itself to

Break any of these and the change is wrong, however well it works:

- **Never truncate an error a human has to read.** A previous task found five places
  doing it. Postgres `text` has no length limit.
- **A filter is never what executes.** The filter produces a list, the operator
  reads the list, the run is built from the list. This is why a category that gains
  a product between looking and pressing cannot take it along. **A bulk price
  change must obey the same rule.**
- **Refuse, never silently trim.** A run over a ceiling is refused with a message,
  not cut to fit and reported as success.
- **Say what is not guaranteed.** The Stop confirmation admits the site may hold
  products the results do not list. A bulk update needs the same honesty about what
  happens if it is cancelled halfway.

## 5. Verification

Existing suites must stay green, and this change needs tests that could not have
passed before it:

- `pnpm typecheck && pnpm lint && pnpm build` clean, from a deleted `.next`.
- `./tests/e2e.sh` green (38/38 today), `./tests/isolation.sh` (113/113),
  `./tests/cancel.sh` (60 assertions). Keep the process-boundary property in e2e:
  the process that queues a job exits before the worker starts.
- The plugin's own suites green: `./tests/run.php` (35/35), `./tests/integration.sh`
  (38/38 against a real MySQL), and `./tests/wordpress-e2e.sh`.
- **Partial update, against a real MySQL.** Create a product with a description and
  images, send `{sku, price}` only, and assert the price changed **and the
  description, images, categories and stock did not**. This is the test the whole
  feature rests on and it must fail before §2.1 exists.
- **Clearing a field on purpose**: `{"description": ""}` empties it, while omitting
  the key leaves it. Both in one test, so they cannot drift apart.
- **A variation updated by its own SKU** keeps its `variation_id`.
- **An ambiguous SKU** (two products, same SKU) is an error for that row and does
  not touch either product.
- **The lookup table and transients** are updated: read the price back the way
  WooCommerce would, not just out of `postmeta`.
- **`/products/exists`** answers correctly for a mix of existing and absent SKUs.
- **"Update only" mode creates nothing** — give it a file where half the rows are
  new and assert the site's product count is unchanged.
- **A bulk price change is a run**: it appears on Activity, writes a log, can be
  Cancelled and Stopped, and its per-row results record the old and new price.
- **Ownership on every new route, asserted by id**: account B gets 404 listing,
  editing or bulk-editing account A's products. Extend `tests/isolation.ts` — it has
  the three-account fixture.
- **An administrator account is refused product management in its own account**
  (403) and allowed inside a customer's, exactly as Import and Remove are.
- **No secret in any log, any response, or the `job_log` table.**
- The colour-literal grep returns nothing.
- Walk it in a browser with two accounts in two profiles, in both themes.

Report honestly: separate what you verified and how from what you could not. Do not
call something done that has not been run.

## 6. Smaller items, after the above

| | What | Why |
|---|---|---|
| C1 | Reduce lanes when the site slows | 32 lanes × 50 products can flatten a small shop. `elapsed_ms` per batch is already recorded — enough to back off automatically instead of asking the operator to guess |
| C2 | Recurring schedules | Scheduling fires **once**. A daily price sync needs repetition, and BullMQ's `repeat` is already available |
| C3 | Notify when a run finishes | Email or webhook. A 14,000-product run takes hours and currently needs a screen watched |
| C4 | Check images before running | A dead image URL is only discovered mid-import. One HEAD per unique URL at preview time would catch it |

## 7. How to work

Work in steps and stop for a short report between them. Decide ordinary questions
yourself and say what you chose.

Suggested order, and the dependency is real: **§2.1 (update route) → §2.2 (exists) →
§2.4 (import modes) → §2.5 (the /products screen) → §2.6 (retry)**. The screen cannot
be built before the update route exists, and §2.3 is small enough to fold into the
plugin's release with §2.1 and §2.2.

**§2.1 and §2.5 write over products that are on sale.** Before implementing either,
write the confirmation design down and get it agreed — what is shown, how many
examples, what the operator has to type. A percentage applied to the wrong filter is
how a whole catalogue gets mispriced, and no amount of correct code prevents that.
