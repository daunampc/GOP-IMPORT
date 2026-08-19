import { z } from "zod";

import { MAX_DELETE_BATCH } from "./gop-client";

/**
 * Options for a removal run.
 *
 * Deliberately a separate shape from `ImportOptions` rather than a pile of
 * optional fields on it: almost nothing an import cares about — encoding, slug
 * suffixes, image handling — means anything when the work is deletion, and a
 * shared type would have said otherwise on every screen that reads it.
 */

export const PURGE_SELECTIONS = ["run", "skus", "category", "all"] as const;
export type PurgeSelectionKind = (typeof PURGE_SELECTIONS)[number] | "ids";

/**
 * `ids` is NOT in `PURGE_SELECTIONS`, and that omission is deliberate.
 *
 * That array is what the removal screen renders as its list of radio buttons, and
 * "a list of product ids" is not something anybody types there. It is how the
 * product-management screen deletes what the operator ticked — a selection that
 * already exists on screen rather than a filter to describe. Adding it to the array
 * would put a useless option in front of every user of `/remove`.
 *
 * It is a full member of the SELECTION union all the same: it goes through the same
 * queue, worker, log, Cancel and per-table removal counts as every other removal,
 * because those are what make a delete accountable and there is no version of this
 * that deserves them less.
 */
export const PURGE_SELECTION_LABELS: Record<PurgeSelectionKind, string> = {
  run: "Everything one import run created",
  skus: "A list of SKUs",
  category: "A category, including its sub-categories",
  all: "Every product on the site",
  ids: "The products selected on screen",
};

/**
 * The two selections that can wipe a catalogue in one press. They require the
 * operator to type a confirmation phrase.
 */
export const DESTRUCTIVE_SELECTIONS: ReadonlySet<PurgeSelectionKind> = new Set(["category", "all"]);

export const purgeSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), runId: z.string().min(1, "Pick an import run") }),
  z.object({
    kind: z.literal("ids"),
    productIds: z.array(z.coerce.number().int().positive()).min(1, "Nothing selected"),
  }),
  z.object({
    kind: z.literal("skus"),
    skus: z.array(z.string().trim().min(1)).min(1, "Enter at least one SKU"),
  }),
  z.object({ kind: z.literal("category"), category: z.string().trim().min(1, "Enter a category") }),
  z.object({ kind: z.literal("all"), confirm: z.literal(true) }),
]);

export type PurgeSelection = z.infer<typeof purgeSelectionSchema>;

export const purgeOptionsSchema = z.object({
  storeId: z.string().min(1, "Pick a site first"),
  selection: purgeSelectionSchema,

  /** Also unlink the image files from the site's uploads folder. */
  deleteImages: z.boolean().default(true),

  threads: z.coerce.number().int().min(1).max(32).default(4),
  batchSize: z.coerce.number().int().min(1).max(MAX_DELETE_BATCH).default(MAX_DELETE_BATCH),
});

export type PurgeOptions = z.infer<typeof purgeOptionsSchema>;

/** One line describing what was selected, kept on the run for its whole life. */
export function describeSelection(selection: PurgeSelection): string {
  switch (selection.kind) {
    case "ids":
      return selection.productIds.length === 1
        ? `1 product selected on the product screen`
        : `${selection.productIds.length} products selected on the product screen`;
    case "run":
      return `Products from import run ${selection.runId.slice(0, 8)}`;
    case "skus":
      return selection.skus.length === 1
        ? `SKU ${selection.skus[0]}`
        : `${selection.skus.length} SKUs`;
    case "category":
      return `Category “${selection.category}” and its sub-categories`;
    case "all":
      return "Every product on the site";
  }
}

/** The phrase an operator must type before a destructive selection will run. */
export const CONFIRM_PHRASE = "DELETE";

/**
 * Above this many products, an explicitly-ticked list needs the phrase typed too.
 *
 * The two filter selections always need it, whatever they matched, because a filter
 * is a description and the operator cannot see what it caught. A ticked list is
 * different in kind — those rows were on screen — but only up to the point where
 * "selected" stopped meaning "read". Twenty is where a table stops being a list and
 * starts being a number, the same threshold the bulk-edit confirmation uses.
 */
export const TICKED_CONFIRMATION_ABOVE = 20;

/**
 * Does this removal need the phrase typed?
 *
 * A function rather than a set membership test, because the answer now depends on
 * the SIZE of an explicit selection as well as on its kind. `DESTRUCTIVE_SELECTIONS`
 * is kept and still means what it always did — those two are unconditional.
 */
export function purgeNeedsConfirmation(kind: PurgeSelectionKind, count: number): boolean {
  if (DESTRUCTIVE_SELECTIONS.has(kind)) {
    return true;
  }

  return kind === "ids" && count > TICKED_CONFIRMATION_ABOVE;
}

/*
 * Everything below is pure and lives HERE rather than in `lib/purge.ts` for one
 * reason: `lib/purge.ts` reaches the database, which drags bullmq and ioredis
 * behind it, and a Client Component that imports either fails the build with
 * `Can't resolve 'net'`. Screens import from this file; only the server and the
 * worker import `lib/purge.ts`.
 */

/**
 * What a purge run carries as its payload.
 *
 * Not bare ids: once the products are gone, these rows are the only surviving
 * record of what was removed. A results screen listing forty numbers would be
 * technically complete and useless.
 */
export interface PurgeItem {
  product_id: number;
  sku: string;
  name: string;
}

/** Totals across a purge run's per-row `removed` counts, for the run summary. */
export function sumRemoved(
  rows: ReadonlyArray<{ removed?: Record<string, number> }>,
): Record<string, number> {
  const totals: Record<string, number> = {};

  for (const row of rows) {
    for (const [table, count] of Object.entries(row.removed ?? {})) {
      totals[table] = (totals[table] ?? 0) + count;
    }
  }

  return totals;
}

/** Table names in the order the removal summary reads best. */
export const REMOVED_TABLES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "posts", label: "Products and variations" },
  { key: "postmeta", label: "Post meta" },
  { key: "attachments", label: "Image attachments" },
  { key: "files", label: "Image files on disk" },
  { key: "term_relationships", label: "Category and tag links" },
  { key: "lookup", label: "Product lookup rows" },
  { key: "comments", label: "Reviews" },
  { key: "commentmeta", label: "Review meta" },
  { key: "import_log", label: "Idempotency records" },
];
