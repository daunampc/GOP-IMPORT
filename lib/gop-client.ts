// Mirror of clients/gop-import-client.ts in the plugin repository. Keep the two
// in step whenever the plugin's API contract changes, and verify against the
// /health route (its `version` field) before deploying.
//
// The wire protocol deliberately keeps its original names. The X-TSD-* headers
// and the tsd_ stored-function prefix are the contract with every plugin build
// already installed on a site; renaming them would break all of them at once.
// Only what people see is branded GOP_IMPORT.

/*
 * Do NOT import "server-only" here.
 *
 * This module is in worker/index.ts's import graph — a plain Node process that
 * never goes through Next.js's bundler. The `server-only` package throws the
 * moment it is required outside a React Server Component, so adding it would
 * kill the worker at startup.
 *
 * The real guard is that this module requires `node:crypto`, so importing it
 * from a Client Component fails the build with a clear message.
 */

/**
 * TypeScript client for the GOP_IMPORT WordPress plugin.
 *
 * SERVER SIDE ONLY (Next.js Route Handler / Server Action). Never import this
 * into a Client Component: an apiSecret that reaches the browser defeats the
 * entire authentication layer.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SiteCredentials {
  /** For example: https://shop.com/wp-content/plugins/gop-import */
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

export interface ProductVariation {
  sku?: string;
  price?: number | string;
  regular_price?: number | string;
  sale_price?: number | string;
  instock?: boolean;
  slug?: string;
  description?: string;
  image?: string;
  images?: string[];
  attributes: Array<{ name: string; value: string }>;
  custom_meta?: Record<string, string>;
}

export interface Product {
  /** Sending the same key again returns the existing product instead of a duplicate. */
  idempotency_key?: string;
  name: string;
  type?: 'simple' | 'variable' | 'external';
  slug?: string;
  sku?: string;
  description?: string;
  short_description?: string;
  status?: 'publish' | 'draft' | 'pending' | 'private' | 'future';
  price?: number | string;
  regular_price?: number | string;
  sale_price?: number | string;
  instock?: boolean;
  stock?: number | null;
  categories?: string[];
  tags?: string[];
  images?: string[];
  shipping_class?: string;
  attributes?: Array<{
    name: string;
    values: string[];
    visible?: boolean;
    used_for_variation?: boolean;
  }>;
  default_attributes?: Array<{ name: string; value: string }>;
  variations?: ProductVariation[];
  reviews?: Array<{
    review_author: string;
    review_author_email?: string;
    review_content: string;
    rating?: number;
    time_create?: string;
  }>;
  custom_meta?: Record<string, string>;
  mode_import?: 'full_data';
}

export interface ImportResult {
  index: number;
  ok: boolean;
  product_id?: number;
  sku?: string;
  variation_ids?: number[];
  review_ids?: number[];
  deduplicated?: boolean;
  error?: { code: string; message: string };
}

export interface BatchResponse {
  total: number;
  succeeded: number;
  failed: number;
  elapsed_ms: number;
  results: ImportResult[];
}

/** A product matched by a lookup, shown before anything is deleted. */
export interface ProductSummary {
  product_id: number;
  name: string;
  sku: string;
  slug: string;
  type: string;
  status: string;
  /** What a shopper sees: the sale price while a sale runs, otherwise the regular. */
  price: string;
  /**
   * The three fields an EDIT actually writes, as opposed to the one it displays.
   *
   * The distinction is load-bearing for a bulk percentage: computed from `price`
   * while a sale was running, a discount would be applied to an already-discounted
   * number and would compound quietly on every run. So the arithmetic reads
   * `regular_price`.
   *
   * Optional because a site on a plugin build older than 3.2.0 simply will not send
   * them — and `lib/plugin-support.ts` is what stops the product screen from acting
   * on such a site at all.
   */
  regular_price?: string;
  sale_price?: string;
  stock?: string;
  manage_stock?: boolean;
  variation_count: number;
  image_count: number;
  /**
   * Whether it has an image AT ALL — plugin 3.7.0 and newer, absent before.
   *
   * Not the same question as `image_count`, which counts attachment children: a
   * product whose images are external URLs — the default import mode — has none of
   * those and still shows pictures. Optional because an older plugin does not send
   * it, and a missing value must never be read as "no image": the screens treat
   * `undefined` as unknown.
   */
  has_image?: boolean;
  categories: string[];
  created_at: string;
}

/**
 * A change to a product that ALREADY exists — `POST /products/update`.
 *
 * Separate from `Product` rather than `Partial<Product>`, and that is the whole
 * safety property in the type system: on this route a key's PRESENCE is what asks
 * for a write, so a type that carries every field as optional-and-possibly-empty
 * is exactly the type that erases a catalogue. The fields the update route refuses
 * — `images`, `type`, `attributes`, `variations` — are absent here so that sending
 * one is a compile error rather than a per-row failure discovered at run time.
 *
 * Three states, and the middle one is why `undefined` and `""` must never be
 * conflated anywhere near this type:
 *
 *   field omitted        leave it exactly as it is
 *   field is ""          clear it, on purpose
 *   field is null        the plugin REFUSES the row
 */
export interface ProductUpdate {
  /**
   * How the row is matched. One of these is required, and they are tried MOST
   * SPECIFIC FIRST.
   *
   * `product_id` is the only one that always works, which is why the product
   * screen uses it: a product with no SKU has nothing to match on, and two
   * products sharing a SKU are refused rather than guessed at — both ordinary
   * states of a real catalogue. With `product_id` given, `sku` below becomes DATA,
   * which is what makes renaming a SKU expressible at all.
   */
  product_id?: number;
  idempotency_key?: string;
  sku?: string;

  name?: string;
  slug?: string;
  description?: string;
  short_description?: string;
  status?: 'publish' | 'draft' | 'pending' | 'private' | 'future';

  price?: number | string;
  regular_price?: number | string;
  /** `""` ends a sale, and the plugin puts `_price` back to the regular price. */
  sale_price?: number | string;

  /** A number, or `""` to stop managing stock — which is not a quantity of zero. */
  stock?: number | '';
  instock?: boolean;

  categories?: string[];
  tags?: string[];
  shipping_class?: string;
  custom_meta?: Record<string, string>;
}

/** What one field moved from and to. Arrays for categories and tags. */
export interface FieldChange {
  from: string | string[];
  to: string | string[];
}

export interface UpdateResult {
  index: number;
  ok: boolean;
  product_id?: number;
  sku?: string;
  is_variation?: boolean;
  parent_id?: number | null;
  /**
   * Only the fields whose STORED value genuinely differed.
   *
   * An empty object on a successful row means the product was already exactly as
   * asked — which is what makes "340 products, 340 prices changed, 0 descriptions
   * touched" a countable statement rather than a hopeful one, and what keeps a
   * re-run of the same file from reporting 340 changes that did not happen.
   */
  changed?: Record<string, FieldChange>;
  error?: { code: string; message: string };
}

export interface UpdateResponse {
  total: number;
  succeeded: number;
  failed: number;
  elapsed_ms: number;
  results: UpdateResult[];
}

/** One SKU the site already has — `POST /products/exists`. */
export interface ExistingProduct {
  sku: string;
  product_id: number;
  name: string;
  status: string;
  type: string;
  is_variation: boolean;
  parent_id: number | null;
  /** The DISPLAYED price: the sale price while a sale runs. */
  price: string;
  regular_price: string;
  sale_price: string;
}

export interface ExistsResponse {
  found: ExistingProduct[];
  missing: string[];
}

export interface LookupResponse {
  total: number;
  products: ProductSummary[];
  /**
   * Ids only, from the `ids_only` mode. Empty in the ordinary summary mode,
   * where each product carries its own id.
   *
   * Optional because a site running a plugin older than this mode simply will
   * not send the key — see `lookupProductIds`, which pages instead.
   */
  ids?: number[];
  /** True when `total` exceeds what the plugin was willing to return. */
  truncated: boolean;
}

export interface DeleteResult {
  product_id: number;
  ok: boolean;
  /** Rows removed per table, so the UI can prove nothing was orphaned. */
  removed?: {
    /** The product row plus its variation rows. Attachments are counted separately. */
    posts: number;
    postmeta: number;
    term_relationships: number;
    lookup: number;
    comments: number;
    commentmeta: number;
    attachments: number;
    /** Image files unlinked from disk. Zero when `deleteImages` is false. */
    files: number;
    /**
     * Idempotency records.
     *
     * Not cosmetic: leaving these behind makes a later import of the same file
     * match the key of a product that no longer exists, answer `deduplicated`,
     * and create nothing — the products would silently never come back.
     */
    import_log: number;
  };
  error?: { code: string; message: string };
}

export interface DeleteResponse {
  total: number;
  succeeded: number;
  failed: number;
  elapsed_ms: number;
  results: DeleteResult[];
}

/** The plugin rejects any batch larger than this. */
export const MAX_BATCH_SIZE = 50;

/**
 * The plugin rejects any delete batch larger than this.
 *
 * A hard limit on ONE HTTP REQUEST, and it stays. It is not a limit on what one
 * run covers: a run of 3000 removals is 60 requests of 50, delivered by the
 * worker's lanes, and the operator confirmed 3000.
 */
export const MAX_DELETE_BATCH = 50;

/**
 * The plugin rejects any update batch larger than this.
 *
 * 50, the same as the other two, and for the same reason: a ceiling on ONE HTTP
 * request, not on what one run covers. A bulk price change across 3,000 products
 * is 60 requests of 50, delivered by the worker's lanes.
 */
export const MAX_UPDATE_BATCH = 50;

/** SKUs one `/products/exists` call answers for — `ProductUpdater::MAX_EXISTS_SKUS`. */
export const MAX_EXISTS_SKUS = 1000;

/** Products a single summary lookup returns — `ProductDeleter::MAX_LOOKUP_LIMIT`. */
export const MAX_LOOKUP_PAGE = 500;

/** Ids a single `ids_only` lookup returns — `ProductDeleter::MAX_LOOKUP_IDS`. */
export const MAX_LOOKUP_IDS = 100_000;

export class GopApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GopApiError';
  }
}

/**
 * The run was stopped while this request was in flight.
 *
 * A separate class from GopApiError on purpose: this is NOT a failure of the
 * site or of the products, it is the operator ending the run, and the two must
 * not be recorded the same way. Marking 50 products `batch_failed` because
 * somebody pressed Stop would be a lie in the results table.
 */
export class GopAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GopAbortError';
  }
}

/**
 * How long one request may take before it is abandoned.
 *
 * There was no deadline at all, and that is what made Cancel useless: a site
 * that accepts the connection and never answers — an overloaded shop, a hung
 * PHP-FPM pool, a firewall that blackholes the response — held a worker lane for
 * ever. The run sat at `running`, `processed` never moved, and the between-batch
 * cancel check was never reached.
 *
 * Two minutes rather than something brisk: a batch of 50 products with images
 * against a slow shared host is legitimately slow, and a deadline that fires on
 * a working site would turn one defect into a worse one.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function configuredTimeoutMs(): number {
  const raw = Number.parseInt(process.env.GOP_REQUEST_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
}

export interface GopClientOptions {
  /** Per-request deadline. Defaults to GOP_REQUEST_TIMEOUT_MS, then to 2 minutes. */
  timeoutMs?: number;
  /**
   * Aborts every request this client makes.
   *
   * The worker builds one client per run and passes that run's signal, so a Stop
   * ends the request that is in flight rather than waiting for its deadline.
   */
  signal?: AbortSignal;
}

export class GopClient {
  constructor(
    private readonly site: SiteCredentials,
    private readonly options: GopClientOptions = {},
  ) {}

  /**
   * Import many products. Splits into batches of at most MAX_BATCH_SIZE and
   * merges the results, preserving the original array indexes so the UI can
   * say exactly which row failed.
   */
  async importProducts(
    products: Product[],
    options: { onBatchDone?: (response: BatchResponse, offset: number) => void } = {},
  ): Promise<ImportResult[]> {
    const all: ImportResult[] = [];

    for (let offset = 0; offset < products.length; offset += MAX_BATCH_SIZE) {
      const chunk = products.slice(offset, offset + MAX_BATCH_SIZE);
      const response = await this.request<BatchResponse>('POST', '/products/batch', {
        products: chunk,
      });

      // The plugin returns indexes relative to the batch — translate them back
      // to the original array, otherwise a failure in the second batch gets
      // blamed on the wrong row.
      for (const result of response.results) {
        all.push({ ...result, index: result.index + offset });
      }

      options.onBatchDone?.(response, offset);
    }

    return all;
  }

  /**
   * Change products that already exist. Batched like the import, and the indexes
   * are translated back the same way so a failure in the fourth batch is blamed on
   * the right row.
   */
  async updateProducts(
    updates: ProductUpdate[],
    options: { onBatchDone?: (response: UpdateResponse, offset: number) => void } = {},
  ): Promise<UpdateResult[]> {
    const all: UpdateResult[] = [];

    for (let offset = 0; offset < updates.length; offset += MAX_UPDATE_BATCH) {
      const chunk = updates.slice(offset, offset + MAX_UPDATE_BATCH);
      const response = await this.request<UpdateResponse>('POST', '/products/update', {
        products: chunk,
      });

      for (const result of response.results) {
        all.push({ ...result, index: result.index + offset });
      }

      options.onBatchDone?.(response, offset);
    }

    return all;
  }

  /**
   * Which of these SKUs the site already has.
   *
   * Asked BEFORE a run, which is the entire point: nothing used to ask it, so a
   * file whose SKUs were already on the site imported as a SECOND set of products
   * — a different idempotency key means a different product — and the operator
   * found out afterwards. A number that arrives after the run is not a preview.
   *
   * Chunked, and the chunks are merged: the caller passes however many SKUs the
   * file has and does not have to know the plugin's per-request ceiling.
   */
  async productsExist(skus: string[]): Promise<ExistsResponse> {
    const wanted = [...new Set(skus.map((sku) => sku.trim()).filter((sku) => sku !== ''))];

    if (wanted.length === 0) {
      return { found: [], missing: [] };
    }

    const found: ExistingProduct[] = [];
    const missing: string[] = [];

    for (let offset = 0; offset < wanted.length; offset += MAX_EXISTS_SKUS) {
      const chunk = wanted.slice(offset, offset + MAX_EXISTS_SKUS);
      const response = await this.request<ExistsResponse>('POST', '/products/exists', {
        skus: chunk,
      });

      found.push(...response.found);
      missing.push(...response.missing);
    }

    return { found, missing };
  }

  /**
   * Recompute every variable product's min/max price.
   *
   * wp-admin's Maintenance tab has had this button all along and this client had
   * no way to reach it — recorded in the README as a known gap. It matters because
   * that min/max is the price a shopper sees on a category page.
   */
  async recalculatePrices(): Promise<{ recalculated: boolean; products: number }> {
    return this.request<{ recalculated: boolean; products: number }>(
      'POST',
      '/maintenance/recalculate-prices',
      {},
    );
  }

  /**
   * Write images this process has ALREADY DOWNLOADED into the site's uploads.
   *
   * Replaced `fetchImages`, which sent a list of URLs to `/images/fetch` and had the
   * site's PHP fetch each one. That endpoint no longer exists: plugin 3.9.0 removed
   * it, along with every outbound call the plugin used to make. Callers must gate on
   * `imageUploadSupport` first — see `lib/plugin-version.ts`.
   *
   * THE BODY IS FRAMED, NOT JSON, and the reason is bytes:
   *
   *     {"images":[{"source_url":"…","content_type":"image/jpeg","length":184320}]}\n
   *     <184320 raw bytes><the next image's raw bytes>…
   *
   * 3.9.0 sent the bytes base64 inside JSON, which costs a third of the wire on every
   * image-heavy run — 2.00 MB of JPEG becomes 2.67 MB, measured — plus an encode here
   * and a decode there, and it capped one image at 22 MB because 4/3 of more than that
   * does not fit in a 32 MB body. Gzip is not the answer either: a JPEG is already
   * compressed, so gzipping its base64 only removes the padding base64 just added, at
   * ~92ms of CPU per 2 MB on each side.
   *
   * Raw bytes need no new signing scheme, which is the point. `Auth::verify` signs
   * `method \n path \n timestamp \n body` and the plugin reads the body from
   * `php://input`, which is binary safe — so the HMAC still covers every image byte.
   * multipart/form-data is the option that CANNOT work: PHP parses it into `$_FILES`
   * and leaves `php://input` empty, so the signature would fail on every request.
   */
  async uploadImages(
    images: Array<{ sourceUrl: string; contentType: string; body: Buffer }>,
  ): Promise<
    Array<{ ok: boolean; url?: string; source_url?: string; error?: string; skipped?: boolean }>
  > {
    const manifest = Buffer.from(
      JSON.stringify({
        images: images.map((image) => ({
          source_url: image.sourceUrl,
          content_type: image.contentType,
          length: image.body.byteLength,
        })),
      }),
      'utf8',
    );

    const payload = Buffer.concat([
      manifest,
      Buffer.from('\n', 'utf8'),
      ...images.map((image) => image.body),
    ]);

    const response = await this.request<{
      images: Array<{
        ok: boolean;
        url?: string;
        source_url?: string;
        error?: string;
        skipped?: boolean;
      }>;
    }>('POST', '/images/upload', payload);

    return response.images;
  }

  /**
   * Which of these images the site already holds.
   *
   * The cheapest question in the client and the most valuable one on a re-run. Every
   * URL it answers with is an image this process then does NOT download from its
   * source and does NOT send to the site — for a catalogue being re-synced, most of
   * the traffic of a run.
   *
   * It works because the path an image lands at is a pure function of its source URL
   * (see `ImageWriter::pathFor`). Under the dated `YYYY/MM` layout 3.9.0 used, the
   * same image re-imported the following month landed somewhere else, so there was
   * nothing to look up.
   *
   * `null` for a URL always means "send it" — never a claim that the site lacks it
   * for certain. Being wrong that way costs bandwidth; being wrong the other way
   * would publish a URL serving nothing.
   *
   * Needs plugin 3.10.0. Gate with `imageUploadSupport` as `uploadImages` does; an
   * older build answers `unknown_route`.
   */
  async imagesPresent(
    sourceUrls: string[],
  ): Promise<Array<{ source_url: string; url: string | null }>> {
    const response = await this.request<{
      images: Array<{ source_url: string; url: string | null }>;
    }>('POST', '/images/present', { images: sourceUrls });

    return response.images;
  }

  async terms(taxonomy: 'product_cat' | 'product_tag' | 'product_shipping_class' = 'product_cat') {
    // The taxonomy travels in the route so it is covered by the signature. In a
    // query string it could be changed while the signature stayed valid.
    return this.request<{
      taxonomy: string;
      terms: Array<{ term_id: number; name: string; slug: string; parent: number; count: number }>;
    }>('GET', `/terms/${taxonomy}`);
  }

  /**
   * Find products before deleting them.
   *
   * Deliberately a separate call from the delete itself: the operator sees
   * exactly what matched, and confirms that list, rather than trusting a filter
   * to mean what they thought it meant.
   */
  async lookupProducts(filter: {
    product_ids?: number[];
    skus?: string[];
    category?: string;
    /** Only with `confirm_all`, and only ever from an explicit "delete everything". */
    all?: boolean;
    /**
     * Narrowing, applied ON TOP of the selection above — never instead of it.
     *
     * Server-side because it has to be. A product screen that filtered only the
     * page it had loaded would have a search box that silently misses everything
     * past the first 500, and "the first page is all there is" is the exact
     * dishonesty the removal flow already had to fix once.
     *
     * `%` and `_` are escaped by the plugin, so a SKU containing one is a
     * character and not a wildcard.
     */
    name?: string;
    status?: "publish" | "draft" | "pending" | "private" | "future";
    /**
     * Only products with NO image — plugin 3.7.0 and newer.
     *
     * An older plugin IGNORES an unknown filter key rather than refusing it, so
     * asking a 3.6.0 site for "products with no image" would answer with the whole
     * catalogue and nothing would say so. Callers must gate on the plugin version
     * before sending this; `lib/plugin-support.ts` is where that lives, and a delete
     * built from an unfiltered answer is the reason it is not optional.
     */
    without_images?: boolean;
    limit?: number;
    offset?: number;
    /** Ids and a total, with no per-product summary. See `lookupProductIds`. */
    ids_only?: boolean;
  }): Promise<LookupResponse> {
    return this.request<LookupResponse>('POST', '/products/lookup', filter);
  }

  /**
   * EVERY id a selection matches, not the first page of them.
   *
   * This is what lets one removal run cover the whole selection. A removal used
   * to take 500 products at most, because the only way to learn what matched
   * was the summary lookup and the plugin caps that at 500 — so "every product
   * on the site" against a 3000-product shop removed 500, reported success, and
   * left the rest.
   *
   * The summary is what makes 500 expensive, not the ids: four extra queries per
   * page for sku, price, variation counts, types and category names. Ask for
   * ids alone and tens of thousands come back in one cheap call.
   *
   * Falls back to paging with `offset` when the site runs a plugin older than
   * the `ids_only` mode, which answers without an `ids` key. Slower — one
   * summary query per 500 — but it still covers the whole selection rather than
   * silently going back to removing a page.
   */
  async lookupProductIds(filter: {
    product_ids?: number[];
    skus?: string[];
    category?: string;
    all?: boolean;
    name?: string;
    status?: "publish" | "draft" | "pending" | "private" | "future";
    without_images?: boolean;
  }): Promise<{ total: number; ids: number[]; truncated: boolean }> {
    const first = await this.lookupProducts({ ...filter, ids_only: true, limit: 1 });

    if (Array.isArray(first.ids)) {
      return { total: first.total, ids: first.ids, truncated: first.truncated };
    }

    // Older plugin. Page through the summary lookup instead.
    const ids: number[] = [];
    let offset = 0;

    for (;;) {
      const page = await this.lookupProducts({ ...filter, limit: MAX_LOOKUP_PAGE, offset });

      ids.push(...page.products.map((product) => product.product_id));

      if (page.products.length === 0 || ids.length >= page.total) {
        return { total: page.total, ids, truncated: ids.length < page.total };
      }

      offset += page.products.length;

      // A plugin that keeps answering with a full page while `total` says there
      // is more would loop for ever; stop at the same ceiling the new mode has.
      if (ids.length >= MAX_LOOKUP_IDS) {
        return { total: page.total, ids, truncated: true };
      }
    }
  }

  /**
   * Delete products and every row that hangs off them.
   *
   * Batched like the import for the same reason: the plugin caps how much work
   * one request may do, and a partial failure has to be attributable to rows.
   */
  async deleteProducts(
    productIds: number[],
    options: {
      /** Also unlink and remove the image files from uploads. */
      deleteImages?: boolean;
      onBatchDone?: (response: DeleteResponse, offset: number) => void;
    } = {},
  ): Promise<DeleteResult[]> {
    const all: DeleteResult[] = [];

    for (let offset = 0; offset < productIds.length; offset += MAX_DELETE_BATCH) {
      const chunk = productIds.slice(offset, offset + MAX_DELETE_BATCH);
      const response = await this.request<DeleteResponse>('POST', '/products/delete', {
        product_ids: chunk,
        delete_images: options.deleteImages ?? true,
      });

      all.push(...response.results);
      options.onBatchDone?.(response, offset);
    }

    return all;
  }

  /**
   * Clear WooCommerce transients. Call ONCE after a whole run — writing straight
   * to the database means WooCommerce never clears them itself.
   */
  async clearTransients(): Promise<{ cleared: boolean }> {
    return this.request<{ cleared: boolean }>('POST', '/maintenance/clear-transients', {});
  }

  /** Every field handle_health() in index.php reports. */
  async health() {
    return this.request<{
      ok: boolean;
      version: string;
      php: string;
      mysql: string;
      table_prefix: string;
      site_url: string;
      missing_functions: string[];
      /**
       * The site's image-upload ceiling and PHP memory limit — 3.9.0 and newer.
       *
       * Reported for DIAGNOSIS, not acted on: a site that refuses an upload says so
       * with `upload_too_large` and names its own limit. Optional because an older
       * build does not send them.
       */
      max_image_upload_bytes?: number;
      php_memory_limit?: string;
      /**
       * `"binary"` from 3.10.0, absent before it.
       *
       * Reported so a build that takes raw bytes can be told from one that took
       * base64 without inferring it from the version string — the version gate is
       * still what decides, this is for the Sites screen and for diagnosis.
       */
      image_framing?: string;
      /**
       * The site's activation state — a FINGERPRINT of its key, never the key.
       *
       * Optional because a plugin from before activation existed does not send it,
       * and `lib/site-license.ts` treats that absence as "not activated, update the
       * plugin" rather than as permission.
       */
      license?: {
        active?: boolean;
        code?: string;
        fingerprint?: string;
        expires_at?: string | null;
        verified_at?: string | null;
      };
    }>('GET', '/health');
  }

  /**
   * One request, signed.
   *
   * `body` is either a value to JSON-encode, or a `Buffer` to send verbatim — which
   * is what `/images/upload` needs, because its body is a manifest followed by raw
   * image bytes and JSON cannot carry those without base64 inflating them by a third.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
  ): Promise<T> {
    const binary = Buffer.isBuffer(body);

    const payload: Buffer =
      body === undefined
        ? Buffer.alloc(0)
        : binary
          ? body
          : Buffer.from(JSON.stringify(body), 'utf8');

    const timestamp = Math.floor(Date.now() / 1000).toString();

    /*
     * The signature covers the route but NOT the query string — it has to match how
     * the plugin rebuilds the string on its side.
     *
     * Hashed as BYTES rather than as a template string, because a body of image bytes
     * is not valid UTF-8: interpolating it would replace every invalid sequence with
     * U+FFFD and sign something the site never received.
     */
    const signature = createHmac('sha256', this.site.apiSecret)
      .update(Buffer.from(`${method}\n${route}\n${timestamp}\n`, 'utf8'))
      .update(payload)
      .digest('hex');

    const url = new URL(`${this.site.baseUrl.replace(/\/$/, '')}/index.php`);
    url.searchParams.set('route', route);

    /*
     * Two independent reasons to give up, combined into one signal.
     *
     * The deadline is unconditional — no request may hang for ever. The run's
     * own signal is what a Stop pulls, and it covers reading the body as well as
     * establishing the connection, because a site that sends headers and then
     * stalls mid-response wedges a lane just as thoroughly as one that never
     * answers at all.
     */
    const timeoutMs = this.options.timeoutMs ?? configuredTimeoutMs();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal =
      this.options.signal === undefined
        ? deadline
        : AbortSignal.any([deadline, this.options.signal]);

    /*
     * A view, not a copy. `fetch` types its body as `BodyInit`, which accepts a
     * `BufferSource` but not Node's `Buffer` — and `new Uint8Array(payload)` would
     * duplicate up to 24 MB of image bytes for the sake of a type. This aliases the
     * same memory.
     */
    const bodyInit =
      payload.byteLength === 0
        ? undefined
        : // `Buffer.buffer` is typed `ArrayBufferLike` because in principle it could be
          // a `SharedArrayBuffer`, which `BodyInit` does not accept. Nothing here ever
          // allocates one, so the assertion is about the type and not about the value.
          new Uint8Array(payload.buffer as ArrayBuffer, payload.byteOffset, payload.byteLength);

    let response: Response;
    let text: string;

    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': binary ? 'application/octet-stream' : 'application/json',
          'X-TSD-Key': this.site.apiKey,
          'X-TSD-Timestamp': timestamp,
          'X-TSD-Signature': signature,
        },
        body: method === 'POST' ? bodyInit : undefined,
        signal,
      });

      text = await response.text();
    } catch (error) {
      // The run being stopped is checked FIRST: when a Stop and the deadline
      // land together, what the operator did is the more useful explanation.
      if (this.options.signal?.aborted === true) {
        throw new GopAbortError(
          'The run was stopped while this request was in flight. The site may have ' +
            'committed it — this app never saw the answer.',
        );
      }

      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        /*
         * The "may have been applied" half belongs to WRITES only.
         *
         * This class is thrown by every route the client has, and a taxonomy read
         * or a health check that times out has changed nothing at all — saying
         * otherwise on those would invent a doubt that does not exist. GET is the
         * read side of this API, so the method is the discriminant.
         */
        const seconds = Math.round(timeoutMs / 1000);

        throw new GopApiError(
          408,
          'request_timeout',
          `The site accepted the connection but did not answer within ${seconds}s.` +
            (method === 'GET'
              ? ' Nothing was changed — this request only reads.'
              : ' Nothing here can tell whether the site applied it before giving up.'),
        );
      }

      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      /*
       * The site answered with something that is not JSON — almost always a PHP
       * fatal error, a WAF block page, or an HTML login redirect.
       *
       * 200 characters used to be kept, and that was the wrong 200: a PHP fatal
       * begins with a stack of HTML and puts the actual message hundreds of
       * characters in, so the operator was shown boilerplate and none of the
       * cause. 4000 is enough for the message to be inside it while still refusing
       * to store an entire HTML page per failed row.
       *
       * Whitespace is collapsed because HTML error pages are mostly indentation,
       * and 4000 characters of newlines would waste the budget that exists to
       * carry the message.
       */
      const body = text.replace(/\s+/g, " ").trim();

      throw new GopApiError(
        response.status,
        'invalid_response',
        `The site answered with something that is not JSON (HTTP ${response.status}). ` +
          `This is usually a PHP error or a security page rather than the plugin. ` +
          `What it sent: ${body.slice(0, 4000)}${body.length > 4000 ? " […truncated]" : ""}`,
      );
    }

    // 207 means the batch had individual row failures. That is NOT a request
    // error — return it so the caller can read the rows.
    if (!response.ok && response.status !== 207) {
      const error = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new GopApiError(
        response.status,
        error?.code ?? 'unknown',
        error?.message ?? `HTTP ${response.status}`,
      );
    }

    return parsed as T;
  }
}

/**
 * For verifying an inbound webhook signed with the same scheme.
 * Constant-time comparison so response timing leaks nothing.
 */
export function verifySignature(
  secret: string,
  method: string,
  route: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const expected = createHmac('sha256', secret)
    .update(`${method}\n${route}\n${timestamp}\n${body}`)
    .digest();
  const received = Buffer.from(signature, 'hex');

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}
