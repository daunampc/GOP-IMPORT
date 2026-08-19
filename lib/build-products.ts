import "server-only";

import { importOptionsSchema, type ImportOptions } from "./import-options";
import {
  DIALECT_ORDER,
  decodeCsv,
  parseCsv,
  type CsvDialect,
  type KnownDialect,
} from "./sources/csv";
import { applyOptions } from "./transform";
import type { Product } from "./gop-client";

/**
 * The path SHARED by "Preview" and "Start".
 *
 * Deliberately one function: a preview that runs different code from the real
 * import is a preview of nothing. This build goes a step further — "Start" no
 * longer rebuilds from the file at all, it points at what was built here. See
 * `lib/preview.ts`.
 */

export interface BuildResult {
  options: ImportOptions;
  products: Product[];
  /** Parallel to `products`: true where the SKU was generated, not read. */
  generatedSku: boolean[];
  sourceLabel: string;
  dialect: CsvDialect | null;
  warnings: string[];
  errors: Array<{ row: number; message: string }>;
  skippedRows: number;
  /** Column names read from the CSV. */
  columns: string[];
  /** Signature of the column set, used to remember a mapping per format. */
  signature: string | null;
}

export class BuildError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** Columns that were read — returned so the UI can open the mapper on the spot. */
    readonly columns: string[] = [],
  ) {
    super(message);
  }
}

export async function buildProductsFromRequest(request: Request): Promise<BuildResult> {
  const form = await request.formData();

  const rawOptions = form.get("options");
  if (typeof rawOptions !== "string") {
    throw new BuildError("Missing the `options` field.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawOptions);
  } catch {
    throw new BuildError("`options` is not valid JSON.");
  }

  const parsed = importOptionsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new BuildError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const options = parsed.data;
  const source = await fromCsv(form, options);

  // Which rows arrived WITHOUT a SKU. Recorded before the transform, because
  // afterwards a generated SKU is indistinguishable from a real one.
  const missingSku = source.products.map((product) => (product.sku ?? "").trim() === "");

  const built = applyOptions(source.products, options, { sourceId: source.sourceLabel });

  const entries = built.map((product, index) => ({
    product,
    generatedSku: missingSku[index] && (product.sku ?? "").trim() !== "",
  }));

  // "Skip repeated SKUs": drop rows that repeat a SKU already seen above them.
  const deduped = options.skipRepeatedSku ? dropRepeatedSkus(entries) : { entries, removed: [] };

  const warnings = [...source.warnings];
  if (deduped.removed.length > 0) {
    /*
     * Name enough of the dropped SKUs to act on.
     *
     * Five with an ellipsis was not enough to tell "my file has five accidental
     * duplicates" from "my file is one product repeated four hundred times", and
     * those two call for opposite decisions. Thirty, with the remainder counted.
     */
    const SHOWN = 30;
    const rest = deduped.removed.length - SHOWN;

    warnings.push(
      `Dropped ${deduped.removed.length} row(s) repeating a SKU from further up the file: ` +
        deduped.removed.slice(0, SHOWN).join(", ") +
        (rest > 0 ? `, and ${rest} more` : "") +
        `. Turn off "Skip repeated SKUs" to keep them.`,
    );
  }

  return {
    ...source,
    warnings,
    options,
    products: deduped.entries.map((entry) => entry.product),
    generatedSku: deduped.entries.map((entry) => entry.generatedSku),
  };
}

interface BuildEntry {
  product: Product;
  generatedSku: boolean;
}

function dropRepeatedSkus(entries: BuildEntry[]): { entries: BuildEntry[]; removed: string[] } {
  const seen = new Set<string>();
  const removed: string[] = [];
  const kept: BuildEntry[] = [];

  for (const entry of entries) {
    const sku = entry.product.sku?.trim();

    if (sku && seen.has(sku)) {
      removed.push(sku);
      continue;
    }

    if (sku) {
      seen.add(sku);
    }
    kept.push(entry);
  }

  return { entries: kept, removed };
}

type SourceResult = Omit<BuildResult, "options" | "generatedSku">;

function readColumnMap(form: FormData): Record<string, string> | undefined {
  const raw = form.get("columnMap");
  if (typeof raw !== "string" || raw.trim() === "") {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    throw new BuildError("`columnMap` is not valid JSON.");
  }
}

/**
 * The format the caller asked for, if any. `undefined` means "detect it".
 *
 * Checked against DIALECT_ORDER rather than a hand-written list of literals, and
 * that is the fix for the second half of a real bug. The list here said
 * `"shopify" || "woocommerce"`, so a request naming `etsy` or `custom` fell
 * through to `undefined` and was silently auto-detected instead — which would
 * have made the custom mapper impossible to use while looking, from the outside,
 * like the mapping was being ignored.
 *
 * Now adding a dialect to the union is enough; there is no second list to
 * remember.
 */
function readDialect(form: FormData): KnownDialect | undefined {
  const raw = form.get("dialect");

  if (typeof raw !== "string") {
    return undefined;
  }

  return DIALECT_ORDER.find((option) => option === raw);
}

async function fromCsv(form: FormData, options: ImportOptions): Promise<SourceResult> {
  const file = form.get("file");

  if (!(file instanceof File)) {
    throw new BuildError("No CSV file chosen.");
  }

  const text = decodeCsv(await file.arrayBuffer(), options.encoding);
  const parsed = parseCsv(text, {
    dialect: readDialect(form),
    columnMap: readColumnMap(form),
  });

  if (parsed.dialect === "unknown") {
    throw new BuildError(
      parsed.errors.map((error) => error.message).join("; ") || "Unrecognised CSV format.",
      400,
      // Carry the column list: the UI opens the mapper right at the error rather
      // than making someone guess which column means what.
      parsed.columns,
    );
  }

  // "Stop if the CSV has errors" — fail at the read step instead of publishing
  // half a file and discovering the problem afterwards.
  if (options.skipOnCsvError && parsed.errors.length > 0) {
    /*
     * Show ENOUGH of the errors to see the pattern.
     *
     * Five was arbitrary and actively misleading: a file where every row is broken
     * the same way, and a file where five rows are broken and the rest are fine,
     * produced identical messages. Twenty is enough to tell those apart, and the
     * count of what is left is stated rather than implied by an ellipsis.
     */
    const SHOWN = 20;

    const preview = parsed.errors
      .slice(0, SHOWN)
      .map((error) => `row ${error.row}: ${error.message}`)
      .join("\n");

    const rest = parsed.errors.length - SHOWN;

    throw new BuildError(
      `The CSV has ${parsed.errors.length} error(s) and "Stop if the CSV has errors" is on.\n\n` +
        preview +
        (rest > 0 ? `\n\n…and ${rest} more row(s) with errors.` : "") +
        `\n\nTurn that option off to import the rows that do read, or fix the file and try again.`,
      400,
      parsed.columns,
    );
  }

  return {
    products: parsed.products,
    sourceLabel: file.name,
    dialect: parsed.dialect,
    columns: parsed.columns,
    signature: parsed.signature,
    warnings: parsed.skippedRows > 0 ? [`Skipped ${parsed.skippedRows} unreadable row(s).`] : [],
    errors: parsed.errors,
    skippedRows: parsed.skippedRows,
  };
}
