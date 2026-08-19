# GOP_IMPORT

A web interface for publishing products to WooCommerce in bulk, through the
[toshstack.dev](../../README.md) plugin, instead of working inside wp-admin.

| Route | What it is |
|---|---|
| `/` | Dashboard — what needs attention, runs in flight, throughput, per-site health |
| `/import` | The four-step import wizard: file → sites → options → preview and run |
| `/products` | What is on a site: search, edit one product, change many at once, delete |
| `/remove` | Removing products: select by run, SKU, category or everything, preview, then delete |
| `/process` | Activity: running, queued, history, bulk cancel, repeating runs |
| `/process/[id]` | One run in detail: per-row results, per-batch speed, resend failures, export CSV |
| `/stores` | Sites and their plugin health |
| `/stores/[id]` | One site: `/health` data, maintenance, taxonomy, both histories |
| `/settings` | Theme, import defaults, Amazon S3, run notifications by webhook and Telegram, Redis check, server environment |
| `/admin` | Accounts and their permissions, all runs, licence keys, secret reveals (administrators only) |

Every screen shares one shell: a collapsible vertical sidebar, a command bar,
and a **persistent status bar along the bottom** — wherever you are, you can see
how far a run has got. `Ctrl`/`⌘`+`K` opens the command palette, `?` lists the
shortcuts.

The interface has **full light and dark themes**; the choice is remembered in
the browser and applied before the first paint, so there is no white flash.

Screenshots of every screen in both themes: [`docs/screenshots`](docs/screenshots).

## Why closing the browser does not stop a run

The web process does **not** import. It puts a job in the queue and answers.

```
Browser → Next.js Route Handler → Redis (BullMQ)
                                    ↓
                          worker (a separate process)
                                    ↓
                      the toshstack.dev plugin on the site
                                    ↓
                                  MySQL
```

Every durable fact about a run — the payload, per-row results, per-batch timings,
**and the record that somebody asked it to stop** — lives in **Postgres**, not in
the memory of the web process and not in Redis. Redis holds the queue and the
Stop broadcast and nothing else. Close the tab, restart the web process,
redeploy, or flush Redis entirely: none of it touches the worker or the history.
Reopen `/process` and the numbers are still there.

The cancel record used to live in Redis, and that cost two bugs. Finishing a
cancelled run deleted the flag, so if the queue redelivered that job afterwards
— an ordinary event on a redeploy — nothing was left to say stop and the whole
payload ran again. And a cancel that raced a finishing run left a flag behind for
its full 24-hour TTL, ready to cancel an unrelated redelivery for no reason. Both
were the same bug: one fact, two stores, different lifetimes. It is now a column
on the run, so it cascades with the run and cannot outlive it.

Results are written after **every batch**, not gathered up until the end — if
the worker dies mid-run, what already happened is still on record.

## Accounts

Authentication is [better-auth](https://better-auth.com), self-hosted in the app
at `/api/auth/*`.

The **first account ever created becomes the administrator** and is issued a
licence automatically — somebody has to be able to mint the first key, and a key
cannot be required to create the account that mints keys.

**Everybody else registers without a key.** The account is created, can sign in,
and is completely inert: every screen redirects to `/activate` until a key is
bound, and `isActivated()` is re-derived on *every request* rather than trusted
from the session, so revoking a key bites on the next page load. Stated plainly,
because it is a real consequence rather than a detail: anyone can now create an
account. It grants nothing — an unactivated account cannot read, write or run
anything — but the `user` table can collect junk rows, and there is no rate limit
or email verification in front of it.

**A key can carry a term in days, and the term starts when the key is redeemed**,
not when it is minted. An administrator sets "30 days" and hands the key out
whenever; a key sitting unused loses nothing. The term lives in `valid_days` and
becomes `expires_at` exactly once, in the same transaction that binds the key to
an account — split across two writes, a crash between them would leave a 30-day
key that never expires. Re-entering your own expired key does not reset the clock.
Any number of days works; there is no fixed set.

The guards live in `lib/session.ts` and are the real security boundary. There is
deliberately no `proxy.ts`: Next 16 warns that proxy code may run detached from
the app, so it cannot be trusted to reach the database, and an access check that
cannot read the database is not an access check.

### An account is a customer account

Nothing is shared between accounts. Each has its own connected sites, its own
runs, its own settings, its own Amazon S3 credentials, its own presets and its
own remembered column maps. Three accounts means three separate sets of all of
it. Deleting an account takes its data with it.

Two accounts may connect the **same** WooCommerce site: each holds its own row
with its own API key and secret, and the plugin authenticates per key.

The isolation is between customers. It is **not** between a customer and the
operator — an administrator can read every account's data, edit every account's
settings, cancel any run, and open one account and work inside it, with a
persistent bar across the top of the application naming whose account is on
screen. That bar is not decoration: while it is showing, anything the
administrator starts belongs to that account, down to which S3 bucket the worker
uploads to.

### An administrator account is not a customer account

It operates the service; it does not publish products of its own. There is no
Import and no Remove in its navigation, its `⌘K` palette or its `g`-shortcuts, and
`POST /api/import` and `POST /api/purge` answer **403** for it — the navigation is
a courtesy, the route is the boundary. Its dashboard is a different screen
entirely: every account, every run, every unhealthy site, recent secret reveals.
Publishing on a customer's behalf is done from *inside* their account, where the
run belongs to them.

### What an administrator switches on and off, per account

| Switch | Off means |
|---|---|
| Import | the account cannot start an import run at all |
| Change existing products | the account cannot edit a product or run a bulk change. Its own switch, because the worst case differs from an import's: an import that goes wrong adds products somebody can delete, while a bulk edit reprices a catalogue and overwrites the only copy of what the prices were |
| Remove products | the account cannot delete products — the most dangerous capability |
| Amazon S3 | the account can neither choose the S3 image mode nor store AWS keys |
| Max connected sites / products per run / parallel batches | a ceiling; empty means none |

Two properties matter more than the list. **Absent means allowed**, so a new
customer is never blocked because nobody configured them — a limit exists only
where an administrator made a decision. And every one of them is **enforced in the
route handler**, in `lib/limits.ts`, not merely hidden in the interface. A run of
5,000 products against a 1,000 ceiling is *refused with a message*, never trimmed
to 1,000 and reported as a success.

These live in their own table, `account_limit`, deliberately separate from
`settings`: settings are the account's own configuration and the account writes
them, while these are the operator's configuration OF the account and the account
must never write them.

Two things enforce it, and they are different bugs:

| | |
|---|---|
| Every list query filters by owner | `listStores(userId)` demands the owner, so a missed call site is a type error rather than a silent leak. The administrator's cross-account view has its own named way in — `listAllStores()`, `allJobsSnapshot()`, `settingsFor(userId)` — never a flag on the ordinary path |
| Every `[id]` route checks ownership | `lib/ownership.ts`, in one place. A member touching another account's run answers **404, not 403** — a 403 would confirm the id exists, which is itself a fact about another customer |

### Reading a stored secret back

Site API secrets and AWS secret keys are encrypted at rest and never travel in
an ordinary payload. An administrator can reveal one to repair a customer's
configuration, and four things hold:

- it is an explicit action on a dedicated endpoint, one account at a time, never
  part of a payload a screen loads;
- it is a **POST**, so a secret is never in a URL, a history entry or a proxy log;
- every reveal writes a row to `secret_reveal` naming the administrator, the
  target account and the time — awaited *before* the value is returned, so a
  reveal without a record cannot happen;
- a member cannot reveal a stored secret, **their own included**. They set their
  own credentials and overwrite them; they do not read them back. That is what
  makes the record complete.

An administrator account therefore holds every customer's AWS credentials and
every customer's site credentials. Its password is the key to all of them.

## Running it

You need Node 20.9+, Postgres, Redis, and a site with the toshstack.dev plugin
installed.

```bash
cp .env.example .env
```

Generate the encryption key and put it in `STORE_ENCRYPTION_KEY`:

```bash
openssl rand -hex 32
```

Create the schema:

```bash
pnpm db:migrate
```

Then run **two** processes:

```bash
pnpm dev
```

```bash
pnpm worker
```

Without the worker, jobs sit in the queue for ever — the interface will show
"Queued" and never move.

## Environment

| Variable | Required | What it does |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` | yes | Postgres, the system of record. `DATABASE_URL` overrides all five |
| `REDIS_URL` | yes | The queue and the cancel flag |
| `STORE_ENCRYPTION_KEY` | yes | 32 bytes of hex; encrypts each site's `api_secret` and the S3 secret key before they reach the database |
| `BETTER_AUTH_URL` | yes | The app's public origin. Cookies are rejected if it does not match |
| `JWT_SECRET` | yes | Signs session tokens |
| `WORKER_CONCURRENCY` | no | Runs processed at once by the worker (default 4) |
| `GOP_REQUEST_TIMEOUT_MS` | no | Deadline on one request to a site (default 120000). There was none, and that is what made Cancel appear to do nothing against a site that stops answering |
| `GOP_BATCH_ATTEMPTS` | no | Times one batch is sent before its failure is recorded (default 3, capped at 10). Only failures where the site did not *answer* are retried — see "When a batch fails for a reason that may pass" |
| `GOP_RETRY_BACKOFF_MS` | no | Wait after a batch's first failed attempt (default 2000). Doubles each time, so the default is 2s then 4s |
| `TELEGRAM_API_BASE` | no | Where Telegram's API lives (default `https://api.telegram.org`). A seam for the test suite, which cannot call the real API; unset in production |
| `GOP_SLOW_BATCH_MS` | no | How slow one batch may be before the run keeps one fewer lane flying (default 60000, half the default deadline). Never goes below one lane, and never above the lane count the operator chose |
| `GOP_IMAGE_UPLOAD_BYTES` | no | Raw image bytes packed into one `/images/upload` request (default 16 MB, never above the plugin's 22 MB ceiling). Lower it for a site with a small PHP `memory_limit` — `GET /health` reports that limit on the Sites screen |
| `GOP_IMAGE_HOST_ALLOWLIST` | no | Comma-separated hostnames whose **private** address is tolerated, for a customer whose images genuinely sit inside their own network. Matched exactly, never as a suffix. Everything else private stays refused |
| `GOP_ALLOW_PRIVATE_IMAGE_HOSTS` | no | `1` turns the address check off **entirely**. Local development only — prefer the allowlist above, which is one host rather than all of them |
| `REDIS_URL` | yes | The queue, the Stop broadcast and the log broadcast. Losing it costs responsiveness, never data — every durable fact is in Postgres |

Amazon S3 — keys, bucket, region, public domain, key prefix — is configured on
the **Settings screen** and stored in Postgres rather than in the environment:
it belongs to whoever operates the tool and has to be changeable without shell
access. The secret access key is encrypted at rest and never sent to the
browser.

**One bucket per account.** Every account configures its own, and the worker
resolves the credentials of the account that **owns the run** — the member's
bucket even when an administrator started the run on their behalf. A run whose
owner has no complete S3 while the run asks for S3 fails with a message naming
the cause; it never falls back to another account's bucket and never quietly
behaves like `keep_remote`.

`api_secret` is encrypted with AES-256-GCM before it is written and never
reaches the browser: every API that returns a site passes it through
`toPublic()`. A site secret in plain text is equivalent to full write access to
that site's database.

## What the import options do

| Option | Effect |
|---|---|
| Complete mode | Sends `mode_import: full_data` — the plugin fills in WooCommerce's defaults (tax_status, backorders, manage_stock…) |
| Lean mode | Drops `full_data`: less meta, fewer INSERTs, and products missing those fields |
| Add a random suffix to the slug | **Leave this on.** The plugin writes straight to the database and so never runs `wp_unique_post_slug()`; two products sharing a slug both exist and one is unreachable |
| Flatten variants into one product | Drops every variation, takes the price of the **cheapest** one (the price shown on category pages), folds the variation images into the gallery |
| Make the first variant default | Writes `_default_attributes`. Turns itself off once variants are flattened |
| Keep product-level attributes | Unticked, attributes at product level are dropped. Attributes **on a variation are always kept** — without them a variable product is broken |
| Skip repeated SKUs | Drops rows repeating a SKU already seen above them in the same file. The count appears in the preview |
| Generate a SKU when the row has none | Pattern accepts `{seq}`, `{hash}`, `{slug}`, `{name}`. Nothing comes from the clock or a random number, so re-running a file produces the same SKUs and not a second set of products. Generated SKUs are marked in the preview |
| Stop if the CSV has errors | Fails at the read step instead of publishing half a file and discovering the problem afterwards |
| Force category / tag | Replaces whatever the file said. Chosen from the categories that **actually exist on the site** via `GET /terms`, or typed as new ones |
| Image handling | Keep the original links (FIFU), copy into the site's media library, or **upload to Amazon S3** and publish the bucket's URLs. In both copying modes **this app downloads the images**, never the shop's own PHP — see below. One image used by many products is downloaded once per run and stored once |
| Parallel batches | How many batches fly at once |
| Products per batch | 1–50. The plugin rejects anything larger — a hard ceiling, not a suggestion |

Categories support hierarchy with `>`: `"Clothing > T-shirts > Men"`. The
category picker reads the site's real taxonomy: diacritic-insensitive search, the
hierarchy with each entry's product count, and a clear mark on which entries
**already exist** and which **would be created** — the plugin resolves terms by
NAME, so one wrong capital letter quietly creates a second category.

## The preview is a contract, not a draft

The previous tool read the file twice: once for the preview, once for the run —
and two reads can disagree, if only in the random slug suffix.

This build assembles the data **exactly once**, stores it, and Start points at
that id. Three consequences:

- what you saw is literally what gets published;
- editing or dropping individual rows before running is possible, and the
  remaining rows keep their idempotency keys;
- pushing one batch to five sites is **five runs from one file read**.

## Changing products that are already there

Until this existed the plugin could only create. `importOne()` answered
`deduplicated` for a key it had seen and changed nothing, so the only way to alter
a price was delete-then-reimport — which loses the product id, the reviews, the URL
and everything pointing at them. For a real shop prices change weekly, so this was
the most frequent operation the tool could not do.

**The property everything else rests on: only fields PRESENT in a request are
written.** Absence, not emptiness, is the discriminant, and there are exactly three
states:

| On the wire | Meaning |
|---|---|
| the key is absent | leave the field exactly as it is |
| `"description": ""` | clear it, on purpose |
| `"description": null` | **refuse the row** — never guessed at |

`null` is refused rather than read as `""` because two client libraries serialise an
empty field two different ways, and guessing wrong there erases a product
description. A field the route does not write — `images`, `type`, `attributes`, the
variation set — is an **error** rather than a silent no-op: ignoring it would leave
the caller believing the images had been replaced.

Rows are matched most-specific-first: `product_id`, then `idempotency_key`, then
`sku`. A SKU matching **more than one** product is an error for that row, with the
ids named, and touches neither — guessing which was meant is how a price lands on
the wrong product with nobody able to trace it. `product_id` exists because it is
the only key that always works: a product with no SKU has nothing else, and two
sharing a SKU cannot be addressed by it at all.

Three things happen that are easy to leave out and make the whole difference
between "the price changed" and "the shop shows the new price":

- **`_price` is derived**, never taken as an input. It is the sale price while a sale
  runs and the regular price otherwise, recomputed from whichever of the two the
  request did not carry — so `{"sale_price": ""}` ends a sale and restores the
  displayed price from the regular price already on the product.
- **`wc_product_meta_lookup` is rewritten.** That table is what category pages, price
  sorting and price filters read, so a change that stops at `postmeta` shows the new
  price on the product page and the old one everywhere a shopper looks.
- **A variation's price change recomputes its parent's min/max by aggregate**, so a
  price that came DOWN lowers the advertised floor instead of leaving it where it was.

### Three ways in

**The import wizard** gained an explicit choice where the behaviour used to be
implicit:

| Mode | What it does |
|---|---|
| Skip if it already exists | today's behaviour, and the default — nothing changes for any existing account, preset or stored options object |
| Create or update | rows already on the site are updated, new ones created, matched by SKU |
| Update only | nothing is ever created. A row whose SKU is not on the site is recorded as a **failure** with the reason, which is the point: a mistyped SKU cannot quietly become a new product |

In the two write modes the preview asks the site, **before** the run, how many rows
already exist — "1,240 rows: 1,198 already on the site and would be updated, 42
new" — and Start stays disabled until it has. A number that arrives after the run is
not a preview.

A file-driven update writes only the fields a row carries a real value for, and it
can never CLEAR one. That is deliberate and narrow in the safe direction: the CSV
readers fill every field they know about, using `""` for columns the file does not
even have, so writing absent fields would mean every missing column silently emptied
a column of the catalogue. Clearing a field is a deliberate act on one product,
which is what the product screen is for. `slug` and `images` are never sent either —
the slug is regenerated with a random suffix on every read, so sending it would
rewrite every product's URL.

**One product** is edited in a drawer on `/products`, with every old value beside its
new one, and saves synchronously. A run exists to give progress, a log and Cancel to
work that takes minutes; one product takes one request.

**Many products** is a run — the same queue, worker, log, Cancel, Stop and per-row
results as an import, because a price change across 3,000 products has exactly the
same needs as an import of 3,000. A loop inside a route handler would mean no
progress, no log, no way to stop it and a browser tab that has to stay open.

### The confirmation, and why it shows numbers rather than a count

A filter is never what executes — the same property the removal screen is built on.
The filter produces a list of ids, those are resolved into per-product values, the
operator reads **those values**, and the run is built from them. So a product
somebody else reprices between looking and pressing is not swept along at a number
nobody reviewed, and one that joins the filter in that window is not taken at all.
It also means resending a bulk edit is safe: the staged row carries an absolute
value, so sending it twice writes the same number twice, where a stored "−10%"
resent would take another 10% off.

| Level | When | What the operator does |
|---|---|---|
| 1 | one product | old beside new in a drawer. No typing |
| 2 | 20 or fewer, absolute values | the preview shows **every** row with its real numbers. No typing |
| 3 | more than 20, **or** any relative change (%, ±amount) | preview, then type `UPDATE` — re-checked in the route handler |

The second clause of level 3 has no size threshold on purpose. A percentage applied
to the wrong filter is the named failure mode, and twelve products at −90% is still a
mispriced catalogue, just a smaller one. Reading one row proves nothing about the
others when every row ends at a different number.

The preview shows twenty rows in full — `199,000 → 219,000` per row — then counts the
rest. Twenty rather than the removal screen's 500 because the two are different acts
of reading: auditing 500 product NAMES is plausible, auditing 500 arithmetic RESULTS
is not, and twenty is enough to catch the two mistakes that happen (a wrong filter
shows up as unfamiliar names in the first rows; a wrong operation shows up in the
first row). Beside them are three figures computed over the **whole** selection
rather than the twenty on screen:

- the lowest and highest resulting price, which is what catches `-90` typed for `-9`;
- rows that would land at or below zero, which **refuses the run** rather than
  clamping them — a price that would go to zero means the number is wrong, not that
  the product should be given away;
- rows that would end with a sale price at or above the regular price, which warns
  only, because WooCommerce permits it and refusing something legal would be this
  screen overreaching.

And it says what it cannot promise. A removal cancelled halfway leaves the un-deleted
products alone; a reprice cancelled halfway leaves the already-repriced products
**repriced**, and Cancel does not put them back. What each row was is recorded in the
run's results, which is the only record of it — the site has overwritten it, and
nothing else in this app kept it.

### The screen refuses to open on an old plugin, rather than degrading

`/products` needs plugin **3.2.0** and will not act on a site running less. Not
belt-and-braces: an older plugin does not REJECT the unknown search filter, it never
looks at it — so a search for "Áo khoác" against a 3.1.0 site returns the whole
catalogue and would be presented as the search result. Every product would look like
a match, and "this product is not on the site" and "your plugin is old" would be
indistinguishable. The update route fails loudly by comparison, but the whole screen
is gated so a site gets one answer rather than three depending on which button was
pressed.

The list itself never presents a page as everything. The plugin caps one summary
lookup at 500 products and that cap stays, so every count says both numbers — how
many are loaded and how many the filter matched on the site — and "select everything
that matched" resolves every id on the site in one cheap call rather than pretending
the visible rows are the selection.

## Removing products

Removal is the inverse of import and has its own run kind, its own screen, and
the same queue, worker and cancel mechanism.

Selection is by import run, by SKU list, by category (including everything
beneath it), or the entire catalogue. **A filter is never what executes**: the
filter produces a list, the list is what you read, and the run is built from
that list — so a category that gains a product between looking and pressing
cannot take that product with it. The two selections that can empty a catalogue
in one press require typing a confirmation, checked again on the server.

**One run covers the whole selection.** The lookup answers twice from the same
filter at the same instant: a page of full detail to read — the plugin caps that
at 500, because the per-product summary is what makes a page expensive — and
*every* matching id, from the plugin's `ids_only` mode. The run is built from the
ids, and the confirm step quotes that number: "Remove 3,412 products", not
"remove the 500 below". Rows past the readable page are staged by id, so their
results carry the id without a name — nothing looked their names up.

The batching that remains is the plugin's `MAX_DELETE_BATCH` of 50 per HTTP
request. That is a hard limit on one request, not on what one run covers.

### Products with no picture

A shop accumulates them: a feed that dropped its image column, a supplier export with
broken links, a run where the images 404'd. They are findable now — on the product
screen and on the removal screen — as a **narrowing**, never a selection: it sits
beside "a category" or "every product on the site", because on its own it would be a
filter that means everything, which is the one shape both screens refuse.

**What counts as having an image** is the part worth getting right, and there are
three ways this plugin attaches one:

| | |
|---|---|
| `_thumbnail_id` | an attachment, from "copy into the media library" |
| `_product_image_gallery` | a comma list of attachment ids |
| `fifu_image_url` | an external URL — **what the DEFAULT image mode writes** |

Miss the third and every product imported with "keep the original links" reads as
having no picture, which turns this feature into a way to delete a catalogue. A
**variation's** image counts as the parent having one too: a variable product whose
variants carry pictures shows pictures, whatever the parent row says, and in a delete
command the conservative reading is the only defensible one.

The plugin answers `has_image` on every row it returns, **from the same definition the
filter used** — not from `image_count`, which counts attachment children and reads
zero for a product whose pictures are external. The list an operator reads therefore
agrees with why it matched, and the removal screen marks those rows.

**A version gate stands in front of it, and it is load-bearing.** A plugin older than
3.7.0 does not refuse `without_images` — it *ignores* it. Sent to such a site, the
answer is the whole catalogue, presented under a heading saying these products have no
picture, one press away from deletion. So the app refuses to send it below 3.7.0 and
names the version. That gate is separate from the product screen's own 3.2.0
requirement: a site on 3.2.0 can still be searched, edited and cleared, and refusing
all of that because one newer filter is unavailable would be the gate overreaching.

Deletion is a deep clean. For each product: the product row, its variations, its
image attachments, all post meta, category and tag links with the counts
corrected, its WooCommerce lookup row, its reviews and their meta, its
idempotency record, and — unless you turn it off — the image files in uploads.
The run reports what left **each table**, so "nothing was orphaned" is evidence
rather than a claim.

Removing the idempotency record is what lets the same file be imported again
afterwards. Without it the site would answer "already imported" and create
nothing.

## Source data

**CSV, and only CSV.** Four formats: Shopify/Shopbase (grouped by `Handle`),
WooCommerce (`Type=variation` rows pointing at `Parent`), Etsy (the Download
Listings export) and **Custom** — any CSV at all, with the columns named by hand.

The format is worked out **at step one, in the browser**, from the file's header
line alone: 64KB read locally, no upload and no parse. The detected answer is
preselected and labelled, and every other format is one click away on the same
screen.

This used to be broken in a way worth recording, because it had two halves and
fixing either alone would have left the feature dead:

- the wizard's `dialect` state had no value meaning "work it out", so it defaulted
  to `shopify` and **always sent it** — `detectDialect()` never ran, and a valid
  WooCommerce export was read by the Shopify parser and reported two dozen errors
  about a missing `Handle` column;
- the server's `readDialect` accepted only `shopify` and `woocommerce`, so a
  request naming `etsy` or `custom` was silently auto-detected instead — which
  would have made the custom mapper impossible to use while looking, from outside,
  like the mapping was being ignored.

**Custom** is a real format rather than a renaming trick. Its fields are product
concepts — `name`, `price`, `parent_sku`, `attribute_1_name` — not another
marketplace's columns, because describing a strange file used to mean choosing
Shopify and then explaining your file in terms of `Handle` and `Option1 Name`.
Only `name` is required: a two-column file of names and prices imports cleanly.
Columns are guessed by folded, accent-insensitive comparison, so `Tên sản phẩm`
reaches `name` and `Ma hang` reaches `sku`; every guess is a dropdown you can
change, and a field with no confident match is left blank rather than filled with
the nearest thing.

An unrecognised file **says so** and drops into Custom with the columns matched as
far as their names allowed — it is never quietly read as Shopify. A mapping is
remembered against the signature of the column set.

## The design system

Colour, type, spacing, radii, shadow and motion are declared in one place,
[`app/globals.css`](app/globals.css), using Tailwind v4's `@theme`. The shared
components live in [`components/ui`](components/ui), one per file, and screens
import only from `@/components/ui`.

The `@theme` block opens with `--color-*: initial`, which **erases Tailwind's
default palette**. After that, a class naming one of Tailwind's own colour
scales generates no CSS at all. This is a compile-time fence, not a convention;
check it at any time with:

```bash
grep -rnE '\b(bg|text|border)-(slate|gray|red|blue|emerald|amber)-[0-9]{2,3}\b' app components
```

The only place a colour literal is allowed is `themeColor` in
[`app/layout.tsx`](app/layout.tsx): it becomes a `<meta name="theme-color">` tag
that the browser reads before any CSS exists.

Every colour pair meets WCAG AA, and the measured ratios are recorded beside the
tokens in `globals.css`.

## Stopping a run: two buttons, two different promises

**Cancel** is graceful. It does not kill a job mid-flight: the worker reads the
run's cancel record between batches and stops at a boundary, so no product is cut
off while it is being written to the database. A run that has not started yet is
dropped from the queue immediately.

**Stop** is the harder action, and it exists because Cancel cannot serve one case.
A site that accepts the connection and never answers — an overloaded shop, a hung
PHP-FPM pool, a firewall that blackholes the response — leaves a worker lane with
no batch boundary to reach. Cancel then waits out the request deadline. Stop
aborts the request in flight and ends the run immediately.

|  | Cancel | Stop |
|---|---|---|
| When it stops | at the next batch boundary | now |
| A request already sent | runs to its deadline | abandoned |
| No product cut off mid-write | guaranteed | **not** guaranteed |
| Measured against a site that never answers | one request deadline | ~20 ms |

**What Stop cannot promise, and says so on screen:** the plugin may already have
committed the batch it was sent, so the site can hold products the results table
does not list. Those batches record nothing rather than 50 invented failures —
neither success nor failure is knowable once the answer is abandoned. The run
carries that sentence in its own error field, so the person reading the history
next week sees it too. Re-importing the same file is safe: the idempotency keys
mean anything that did land comes back as already present rather than as a second
product.

Every request now has a **deadline** as well (`GOP_REQUEST_TIMEOUT_MS`, two
minutes by default), independent of either button. No batch can block for ever,
which is what made Cancel appear to do nothing at all.

A batch that hits the deadline is recorded as `request_timeout`, not the generic
`batch_failed`. The distinction is the point: `batch_failed` reads as "the site
rejected these", and what happened is "the site was given these and never said" —
the one case where they may be on the site regardless.

### When a batch fails for a reason that may pass

A `request_timeout` used to end there: the rows were recorded as failures and
somebody had to notice and press "Resend the failures" for a hiccup that was over
before they read about it. A batch now gets **three attempts**, 2s and then 4s
apart (`GOP_BATCH_ATTEMPTS`, `GOP_RETRY_BACKOFF_MS`).

**The batch, never the run.** BullMQ's own `attempts` stays at 1. A transient
failure belongs to one batch of at most 50, and re-delivering the whole job would
re-send everything that had already succeeded and restart the run's accounting to
do it. It is one loop in `runBatches`, so all four kinds of run — an import, both
write modes, a bulk edit and a removal — get it from the same place.

**Only when the site did not ANSWER.** `request_timeout`, a 429, a 502, a 503, a
504, and connection-level network errors. Never a plugin refusal: a row with no
name, a SKU matching two products, a slug already taken, a SKU that is not on the
site all fail identically however many times they are sent, so retrying them makes
a doomed run take three times as long to reach the same answer — every batch of it
sitting out a backoff nobody benefits from. The classification reads the error
**code**, never the wording of a message, and a code it does not name is not
retried. `ENOTFOUND` and `ECONNREFUSED` are deliberately excluded for the same
reason: those are what a mistyped site URL looks like, and it will still be
mistyped on the third attempt.

**A Stop is never retried**, which is the line that matters most. It is the
operator ending the run, not the site misbehaving.

**Every attempt is in the log**, so a run that only worked on the third try does
not read as though it worked on the first: the failure, the line saying it will be
sent again and when, the second "Sending batch…" written before it goes out, and
the answer naming the attempt it came back on. Anything past the first attempt is
logged at **warn**, so filtering the log to what was not routine shows a flaky
site immediately.

**A lane inside a backoff is not at a batch boundary.** Cancel is read between
batches, so a naive backoff would leave a press of Cancel unread while a chain of
delays ran out — and Stop is worse off still, because there is no request in
flight for it to abort. So the durable cancel record is re-read twice a second
while a batch waits, and a press of either ends the lane there. The batch's rows
are still written as `request_timeout` in that case: its deadline had already
expired, so "sent, never answered" was known before anybody pressed anything.
That is the opposite of a batch abandoned **in flight**, which records nothing,
because nothing about it is knowable.

**What retrying costs — and what it used to cost.** In the "copy into the site's
media library" mode the old `/images/fetch` did not deduplicate: it appended `-1`,
`-2`, so a retried batch left a second copy of every image file in uploads. Plugin
3.9.0 derives the filename from the source URL, so a resent batch now writes
nothing it has already written and the duplicates are gone. The products themselves
were, and are, protected by their idempotency keys. What a retry costs today is the
bandwidth of sending the bytes again — the images the run already resolved are
cached for its lifetime, so they are not downloaded again.

### When the site is coping badly, the run eases off

"Parallel batches" is chosen before the run, and the only place a shop's behaviour
is visible is *during* it: 32 lanes of 50 products is nothing to one site and takes
another one down. So a batch that comes back slower than `GOP_SLOW_BATCH_MS`
(default 60s — half the request deadline) costs the run **one lane**, and the run
carries on with fewer.

- **One lane at a time, floor of one.** A site having a moment loses one lane; a
  site that is genuinely overwhelmed converges to one and still finishes.
- **It only ever goes down within a run**, and never above the number the operator
  chose. Adding lanes back when a site recovers means oscillating around the
  threshold and leaning on a shop that has just stopped struggling; the cost of not
  recovering is that the run finishes later, which is the direction to be wrong in.
- **A lane leaves at a batch boundary**, checked before it claims a batch — for the
  same reason Cancel is checked there. A lane that claimed a batch and then left
  would take that batch with it, and `processed` would come up short for a reason
  that had nothing to do with the site.
- **Nothing is trimmed.** Every product still goes; fewer go at once. This is not
  the "refuse rather than silently trim" rule being bent, and it is not silent
  either: each reduction writes a log line naming the milliseconds that caused it
  and the lane count from there on.
- Measured on the **wall clock**, not the plugin's own `elapsed_ms`: a site that
  spends 200ms of PHP after 40 seconds of queueing is still a site that cannot take
  what it is being given. A batch that hits its deadline is over the threshold by
  definition, so the timeout case needs no rule of its own.

### Do the image links work? — asked before the run, not during it

A dead image URL used to surface halfway through an import: the products were
already being written, the log filled with staging failures, and the operator read
about a broken link at the point where nothing was left to decide. The preview step
now has a button that asks every **distinct** link for its headers.

Distinct is what makes it affordable — a file of 3,000 products sharing one size
chart is one link, not 3,000 — and it is the same property that makes an S3 object
key a hash of the URL.

Four outcomes, and three of them look identical to a check that only asks whether
the request succeeded:

| Verdict | What it means |
|---|---|
| Reachable | 2xx with an image content type, or a redirect (not followed from here) |
| **Not an image** | **2xx that answers with a page.** A CDN's own "not found" page, a hotlink block or a login wall served with status 200 — the case a naive check calls fine, and the import would publish it as a product image |
| Dead link | 404 or 410 |
| Refused | any other 4xx or 5xx |
| No answer | DNS, connection or the 5s deadline |
| Private address | refused by this app **before any request was made** |

**It does not block Start**, deliberately. A broken link is not a reason to refuse
to publish a catalogue; the products still import with the links the file gave.
Compare "What is already on the site", which the two write modes *do* gate on —
that number changes what the run writes to products that already exist, and this
one changes nothing about what the run does. A confirmation that blocks on
something harmless is one people learn to click past.

**Both numbers, always.** The check covers 200 distinct links, and when a file
carries more the panel says "40 of 4,120 were checked — the rest were not asked
about, so this says nothing about them either way". A page presented as everything
is the one thing no count on any screen here does.

**The links come out of a customer's CSV, so the route refuses to fetch some of
them.** A URL naming `localhost`, a private range, a link-local address (where
cloud instance metadata lives), `.local` or `.internal`, or any scheme other than
http and https, is reported as `blocked` without a request being made. Redirects
are not followed, so a public URL cannot bounce the server onto a private one, and
what comes back is a status and a content type — never a response body.

**The check and the download share one rule, in `lib/outbound-url.ts`.** They do not
apply it identically, and the difference is deliberate: this check wants a fast
textual verdict to show in a table, while the **download** keeps the body and does
follow redirects, so it also resolves the hostname and inspects **every address**
behind it, at **every hop**. So the gap this paragraph used to end on — a public
hostname that *resolves* to a private address — is now closed on the path where it
mattered. It is still open here, where the response is one status and one content
type. What remains open on both is DNS rebinding: the name can resolve differently
between the check and the socket, which needs the connection pinned to the address
checked, and Node's `fetch` does not expose that.

### Being told a run has finished

A run of 14,000 products takes hours, and the only way to know it had ended was to
keep the screen open. An account can now give a **webhook URL** on the Settings
screen and be told instead.

A webhook rather than an email, and the reason is worth stating: email would need a
mail server and credentials this installation does not have, while a webhook needs
neither and is **signed with the scheme already in the codebase** — over
`POST\n<path>\n<timestamp>\n<body>`, so whoever writes the receiving end verifies
it with the same `verifySignature()` the plugin uses. Empty URL means off; there is
no separate switch to disagree with the field beside it.

**Every terminal outcome, not only success.** A run refused by the account's
permissions, or one whose staged payload had expired, ends without sending a single
batch — and that is exactly the run somebody watching a screen needs told about.
Silence cannot tell "finished, all good" apart from "the worker died". An account
that finds this noisy turns on **only when something went wrong** (a failed or
stopped run, or one that finished with failed rows), which is a switch rather than
the default.

**It never throws and never delays a run.** The record is in Postgres before the
POST is attempted; the notification is a courtesy on top. A receiver that answers
500, or one that is simply gone, is logged against the run and nothing else happens
— the run still completes with its products.

**One attempt**, deliberately unlike a batch. A batch is work that must land; this
is an announcement whose content is already durable and always readable on the run's
own page, and retrying would hold a worker lane for a receiver's benefit. The
attempt and its outcome are both logged, so "we were never told" is answerable.

**The body carries a `text` field** holding the whole thing in one sentence, beside
the structured run fields — so a Slack-shaped receiver works with nothing in
between.

**What is never logged:** the webhook URL. A Slack or Discord hook URL *is* the
credential, so the log records the status and whether the delivery was signed, and
neither the URL nor the secret. The secret cannot be read back by anyone,
administrator included — unlike the S3 key, there is no reveal action for it, and
one fewer readable secret is one fewer thing an administrator's password unlocks.

**The URL gets the same treatment a CSV's image link does**, because it is equally a
string somebody typed: a private, local or link-local address is refused when it is
saved and again before any send, and redirects are not followed. That means a
receiver on a private network is refused even in a self-hosted install; the way
through is a public hostname or a tunnel.

#### Telegram, for the same notifications

A webhook reaches a system. Telegram reaches the person who is not watching the
screen at 02:00, on the phone they already have — so it is a second **channel**, not
a second notification system: same event, same "only when something went wrong"
switch, one answer to *when am I told* and two answers to *where*.

Two fields on the Settings screen, and both are needed: a **bot token** from
@BotFather and a **chat id**. The token is a credential — anyone holding it can post
as that bot — so it is encrypted at rest and write-only, exactly like the S3 key and
the webhook secret. The chat id **is** shown back, deliberately: it is not a secret,
finding it is the fiddly half of setting this up, and hiding it would make a working
configuration impossible to check.

**A "Send a test" button**, because the alternative is starting a real import to find
out whether the chat id is right — and a Telegram setup that is silently wrong looks
exactly like a quiet night. Telegram's own refusal is passed through, since a 401 and
"chat not found" are the two mistakes people make and they need different fixes.

**Half a configuration is refused rather than stored.** A token with no chat id would
fail at delivery time, inside a run, and fail *silently* — a notification that never
arrives is indistinguishable from a run that has not finished. Clearing the chat id
clears the token with it: a credential kept for a destination that no longer exists is
a credential kept for no reason.

The message is **plain text, not Markdown**. Telegram would render `*` and `_` as
formatting, and a product catalogue is full of both — a name with an underscore would
either break the message or silently italicise half of it.

**What is never logged:** the token or the chat id. One is a credential, the other
identifies a person's account; the log records that Telegram was told and the HTTP
status, and nothing else. The API base is overridable through `TELEGRAM_API_BASE` so
the test suite can assert against a fixture rather than against somebody's live bot.

### Cancelling a multi-site batch

One press of Import against five sites creates **five runs**, and the per-run
Cancel acts on one of them. So "I cancelled the import and it kept importing" was
a fair description. Cancel is *not* silently widened to the whole group — "cancel
this run" and "cancel 5 runs" are different promises. Instead the confirmation
names the group and its real size, and offers it as a separate button.

## When products fail

**The error is shown in full.** It used to be cut with a CSS ellipsis, which
removed the only part worth reading — `Column 'post_title' cannot be null` became
`Column 'post_titl…`. Four places shortened an error and all four are fixed:

| Where | Was | Now |
|---|---|---|
| The results table | CSS `truncate`, one line | full message, wrapped, breaks long SQL |
| A site answering with HTML instead of JSON | first 200 characters | 4,000, whitespace collapsed so the message is inside them |
| CSV read errors | 5 rows, then an ellipsis | 20 rows, with the remainder counted |
| Duplicate SKUs dropped | 5 names | 30 names, with the remainder counted |
| The log | 10 failed rows per batch | **every** failed row — a batch is at most 50 |

**The failed products are kept as a list**, on record for as long as the run is,
with two ways out — and they are not interchangeable:

- **Resend these N products** when the SITE was at fault: a timeout, a lock, a
  dropped connection. A new run is created with exactly those rows, keeping the
  original idempotency keys, so a row that did in fact reach the site comes back as
  already present rather than becoming a second product.
- **Download the failed rows** when the DATA was at fault: a missing name, a price
  with a thousands separator in it, a category that does not exist. Resending
  identical rows would fail identically, so the CSV — failures only, each with its
  full error — is fixed in a spreadsheet and imported as a new file.

The error code on each row is what tells those two apart, which is the reason the
message is no longer truncated.

## The log: what a run is doing, as it does it

Every run writes a log, and the run's own screen shows it **live** at the bottom.
It is the answer to "it looks stuck — what is it actually doing?", and it is
written so that question has an answer even when nothing has finished yet: the
line for a batch is written **before** the request goes out, not after the answer
comes back. Against a site that has stopped answering, that line is the only thing
on the screen for the next two minutes, and it is the one that matters.

Realtime works the same way Stop does, and for the same reason. The worker writes
the line to Postgres — the record — then publishes the run id on a Redis channel
as a knock on the door. The stream hears the knock, reads from its cursor, and
pushes what is new. Publishing the *lines* through Redis would be simpler and
worse: a dropped message would be a line gone for ever with nothing to notice.
As a knock, a dropped message costs a second, because the cursor has not moved and
a fallback tick picks it up. It also means the log still works with **no Redis at
all** — slower, never silent.

What gets recorded: the worker picking the run up and the options it will use, the
owner's S3 bucket **by name only**, image staging per batch, each batch sent and
each batch answered with both timings, every failed row with its code, a request
that hit its deadline, which lane stopped where on a Cancel, **which batches a Stop
abandoned in flight**, every attempt at a batch that was sent again and why, lanes
stood down with the milliseconds that caused it, transient clearing, whether the
run-finished webhook was delivered — and a closing summary. Roughly 5–10
lines per batch.

Never a payload, a header, an API key or an HMAC signature — headers carry the
site's key and the payload is the customer's catalogue. The e2e and isolation
suites grep the log table itself for the fixture secrets, so that is enforced by a
failing test rather than by care.

The log cascades with the run, so it counts toward the row total quoted before a
delete.

## Scheduled runs

The last step of the import wizard can start a run later instead of now. It shows
under **Scheduled** on the Activity screen until it fires, where it can be moved
or cancelled.

The staged payload is what makes this safe. `job_item` is written in the same
transaction as the run row, so a run scheduled for tomorrow carries its own
products and does not depend on the preview, which expires after an hour.

`JobStatus` deliberately keeps its original five members; "scheduled" is derived
from a `scheduled_for` timestamp. A new enum member would have meant every screen
that switches on status either handling it or failing at runtime.

### Runs that repeat

"Every night at 02:00" is its own thing, and the shape of it was the decision worth
making carefully.

**Each occurrence is an ordinary run.** A firing stages a NEW run with its own copy
of the payload, its own results, its own log and its own Cancel; it appears under
**Scheduled** like any other scheduled run. Repeating one job on a BullMQ `repeat`
was the obvious alternative and it cannot work here: `runJob` refuses to touch a run
whose status is terminal, which is exactly the guard that stops a redelivered job
re-publishing a catalogue. A repeating single row would have to be exempted from
that guard, and the guard is worth more than the convenience. So `JobStatus` still
has its original five members and nothing that switches on status learned a thing.

**The series holds the payload, once.** Each occurrence gets a copy, but the copy the
next one is built from lives on the series — so retention taking last night's staged
rows away cannot quietly make tonight's run empty, which it would if occurrence N+1
copied its products from occurrence N.

**It re-sends the same data every time.** This is the sentence the screen leads with,
because it is the thing somebody would otherwise discover weeks later: a series does
**not** re-read the file. "The preview is a contract" applies here too — the products
were staged when the series was made. That makes it right for keeping a shop matching
a price list somebody edits in wp-admin, and wrong for a feed that changes daily.

**Missed occurrences are skipped, not caught up.** A server that was off for a week
comes back and fires *one* run, not seven at once against somebody's shop. The next
time is counted from the previous DUE time rather than from now, so 02:00 stays 02:00
instead of drifting later every night by however long the last run waited.

**The next occurrence is staged when the previous one is PICKED UP**, not when it
finishes — so the series survives its own runs going wrong: a cancelled occurrence,
one refused by the account's permissions, or a worker killed mid-run all leave
tomorrow's already staged. That advance is a single conditional UPDATE keyed on this
run being the pending one, so a redelivered job cannot double the series.

**Pausing drops the occurrence it had waiting** rather than cancelling it — nothing
had happened, and a `cancelled` row would be a record of a non-event — and keeps the
payload, so starting it again needs no file read. **Deleting the series** drops the
pending occurrence too, because a series somebody deleted must not publish tonight;
the runs that already happened keep their results and their place in the history.

The account's import permission is checked when the series is made **and** at every
firing, for the same reason a single scheduled run checks twice: a series can fire
for months, and a permission withdrawn in between must not publish.

The account's import permission is checked **twice**: when the run is scheduled,
so the operator gets an answer while they can still act on it, and again when it
fires. Those two moments can be days apart, and an account whose permission is
revoked in between must not publish — it fails with the cause named.

## The currency shown beside prices

Chosen per account on the Settings screen, overridable per run in the import
options. It is a **display** setting and changes nothing on any site.

It cannot. The plugin writes `_price`, `_regular_price` and `_sale_price` as plain
numbers into `postmeta`, and WooCommerce renders them using the site's own
`woocommerce_currency` option — and stock WooCommerce has no per-product currency
at all. One shop has one currency. The identical payload shows as `₫199,000` on a
site set to VND and `$199,000.00` on one set to USD; this app formats the same
number as `₫199,000` or `US$199,000.00`, because it pins `en-GB` rather than
following the reader's locale — a locale-dependent symbol position would differ
between the server render and the browser's and break hydration.

Nothing here converts anything: the number published is the number in the file. A
symbol in front of it is a label, not arithmetic. It defaults to empty — raw
numbers, exactly as before — so no existing account gains a symbol it did not ask
for. The run stores the currency it was reviewed under, so changing the account
setting later does not relabel the history.

## Tests

```bash
./tests/e2e.sh
```

Stands the whole stack up in Docker — Postgres, MySQL 8, the real PHP plugin,
Redis, the worker — and runs an import, the three write modes, a bulk edit and a
removal end to end. The stages are
separated by deliberate **process boundaries**: the process that queues the job
exits before the worker starts, and a third process reads the results. State
held in the web process's memory would be invisible by stage three. It also
seeds 620 products and removes every one of them in a single run, and proves a
run uses its owner's S3 and never a neighbour's.

```bash
./tests/isolation.sh
```

A different boundary and so a different stack: Postgres, Redis and the real
Next.js server, with three accounts in three cookie jars. Asserts customer
isolation **by id** — the list filter and the ownership check are two different
bugs, and only the second is reachable by pasting a URL — then administrator
power, the reveal audit trail, scheduled runs over HTTP, and that no fixture
secret reaches the server log.

```bash
./tests/images-staging.sh
```

The downloader, the internal-address guard, the packing arithmetic and the
run-level image cache. Deliberately the **light** suite: it needs the fake image
host and nothing else — no Postgres, no Redis, no `next build` — because none of
what it proves lives on the request path. A suite that takes fifteen minutes is a
suite that stops being run.

The guard stays **on** while it runs. Turning it off would make the assertion that
matters most — a public URL redirecting to `169.254.169.254` is refused at the
**second hop** — pass whether the guard exists or not, so the fixture host is
allowlisted by name instead and every literal address in those tests stays blocked.
That is the hole the plugin had: `CURLOPT_FOLLOWLOCATION` with a check on the first
URL only.

It also counts hits at the fake host rather than trusting the app's own bookkeeping,
because "one image is downloaded once per run" is a claim about what left the
process. And it caught a real bug: `http://[::ffff:127.0.0.1]/` was not refused,
because the URL parser rewrites that host as `::ffff:7f00:1` and the check was
matching the dotted text a person writes rather than the value the program holds.

```bash
./tests/cancel.sh
```

Cancelling, Stopping, deleting and scheduling, against a site that **never
answers** — `tests/blackhole.py`, which accepts the connection, reads the request
and never replies. That shape of failure is the whole point: a site that refuses
or closes fails the batch fast, the run completes, and Cancel appears to work
perfectly. This is the only harness in which the original defect reproduces.

The worker runs as its own container so it can be **SIGKILLed without releasing
its BullMQ lock**, which is what makes the redelivery stage a test of stalled-job
redelivery rather than of clean shutdown.

`./tests/isolation.sh` gained a third container for the same reason: an image host
that serves a live link, a 404, a 418 and a **200 with an HTML page**, because the
preview's image check has to tell those apart and three of them look identical to
code that only asks whether the request succeeded.

The same suite carries the batch-retry phases, against a second fixture site —
`tests/flaky.py`, which fails and then **stops** failing. The blackhole cannot
serve those: "it went through on the second attempt" is not observable against a
site that never works at all. Each phase points a store at one of its scenarios by
URL path, and the strongest assertion in all four is the **request count read from
the fixture itself** — how many times something was sent is a fact only the
receiving end holds, where counting log lines would only count this app's own
account of what it did.

Static checks:

```bash
pnpm typecheck && pnpm lint && pnpm build
```

## Status

**Verified:**

- `pnpm typecheck`, `pnpm lint` and `pnpm build` clean (Next.js 16.3.1) — the build
  matters here beyond the typecheck, because this change moved a version gate ACROSS the
  `server-only` boundary so the import wizard could reach it, and only the build proves a
  Client Component is not pulling in server code.
- `./tests/images-staging.sh` green: **41/41** — the internal-address guard across
  IPv4, IPv6, IPv4-mapped IPv6 and per-redirect-hop; an ordinary redirect still
  followed; 200-with-a-page refused; an oversized `Content-Length` refused on the
  header; the packing arithmetic; a shared image downloaded **once per run** (counted
  at the fake host, not in the app); a failed image **not** cached so a later batch
  retries; and each failure attributed to the download or to the site.
- `GPM_toshstack/tests/integration.php` green: **95/95** (86 before this change) — the
  nine new ones cover `ImageWriter`: the file lands under `uploads/YYYY/MM` with a
  slug and a hash, a second write of the same source URL is **skipped and leaves no
  `-1` duplicate**, a truncated file from an earlier crash is overwritten, the magic
  bytes beat the declared content type, one bad entry does not take the request down,
  `id_multisite` cannot inject a path, the client cannot choose the filename, and a
  written image gets **real** `_wp_attachment_metadata` with dimensions.
- 45 plugin PHP files lint clean under PHP 8.1.
- `./tests/e2e.sh` green: **95/95** end-to-end — the TypeScript client's HMAC
  signature is accepted by the PHP plugin, a run survives a process boundary, a
  variable product creates all its variations, a failed row is reported alone
  without taking the batch down, row indexes keep the original order, a removal
  run takes the products back off the site, **620 seeded products are removed by
  a single run leaving the site empty**, and a run whose owner has no S3 fails
  rather than borrowing another account's bucket. **A 1 MB image survives base64 and
  the HMAC over the whole body** — the wire neither of the two image suites can reach,
  since one stubs the plugin and the other calls `ImageWriter` directly — sending it
  again reports `skipped` with the same URL and no `-1` duplicate, an HTML page
  labelled `image/jpeg` is refused **by the site**, `/images/fetch` answers 404
  `unknown_route`, and a whole `upload_site` run publishes both products with the dead
  link keeping its original URL. No secret appears in the
  worker's captured output. A failed row's message reaches the results table
  **whole** — asserted for absence of truncation, not merely for presence — and each
  failure maps back to its staged product by original row index, which is what makes
  a resend possible at all.
- `./tests/isolation.sh` green: **165/165** against a real running server (127 before
  this change) with three
  accounts in three cookie jars — a member cannot read, cancel, **stop**, retry,
  export, edit, delete, **reschedule**, check, maintain or start anything of
  another account's **by id** (404 every time, never 403), a bulk delete naming a
  stranger's run deletes nothing and will not even quote its row count, settings
  and S3 are genuinely different rows, forging the view cookie gets a member
  nothing, an administrator can read and write every account and cancel or stop any
  run, and both kinds of reveal write an audit row naming the administrator, the
  target account and the time; an administrator account is refused `POST
  /api/import` and `POST /api/purge` in its own account but allowed inside a
  customer's; every per-account switch and ceiling is enforced by the API — a
  **scheduled** import by the same switch as an immediate one — with a member
  unable to raise their own; and a scheduled run appears in the `scheduled` bucket
  and not also in `queued`, can be moved, and can be cancelled while it waits. No
  fixture secret appears in the server log.
- `./tests/isolation.sh` also covers, at 113 assertions: registering with **no
  licence key** creates an inert account that is refused every account-scoped route
  with `license_required`; a key minted with `validDays: 1` carries the term but no
  deadline until it is redeemed, and the deadline that appears is one day from
  **activation** rather than from minting; moving `expires_at` into the past locks
  the account out on its very next request, and re-entering the same expired key
  does not revive it; and four CSV formats are detected from real multipart uploads,
  with an unrecognised file refused **with its column list** rather than guessed at,
  the same file importing once mapped as `custom`, a two-column file importing on
  `name` alone, and a hand-named format overriding detection.
- `./tests/cancel.sh` green: **159 assertions**, 0 failures (73 before this change),
  against a site that accepts
  the connection and **never answers** — the only harness in which the original
  defect reproduces. Verified red before the fix and green after:
  - a wedged run reached `cancelled` **3s** after the press, where before it sat at
    `running` with `processed` at 0 for the full 45s the test was willing to wait;
  - **Stop ended the same run 21ms after the press**, which is the difference
    between the two buttons made measurable;
  - the batches never sent produced **no result rows** — no invented failures — and
    the ones sent-and-unanswered are recorded as `request_timeout`, not
    `batch_failed`;
  - a cancelled run stayed cancelled when its job id was re-added to the queue, and
    `processed` did not grow;
  - the worker was **SIGKILLed** mid-cancel so its BullMQ lock was never released;
    after a restart the redelivered run settled as cancelled and published nothing
    further;
  - a scheduled run was left alone until its time, fired on its own, and a second
    one whose account had its import permission revoked while it waited **failed
    with the cause named** instead of publishing;
  - delete took `job_item`, `job_result`, `job_batch` and `job_log` with it, verified
    table by table, and refused a run that was still running;
  - the **log** records the run being picked up with its options, a line for every
    batch written *before* it is sent, the batches a Stop abandoned in flight with
    the warning that the site may hold them, and a closing summary — in `id` order,
    with no secret, no header name and no signature anywhere in the table.
- **Batch-level retry, verified red then green in the same harness.** Four new phases
  in `./tests/cancel.sh` against `tests/flaky.py`, and the count of requests the
  FIXTURE received is the assertion in each — how many times something was sent is a
  fact only the receiving end holds. Before the change: 10 failures across them. After:
  0.
  - a batch that timed out once **went through on the second attempt** — the site was
    sent it exactly twice, the run completed with all ten products landed and **no row
    left carrying `request_timeout`**, where before the change the identical run
    reached `completed` with all ten recorded as timeout failures for a hiccup that was
    already over;
  - a site that never answers was sent the batch **three times and no more**, and the
    rows still say `request_timeout` rather than a code invented for giving up;
  - a batch the site **refused** (`missing_name`) was sent **exactly once**, with
    nothing in the log claiming it would try again;
  - **Stop pressed during a backoff ended the run 1,015ms into a 25s wait** — the lane
    is not at a batch boundary there and has no request in flight to abort, so the
    durable cancel record re-read twice a second is the only thing that can end it. The
    batch's rows are recorded as `request_timeout`, because "sent, never answered
    within the deadline" was already known before the press;
  - every attempt is in the log: the failure, the line saying when it will be sent
    again, a second "Sending batch…" written *before* it goes out, and the answer
    naming the attempt it came back on.
  - **Proved to have teeth by MUTATION, not by reading.** Removing the retry turns 10
    assertions red. Making the classifier call every failure transient — the plausible
    wrong implementation — sends the *refused* batch 3 times and turns the "a decision
    is not a hiccup" phase red while the transient phases stay green. Both were run.
  - Unchanged by it: Cancel on a wedged run still reached `cancelled` in 2s and Stop
    still ended one in ~1s on this machine, both measured before and after.
- **Standing lanes down, verified against two sites that differ only in speed.** Two
  more phases in `./tests/cancel.sh`, same worker, same 1500ms threshold, same run
  shape — 400 products in 8 batches across 4 lanes:
  - against a site answering in **3s per batch**: lanes stood down one at a time, the
    log named the milliseconds that caused each reduction, and **all 400 products
    still landed** with the site receiving all 8 batches. It never went below one
    lane;
  - against a site answering **at once**: **no lane stood down at all**, under that
    same threshold;
  - **teeth proved by mutation:** before the change, 3 assertions red. Making the
    reduction ignore the measurement — the plausible wrong implementation — turns the
    fast-site phase red while the slow-site phase stays green. Both were run.
- **The image-link check, asserted against a host that serves one of everything.** 13
  new assertions in `./tests/isolation.sh` against `tests/images.py` — 10 of them red
  before the route existed:
  - six links across three products are reported as **five distinct** links, and the
    working one is **not** in the list, because the list is what needs attention;
  - a 404 is a dead link, a 418 is a refusal, and a **200 answering with `text/html`
    is not called fine** — the case a naive check misses, and a real one: a CDN's own
    "not found" page served with a 200;
  - a link naming `127.0.0.1` is reported as **blocked without being fetched** — the
    links come out of a customer's CSV, so the route would otherwise make the server
    fetch arbitrary strings from an untrusted file;
  - a capped check answers **"2 checked of 5 distinct"** with `truncated: true`,
    rather than presenting what it read as everything;
  - and another account asking about that preview gets **404, never 403**, with a
    refusal that names nothing from the file.
- **The run-finished webhook, asserted from the RECEIVER's side.** 18 assertions in
  `./tests/cancel.sh` against `tests/receiver.py`, which records what actually
  arrived, plus 8 over HTTP in `./tests/isolation.sh`:
  - a finished run produced **exactly one delivery**, and the receiver **verified the
    HMAC signature over the bytes it received** using this app's own
    `verifySignature()` — while a wrong secret did not verify, so that check is not
    vacuous;
  - the body carried the run's **final** status and counts (read after the run was
    finished, not before), plus the one-line `text` a Slack-shaped receiver needs;
  - with **"only when something went wrong" on**: a clean run produced **no delivery
    at all**, and a run with failures still produced one;
  - a receiver answering **HTTP 500** left the run completed with all its products,
    and the run's log says the delivery was refused and not sent again;
  - **neither the URL nor the secret reaches the log** — a Slack hook URL is itself a
    credential — and the suite's secret grep now covers the webhook secret too;
  - over HTTP: the stored secret is never returned, re-saving with an empty secret
    keeps it, a URL naming a **link-local address is refused at save time** with the
    host named, a non-http scheme is refused, and another account's webhook is its
    own.
- **Products with no picture, and the gate in front of the filter.** 5 assertions in the
  plugin's own integration suite (86/86, was 81) and 6 over HTTP:
  - a product with nothing attached is found; one with a thumbnail is not;
  - **an external image URL counts as an image** — what the default import mode writes —
    and removing that clause from the SQL turns that one assertion red, which is the
    mutation that was run;
  - an image on a **variation** counts as the parent having one;
  - every row the filter returns also reports `has_image: false`, from the same
    definition, so the list agrees with why it matched;
  - the narrowing still cannot mean "everything" on its own — without a selection it is
    refused with `empty_filter`;
  - over HTTP: a site whose plugin build is **unknown** and a site on a **known 3.6.0**
    are both refused with 3.7.0 named and the reason given, the refusal carries a reason
    and no product data, and the same selection *without* the filter is not refused —
    which is what shows the two version gates are separate.
- **Telegram, asserted from the receiving end.** 11 assertions in `./tests/cancel.sh`
  with `TELEGRAM_API_BASE` pointed at `tests/receiver.py`, so what is checked is the
  request Telegram would have received rather than this app's belief that it sent one:
  - one message per finished run, to the **bot** the account configured (its token in
    the URL, which is how Telegram authenticates) and to the **chat id** it configured;
  - the text carries the site and the counts — `30 ok`, `0 failed`;
  - the stored token reads back as "configured" and never as itself, while the chat id
    **does** read back, because it is not a secret and hiding it would make a working
    setup uncheckable;
  - neither the token nor the chat id reaches the log;
  - **the "only when something went wrong" switch silences Telegram too**, not only the
    webhook — one answer to when you are told, two answers to where.
  - **Teeth proved by mutation, both run:** making Telegram ignore that switch turns the
    silence assertion red; sending to a hard-coded chat id turns the chat assertion red.
    The implementation was written before these tests, so mutation is the evidence
    rather than a red-first cycle.
  - **Teeth proved by mutation, and stated plainly: for this one the implementation
    was written before the tests.** So instead of a red-first cycle there are two
    mutations, both run. Ignoring the "only when something went wrong" switch turns
    3 assertions red; reading the run's state *before* finishing it — the stale-payload
    mistake — turns the "final numbers" and "one-line summary" assertions red.
- **Repeating runs, and a bug the tests caught rather than review.** 23 assertions in
  `./tests/cancel.sh` and 11 over HTTP in `./tests/isolation.sh`, red first:
  - the interval maths is asserted directly — a series set for 02:00 stays at 02:00
    after a late firing, and a week of missed occurrences advances to **one** future
    time rather than a backlog;
  - a series fired, ran as an ordinary completed run, and left a NEW occurrence
    waiting one interval after the first — `queued`, derived as **scheduled**, with
    its own copy of all 20 products;
  - taking the previous occurrence's staged payload away left tonight's untouched,
    which is the property that makes the series independent of its own history;
  - advancing on a run that is **not** the pending occurrence changed nothing, which
    is what stops a redelivery doubling the series;
  - deleting the series dropped the occurrence it had waiting — a deleted series must
    not publish tonight — while the run that had already **run** kept its results and
    lost only its pointer;
  - **the bug:** pausing set the series' pointer to null but left the staged run in
    the queue, because `forgetJob` deliberately refuses a queued run — so a "paused"
    series would still have published. The delete assertion caught it; the pause
    assertion had been too weak to. Fixed with a narrow `dropStagedRun` that accepts
    only an occurrence of a series that has never started, and the pause assertion now
    checks the run is really gone.
  - over HTTP: another account gets **404, never 403** reading, pausing or deleting a
    series by id, none of which touched it; it is in the owner's list and nobody
    else's.
- The plugin's own suites are green: 35/35 logic, **86/86** integration against a real
  MySQL (38 before this change), and `./tests/wordpress-e2e.sh` on a real WordPress
  7.0.4 + WooCommerce 11.0.1 — installed through the admin screen's own button, a variable product
  imported over the API and read back correctly by WooCommerce.
- The plugin is renamed to GOP_IMPORT throughout and its Vietnamese is translated
  to English. Its wp-admin screen is now a dashboard, walked in a browser on that
  real WordPress.
- Walked in a browser on a real stack in **both themes**, with an administrator
  and a member: a member sees only their own and has no way to reveal a secret;
  an administrator can enter an account, and the bar naming it is unmistakable
  and follows every screen. Browser console clean — no application errors, no
  hydration warnings.
- The **live log** walked in a browser against the never-answering site: with the
  results table and the batch table both still empty, the log already read
  "Sending batch 1 of 12 — 50 item(s), rows 1–50" for all four lanes, which is the
  case the panel exists for. Pressing Stop appended four `ABANDONED in flight` lines
  and the closing summary **without a reload**, over SSE. Console clean on a fresh
  tab: no errors, no hydration warnings.
- The **CSV fix** walked in a browser with the exact WooCommerce file that
  previously reported "Thiếu cột Handle" 24 times: it now shows
  "WooCommerce · detected" at step one. A file with unknown Vietnamese column names
  selected Custom by itself, opened the mapper, and guessed **all five columns**
  correctly with no clicks.
- Cancel, Stop, delete, scheduling and the currency walked in a browser against a
  site that never answers, on a build made after deleting `.next` (a stale `.next`
  produces a phantom hydration error that looks like an app bug). Stop took a
  wedged run to **Stopped** instantly with its warning on the run; the delete
  confirmation quoted **410 rows** and the cascade emptied them; the scheduled run
  showed a **"in 6 hours"** countdown; and a second account got **404** on all six
  per-run routes by id, with the bulk delete reporting `count: 0` and refusing to
  quote a row count. No hydration errors in the console on any screen.
- The request deadline protects **every** call, not only batches: a taxonomy read
  against the never-answering site returned `408` after exactly 120s where it
  would previously have hung the route indefinitely.
- Auth verified against the real database: anonymous requests get 401, members
  get 403 on admin routes, a claimed key cannot be reused.
- No raw colour classes remain in `app/` or `components/` (see The design
  system).

- **Partial update, asserted the only way it is worth asserting.** A `{sku, price}`
  update is checked field by field for having left the name, slug, description, short
  description, status, stock, stock status, thumbnail, gallery, attachment count and
  category count **exactly** as they were — not merely that the price moved. Verified
  to have teeth by MUTATION rather than by reading: disabling the price write turns 12
  integration tests red, and writing absent fields as empty values (the simpler
  implementation this route refuses) turns the partial-update test red. Also covered:
  `""` clearing a field while an omitted key leaves it, `null` refused, an unsupported
  field refused with the reason, `_price` returning to the regular price when a sale
  is ended, the lookup table and the transients carrying the change, a stock of 0
  becoming `outofstock` while an explicit `instock` still wins, a category swap
  correcting the count on **both** sides, a variation keeping its `variation_id`, a
  lowered variation lowering the parent's advertised floor, an ambiguous SKU touching
  neither product, and a taken SKU or slug refused rather than made ambiguous or
  silently suffixed.
- **"Update only" creates nothing**, asked of the SITE rather than of this app's
  counters: a file where half the rows are new leaves the site's product count exactly
  where it was, and the new rows are recorded as failures with `not_on_site`.
- **A bulk edit is a run**, proven on the never-answering site as well as the working
  one: it wedges where an import wedges, its log line for a batch is written before the
  request goes out, Stop ends it without waiting out the deadline, the abandoned batch
  invents no result rows, and the run carries the warning that the site may hold
  changes it never recorded. Resending it writes the same numbers rather than
  compounding the percentage.
- **`createdProductIds()` excludes rows that only updated a product.** Found by a
  failing test rather than by review, and it was a destructive defect: `/remove` offers
  "Everything one import run created", and in a create-or-update run those ids include
  products the run merely repriced — so that selection would have deleted a customer's
  existing catalogue under a label promising it would not.
- Walked in a browser against a real WordPress schema on plugin 3.2.0, in **both
  themes**, as a member and as an administrator: an administrator in their own account
  gets `/products` read-only and no navigation entry, and a site on 3.1.0 is refused
  with the reason. A −10% change across two products demanded the typed `UPDATE`
  despite there being only two, showed `1,000 → 900` and `900,000 → 810,000` before
  running, and −100% was **refused** per row with "it would end up at 0" rather than
  clamped. Read back out of MySQL afterwards: `_regular_price` 810,000, a later
  single-product sale price of 750,000, `_price` **derived** as 750,000, and
  `wc_product_meta_lookup` holding 750,000 with `onsale = 1`. The run's own screen said
  "Changed 2 · products changed in place, keeping their ids" — not "Created". No React
  errors and no hydration warnings.

**Needs one action from you:**

- **Each site's plugin must be updated to 3.9.0** before the "copy into the site's
  media library" image mode will work on it again. 3.9.0 is the build that took image
  downloading off the shop's own server — the app now downloads each image and sends
  the bytes — and it **removed** the old `/images/fetch` route outright. The wizard
  greys the mode out, the route answers 409 and the worker refuses the run, each
  naming the site and its version, rather than publishing every product with its
  supplier's links and reporting success.

  **Deploy this app first, then update the sites.** In that order nothing breaks
  silently: runs in that one mode are refused with a sentence saying why until each
  site is updated. The other order — a site updated while this app is still the
  previous build — makes every image 404 with nothing explaining it.
- **Each site's plugin must be updated to 3.2.0** before `/products` or the
  create-or-update import modes will work on it. The screen and the routes refuse an
  older build with the version named, rather than degrading — see the section above for
  why degrading would be worse than refusing.
- **The plugin directory on each site must be renamed to `gop-import`.** Every API
  URL is built from that name, so a site whose directory is still `toshstack.dev`
  answers 404 until it is moved — or until "Plugin base URL override" on the site's
  screen is pointed at the old path. The plugin's own dashboard detects the mismatch
  and says so.

**Not verified:**

- **DNS rebinding is still open**, on the download path and the preview check alike.
  The name is resolved, every address checked, and then `fetch` resolves it again —
  and closing that needs the connection pinned to the address that was checked, which
  Node's `fetch` does not expose. The plugin's `ImageFetcher::reject()` had the same
  hole, so nothing regressed; it is simply not fixed.
- **The 22 MB per-image ceiling in `upload_site` is a reduction from 32 MB**, and has
  not been observed to matter. Base64 in a 32 MB body cannot carry more, and raising
  `MAX_BODY_BYTES` would move the memory ceiling of every route rather than this one.
- **The `s3` mode's behaviour changed and no test covers the change.** It now shares
  the downloader, so it refuses an internal address and refuses a source answering 200
  with an HTML page — the latter previously went into the bucket and was published as
  a product photo. The refusals are tested at the downloader; that they reach the S3
  path is by construction, not by assertion.
- **The no-image filter has not been run against a real WooCommerce site**, only against
  the plugin's MySQL fixtures — where the three ways an image can be attached were each
  inserted by hand. What a live shop does that the fixtures do not is a gallery
  referencing an attachment that was deleted: the meta is non-empty, so that product
  reads as having an image and is left alone. Conservative in the safe direction for a
  delete, and worth knowing before somebody asks why a broken-image product was not
  found.
- **Neither new filter control has been walked in a browser** — the switch on the
  removal screen or the one on the product screen.
- **No message has been sent to the real Telegram.** Everything is asserted against a
  fixture at `TELEGRAM_API_BASE`; api.telegram.org has never been called from here, so
  the shape of the request is proven and Telegram's acceptance of it is not. The
  "Send a test" button exists precisely so the first real message is one somebody asks
  for rather than one a run depends on.
- **The Telegram settings panel has not been walked in a browser.**
- **The three new screens have not been walked in a browser**: the notification
  settings panel, the image-link check on the preview step, and the repeating-runs
  panel on Activity (with the wizard's Repeat option). Every route behind them is
  asserted over HTTP, all three typecheck, lint and build, and each is modelled on a
  panel already on the screen it joins — but nothing is claimed here about how they
  render, in either theme, or that the console is clean on those screens: nobody has
  looked.
- **A repeating series has no screen of its own.** It is created in the wizard and
  managed on Activity, and the run detail page does not yet say "this run is one
  occurrence of a series" even though the run carries the pointer. Nothing is
  misleading; there is simply less on screen than the data supports.
- **Email notifications do not exist.** The webhook is the whole of it. Email would
  need a mail dependency and SMTP credentials this installation does not have; the
  settings shape and the worker hook would carry it unchanged if that changes.
- **Only the timeout path of the retry is exercised.** `request_timeout` is covered by
  a fixture that reproduces it exactly. The other codes the classifier calls
  transient — HTTP 429, 502, 503, 504 and the connection-level network errors
  (`ECONNRESET`, `EAI_AGAIN`, undici's `UND_ERR_*`…) — are written to the shape those
  failures have, not to an observed one. The classification is one small pure function
  with the codes listed in it, so it is readable rather than proven.
- **The cost of a retry in the "copy into the site's media library" image mode is read
  from the plugin's source, not run.** `ImageFetcher::store()` appends `-1`, `-2`
  instead of reusing a file, so a retried batch can leave duplicate image files in
  uploads; that mode has no automated test at all (see below), so this follows from
  reading the PHP rather than from watching it happen.
- **`images` cannot be updated**, and that is now a decision rather than an omission.
  Replacing a gallery means creating and deleting attachments, which changes image ids
  and removes files from disk — it needs its own design and its own confirmation, not a
  line in a partial update. The route refuses the field with that reason rather than
  ignoring it. **Deferred deliberately to its own piece of work**, and when it is built,
  deleting the old files will be a **switch that defaults to KEEPING them** — the same
  shape as the removal screen's "Image files", because an image can still be in use by
  another product and a wrong selection that only unlinked is recoverable while one
  that deleted is not.
- **An update does not rebuild a product's attribute set**, so a variable product whose
  variations gain a new size still needs the `attributes` written by an import.
- The bulk-edit screen has no undo. Every row's previous value is on the run's page and
  in its CSV export (`gia_cu`), which is enough to reverse a mistake by hand, but there
  is no button that builds the reverse run.
- `/products` was walked with a catalogue of 23 products. The paging path — "load the
  next page", and "select everything that matched" past the 500-per-page ceiling — is
  exercised by its own code path and by the removal flow's 620-product test, but not by
  a browser against a catalogue larger than one page.
- The "copy into the site's media library" image mode is wired to the plugin's
  `/images/fetch` route but has no automated test — it needs outside network
  access to fetch real images.
- The S3 upload path still has no automated test: that would need real AWS
  credentials or an S3 stub, and `S3Uploader` has no custom-endpoint option to
  point at one. What **is** tested is which account's credentials the worker
  resolves, which is the part this change altered — a run whose owner has no S3
  fails rather than using a neighbour's, and each account resolves its own
  bucket. An actual upload landing in two different buckets has not been run.
- "Recalculate min/max price" from wp-admin's Maintenance tab has no HTTP route
  in `index.php`, so this app cannot reach it — the site screen says so rather
  than hiding it.
- Contrast ratios were computed from the token values rather than sampled from
  rendered pixels.
- Not tried with a real screen reader.
- A removal larger than the plugin's `MAX_LOOKUP_IDS` ceiling of 100,000 reports
  `truncated` and covers what it returned; that path has not been exercised
  against a catalogue that large.
- **Cancelling a job in the instant the worker picks it up** (`job.remove()` racing
  the worker's lock) is now caught rather than escaping as a 500, but the race
  itself was not reproduced — provoking it reliably needs a hook inside BullMQ's
  lock acquisition. What is proven is that the durable cancel record is written
  before the removal is attempted, so losing the race stops the run at its next
  boundary regardless.
- **Whether a Stop leaves products on the site** is asserted only as far as this
  app can see: that the abandoned batch records nothing and the run says the site
  may hold more than the results list. Confirming a plugin-side commit after an
  aborted connection would need the PHP plugin under a debugger mid-transaction.
- Stop reaches the worker over a Redis pub/sub broadcast. The **fallback** when
  that broadcast is lost — the lane still stopping at its next boundary or its
  deadline — follows from the durable record and is what the graceful path already
  tests, but a dropped publish was not simulated directly.
- **Etsy has not been run against a real export.** Its column set follows Etsy's
  documented "Download Listings" shape, but those names vary with the account's
  language and with whether any listing has variations, so this is code written to
  documentation rather than to an observed file. Detection and parsing are covered
  by a fixture built from that documentation, which proves the wiring and not the
  shape. The custom mapper is the way through when it is wrong.
- Etsy's variation model is **lossy by nature**: Etsy gives a variation type and a
  list of values but no per-combination price or SKU, so there is nothing to build a
  priced variant from. Those become product attributes and the listing stays a
  simple product at the listing price. Inventing a price per variant would be making
  data up.
- The header line at step one is read as **UTF-8** before any encoding is chosen, so
  a windows-1258 file shows mangled accents in the column list until the real parse
  runs. Detection itself is unaffected — it only compares ASCII column names.
- **No rate limit or email verification on registration.** A direct consequence of
  dropping the key requirement, stated in Accounts above; unactivated accounts can
  do nothing, but the table can collect rows.
- The log is capped at **10 failed-row lines per batch**, with a line saying how
  many were omitted. Every failure is still in the results table; only the repetition
  is trimmed.
