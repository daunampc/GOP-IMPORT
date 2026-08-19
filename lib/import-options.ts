import { z } from "zod";

/**
 * Options for one import run — a 1-to-1 map of the fields in the wizard.
 *
 * One schema serves three places: the browser form, the Route Handler that
 * validates the request, and the worker reading the run back out of Postgres.
 * A single source of truth, so the UI can never allow something the worker
 * understands differently.
 */

/**
 * What a run is allowed to DO to the site — the choice that used to be implicit.
 *
 * Until this existed there was exactly one behaviour, and it was the first row
 * below: a product whose idempotency key had been seen came back `deduplicated`
 * and nothing changed. That is right for "import this file" and useless for
 * "re-sync the prices of a catalogue I already have", which is the most frequent
 * thing a real shop needs and the one thing the tool could not do.
 *
 * `skip` stays the DEFAULT, so no existing account, preset or saved option set
 * changes behaviour by upgrading. A stored options object written before this
 * field existed parses as `skip`, which is exactly what it did before.
 */
export const WRITE_MODES = ["skip", "create_or_update", "update_only"] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

export const WRITE_MODE_LABELS: Record<WriteMode, string> = {
  skip: "Skip if it already exists",
  create_or_update: "Create or update",
  update_only: "Update only — never create anything",
};

export const WRITE_MODE_DESCRIPTIONS: Record<WriteMode, string> = {
  skip:
    "Today's behaviour, and the default. A row whose SKU is already on the site is reported as " +
    "already present and nothing about that product is touched.",
  create_or_update:
    "Rows already on the site are updated; rows that are new are created. Matched by SKU.",
  update_only:
    "Nothing is ever created. A row whose SKU is not on the site is reported as a failure rather " +
    "than published — which is the point: a mistyped SKU cannot quietly become a new product.",
};

/** True for the modes that write over products already on the site. */
export function writesOverExisting(mode: WriteMode): boolean {
  return mode !== "skip";
}

export const IMPORT_MODES = ["standard", "fast"] as const;
export const IMAGE_MODES = ["keep_remote", "upload_site", "s3"] as const;
export const ENCODINGS = ["default", "utf-8", "utf-8-bom", "windows-1258", "latin1"] as const;

export const IMPORT_MODE_LABELS: Record<(typeof IMPORT_MODES)[number], string> = {
  standard: "Complete (every WooCommerce field, same as importing on the site itself)",
  fast: "Lean (fewer fields written — for print-on-demand catalogues)",
};

export const IMAGE_MODE_LABELS: Record<(typeof IMAGE_MODES)[number], string> = {
  keep_remote: "Link to the original (FIFU)",
  upload_site: "Copy into the site's media library",
  s3: "Upload to Amazon S3",
};

export const ENCODING_LABELS: Record<(typeof ENCODINGS)[number], string> = {
  default: "Auto-detect",
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8 with BOM",
  "windows-1258": "Windows-1258 (Vietnamese)",
  latin1: "ISO-8859-1",
};

/** Default pattern for generated SKUs. See `buildSku` for the tokens. */
export const DEFAULT_SKU_PATTERN = "GOP-{seq}-{hash}";

export const importOptionsSchema = z.object({
  storeId: z.string().min(1, "Pick a site first"),

  mode: z.enum(IMPORT_MODES).default("standard"),

  /**
   * Create, update, or both. Defaults to `skip` — see WRITE_MODES.
   *
   * `.default()` rather than `.optional()` is load-bearing: every run row already
   * in Postgres has an `options` object without this key, and the worker parses
   * those back. A default means an old run keeps behaving exactly as it did;
   * `optional` would have left the worker branching on `undefined`.
   */
  writeMode: z.enum(WRITE_MODES).default("skip"),

  imageMode: z.enum(IMAGE_MODES).default("keep_remote"),
  encoding: z.enum(ENCODINGS).default("default"),

  /**
   * "Parallel batches" in the UI. This is how many requests are in flight at
   * once, NOT the batch size — the plugin takes at most 50 products per
   * request, and this number decides how many such requests fly together.
   */
  threads: z.coerce.number().int().min(1).max(32).default(10),

  /**
   * Products per request. The plugin rejects anything larger than 50 outright
   * (`MAX_BATCH_SIZE` in index.php), so 50 is a hard ceiling and not a
   * suggestion. Lower it for weak sites or products with many images.
   */
  batchSize: z.coerce.number().int().min(1).max(50).default(50),

  addRandomSuffixToSlug: z.boolean().default(true),
  flattenVariants: z.boolean().default(true),
  firstVariantAsDefault: z.boolean().default(true),

  keepProductAttributes: z.boolean().default(false),
  skipRepeatedSku: z.boolean().default(true),
  skipOnCsvError: z.boolean().default(true),

  /** Fill in a SKU for rows that arrive without one. */
  autoSku: z.boolean().default(false),
  autoSkuPattern: z.string().trim().default(DEFAULT_SKU_PATTERN),

  forceCategory: z.string().trim().default(""),
  forceTag: z.string().trim().default(""),

  /**
   * Currency to show prices in, for THIS RUN, overriding the account setting.
   *
   * DISPLAY ONLY. It is stored on the run so the results table months later shows
   * the same symbol the operator was looking at when they pressed Start —
   * otherwise changing the account setting would silently relabel the history. It
   * is not sent to the plugin, it does not reach `postmeta`, and it converts
   * nothing: the number published is the number in the file.
   *
   * Empty means "use the account's setting", which is itself empty by default and
   * means "raw numbers", exactly as before this existed.
   */
  displayCurrency: z.string().trim().default(""),
});

export type ImportOptions = z.infer<typeof importOptionsSchema>;

export const DEFAULT_IMPORT_OPTIONS: Omit<ImportOptions, "storeId"> = {
  mode: "standard",
  writeMode: "skip",
  imageMode: "keep_remote",
  encoding: "default",
  threads: 10,
  batchSize: 50,
  addRandomSuffixToSlug: true,
  flattenVariants: true,
  firstVariantAsDefault: true,
  keepProductAttributes: false,
  skipRepeatedSku: true,
  skipOnCsvError: true,
  autoSku: false,
  autoSkuPattern: DEFAULT_SKU_PATTERN,
  forceCategory: "",
  forceTag: "",
  displayCurrency: "",
};

/** Tokens the SKU pattern understands, for the hint under the field. */
export const SKU_TOKENS = [
  { token: "{seq}", meaning: "position in the file, zero-padded to four digits" },
  { token: "{hash}", meaning: "six characters derived from the row itself" },
  { token: "{slug}", meaning: "the product's slug before the random suffix" },
  { token: "{name}", meaning: "the product name, slugified" },
] as const;

/** True when a pattern gives every row the same SKU. */
export function patternIsConstant(pattern: string): boolean {
  return !/\{(seq|hash|slug|name)\}/.test(pattern);
}

/**
 * Warnings for option combinations that type-check but are almost certainly not
 * what the operator meant. Shown on the form, rather than discovered after
 * 5000 wrong products have landed on a live site.
 */
export function warningsFor(options: ImportOptions): string[] {
  const warnings: string[] = [];

  if (options.flattenVariants && options.keepProductAttributes) {
    warnings.push(
      "Flattening variants drops every variation, so “Keep product attributes” can only preserve attributes at product level.",
    );
  }

  if (options.flattenVariants && options.firstVariantAsDefault) {
    warnings.push(
      "With variants flattened there is no variation left to make default — this option will be ignored.",
    );
  }

  if (options.mode === "fast" && options.keepProductAttributes) {
    warnings.push(
      "Lean mode sends a reduced payload; attributes may be less complete than in Complete mode.",
    );
  }

  if (options.autoSku && options.autoSkuPattern === "") {
    warnings.push("Auto SKU is on but the pattern is empty — rows without a SKU will stay empty.");
  }

  if (options.autoSku && patternIsConstant(options.autoSkuPattern)) {
    warnings.push(
      `The pattern "${options.autoSkuPattern}" contains no {seq}, {hash}, {slug} or {name}, so every generated SKU would be identical.`,
    );
  }

  /*
   * This used to warn that copying images into the site with many lanes "tends to
   * choke the target site itself", and that stopped being true with plugin 3.9.0:
   * the site no longer fetches anything, it writes a file it was handed. What the
   * lanes cost now is OUR bandwidth, since this app does the downloading — a
   * different bill, sent to a different party, so the warning says so rather than
   * repeating a fear that no longer applies.
   */
  if (options.imageMode !== "keep_remote" && options.threads > 24) {
    warnings.push(
      `Every image in this run is downloaded by this app, and ${options.threads} parallel batches ` +
        "means a great many downloads at once. The target site is no longer the bottleneck — this " +
        "app's own bandwidth is. 8–16 is a better number.",
    );
  }

  if (!options.addRandomSuffixToSlug) {
    warnings.push(
      "Random slug suffix off: the plugin writes straight to the database and so does NOT run wp_unique_post_slug(). Two products with the same slug will both exist and one of them will be unreachable.",
    );
  }

  if (options.batchSize < 10 && options.threads > 8) {
    warnings.push(
      `Batches of ${options.batchSize} across ${options.threads} parallel lanes means a great many small requests. A larger batch is faster at the same load.`,
    );
  }

  if (writesOverExisting(options.writeMode) && options.forceCategory !== "") {
    warnings.push(
      `"Force category" REPLACES the categories of every product this run matches on the site, ` +
        `not only of the new ones. In "${WRITE_MODE_LABELS[options.writeMode]}" mode that rewrites ` +
        `the categories of products that already exist.`,
    );
  }

  if (writesOverExisting(options.writeMode) && options.autoSku) {
    warnings.push(
      "Generated SKUs cannot match anything on the site, so rows that arrive without a SKU will " +
        "never be updated — they are new products in “Create or update”, and failures in “Update only”.",
    );
  }

  if (options.writeMode === "update_only" && options.imageMode !== "keep_remote") {
    warnings.push(
      "An update never writes images, so staging them — copying into the site or uploading to S3 — " +
        "would do the work and then discard it. Leave image handling on “Link to the original” for " +
        "an update-only run.",
    );
  }

  if (options.forceCategory !== "" && options.forceTag !== "" && options.mode === "fast") {
    warnings.push(
      "Lean mode still writes categories and tags, but omits many WooCommerce defaults — check one product on the site before running the whole batch.",
    );
  }

  return warnings;
}
