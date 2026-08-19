import Papa from "papaparse";

import type { Product, ProductVariation } from "../gop-client";
import {
  columnSignature,
  detectDialect,
  type CsvDialect,
  type KnownDialect,
} from "./csv-dialect";

/**
 * Read a CSV exported from Shopify / Shopbase / WooCommerce / Etsy — or any file
 * at all, with the columns named by hand — into Product[].
 *
 * Each platform uses a different column set, so `detectDialect` guesses from the
 * column NAMES rather than making somebody choose, and answers `unknown` when it
 * cannot tell so the caller can say so plainly instead of parsing rubbish.
 *
 * The dialect table, the detector and the field lists live in `./csv-dialect`,
 * which imports nothing — the browser needs them at step one of the wizard to
 * identify a file without uploading it, and it should not have to pull papaparse
 * and every parser along for that. They are re-exported here so server code keeps
 * a single way in.
 */

export {
  CSV_FIELDS,
  DIALECT_META,
  DIALECT_ORDER,
  columnSignature,
  detectDialect,
  guessColumnMap,
} from "./csv-dialect";
export type { CsvDialect, CsvFieldSpec, KnownDialect } from "./csv-dialect";

export interface CsvParseResult {
  dialect: CsvDialect;
  products: Product[];
  /** Per-row errors — feeds the "Stop if the CSV has errors" option. */
  errors: Array<{ row: number; message: string }>;
  skippedRows: number;
  /** The column names as read, in the file's own order. */
  columns: string[];
  /** Fingerprint of the column set — remembers a mapping per file format. */
  signature: string;
}

export interface ParseCsvOptions {
  /** Force the format when detection gets it wrong. */
  dialect?: KnownDialect;
  /** `{ expected column name: real column name in the file }`. */
  columnMap?: Record<string, string>;
}

/** The encoding names the UI offers, mapped to labels TextDecoder understands. */
const ENCODING_MAP: Record<string, string> = {
  default: "utf-8",
  "utf-8": "utf-8",
  "utf-8-bom": "utf-8",
  "windows-1258": "windows-1258",
  latin1: "iso-8859-1",
};

export function decodeCsv(buffer: ArrayBuffer, encoding: string): string {
  const label = ENCODING_MAP[encoding] ?? "utf-8";

  // fatal: false — a bad byte becomes the replacement character rather than an
  // exception. One mangled character in a description is not worth losing the file.
  let text = new TextDecoder(label, { fatal: false }).decode(buffer);

  // A BOM left on the first column name makes every column comparison miss.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  return text;
}


/**
 * Fill the expected columns from whichever real columns were named.
 *
 * COPIES rather than renames, deliberately: the original column stays, so one
 * field mapped wrongly cannot damage the fields that were mapped correctly.
 */
function applyColumnMap(
  rows: Rows,
  columnMap: Record<string, string> | undefined,
): Rows {
  const pairs = Object.entries(columnMap ?? {}).filter(
    ([target, source]) => source.trim() !== "" && source !== target,
  );

  if (pairs.length === 0) {
    return rows;
  }

  return rows.map((row) => {
    const next = { ...row };
    for (const [target, source] of pairs) {
      if (row[source] !== undefined) {
        next[target] = row[source];
      }
    }
    return next;
  });
}

export function parseCsv(text: string, options: ParseCsvOptions = {}): CsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });

  const columns = parsed.meta.fields ?? [];
  const signature = columnSignature(columns);
  const rows = applyColumnMap(parsed.data, options.columnMap);

  // A hand-made mapping can create exactly the columns the detector looks for, so
  // detection has to run AFTER the mapping rather than before it.
  const dialect =
    options.dialect ?? detectDialect(Object.keys(rows[0] ?? {}).concat(columns));

  const errors: Array<{ row: number; message: string }> = parsed.errors.map((error) => ({
    // Papa counts from 0 and does not count the header row.
    row: (error.row ?? 0) + 2,
    message: error.message,
  }));

  if (dialect === "unknown") {
    return {
      dialect,
      products: [],
      skippedRows: parsed.data.length,
      columns,
      signature,
      errors: [
        ...errors,
        {
          row: 1,
          message:
            "Could not recognise this CSV format. Choose the format by hand, or use " +
            `the column mapper. Columns found: ${columns.slice(0, 12).join(", ")}`,
        },
      ],
    };
  }

  const result = PARSERS[dialect](rows);

  return {
    dialect,
    ...result,
    columns,
    signature,
    errors: [...errors, ...result.errors],
  };
}

/**
 * One parser per format, looked up rather than branched.
 *
 * A chain of ternaries is how the fourth format gets forgotten. With a
 * `Record<KnownDialect, …>` the compiler refuses to build until every dialect in
 * the union has a parser, which is exactly the reminder wanted when a fifth
 * marketplace is added.
 */
const PARSERS: Record<KnownDialect, (rows: Rows) => ParseBody> = {
  shopify: parseShopify,
  woocommerce: parseWooCommerce,
  etsy: parseEtsy,
  custom: parseCustom,
};

type Rows = Array<Record<string, string>>;
type ParseBody = Pick<CsvParseResult, "products" | "errors" | "skippedRows">;

function value(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const found = row[name];
    if (found !== undefined && found.trim() !== "") {
      return found.trim();
    }
  }
  return "";
}

/**
 * Shopify exports one row per variant, with the rows of one product sharing a
 * `Handle`. The first row carries the product; later rows usually hold only the
 * handle, the variant data and an image.
 */
function parseShopify(rows: Rows): ParseBody {
  const grouped = new Map<string, Rows>();
  const errors: ParseBody["errors"] = [];
  let skippedRows = 0;

  rows.forEach((row, index) => {
    const handle = value(row, "Handle");
    if (handle === "") {
      skippedRows++;
      errors.push({ row: index + 2, message: "No Handle column on this row" });
      return;
    }

    const bucket = grouped.get(handle);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(handle, [row]);
    }
  });

  const products: Product[] = [];

  for (const [handle, group] of grouped) {
    const head = group[0];
    const name = value(head, "Title");

    if (name === "") {
      errors.push({ row: 0, message: `Product "${handle}" has no Title` });
      continue;
    }

    // Images are spread across every row of the handle, not just the first.
    const images = unique(
      group.map((row) => value(row, "Image Src")).filter((url) => url !== ""),
    );

    const optionNames = [1, 2, 3]
      .map((position) => value(head, `Option${position} Name`))
      .filter((optionName) => optionName !== "" && optionName.toLowerCase() !== "title");

    const variationRows = group.filter((row) => value(row, "Variant SKU", "Variant Price") !== "");

    const variations: ProductVariation[] = variationRows.map((row) => ({
      sku: value(row, "Variant SKU"),
      price: value(row, "Variant Price"),
      regular_price: value(row, "Variant Compare At Price") || value(row, "Variant Price"),
      instock: value(row, "Variant Inventory Policy") !== "deny",
      image: value(row, "Variant Image") || undefined,
      attributes: optionNames.map((optionName, position) => ({
        name: optionName,
        value: value(row, `Option${position + 1} Value`),
      })),
    }));

    const attributes = optionNames.map((optionName, position) => ({
      name: optionName,
      values: unique(
        variationRows
          .map((row) => value(row, `Option${position + 1} Value`))
          .filter((optionValue) => optionValue !== ""),
      ),
    }));

    products.push({
      name,
      slug: handle,
      sku: value(head, "Variant SKU"),
      description: value(head, "Body (HTML)"),
      type: variations.length > 1 ? "variable" : "simple",
      status: value(head, "Published").toLowerCase() === "false" ? "draft" : "publish",
      categories: splitList(value(head, "Product Category", "Type")),
      tags: splitList(value(head, "Tags")),
      images,
      price: variations[0]?.price,
      instock: true,
      attributes: attributes.filter((attribute) => attribute.values.length > 0),
      variations: variations.length > 1 ? variations : [],
    });
  }

  return { products, errors, skippedRows };
}

/**
 * Woo exports one row per product; a variation is its own row with `Type` =
 * `variation` and `Parent` pointing at the parent product's SKU.
 */
function parseWooCommerce(rows: Rows): ParseBody {
  const errors: ParseBody["errors"] = [];
  let skippedRows = 0;

  const parents: Rows = [];
  const childrenByParent = new Map<string, Rows>();

  rows.forEach((row, index) => {
    const type = value(row, "Type", "Loại").toLowerCase();

    if (type === "variation") {
      const parent = value(row, "Parent", "Cha").replace(/^id:/i, "");
      if (parent === "") {
        skippedRows++;
        errors.push({ row: index + 2, message: "Variation row has no Parent column" });
        return;
      }
      const bucket = childrenByParent.get(parent);
      if (bucket) {
        bucket.push(row);
      } else {
        childrenByParent.set(parent, [row]);
      }
      return;
    }

    if (value(row, "Name", "Tên") === "") {
      skippedRows++;
      errors.push({ row: index + 2, message: "No Name column on this row" });
      return;
    }

    parents.push(row);
  });

  const products: Product[] = parents.map((row) => {
    const sku = value(row, "SKU");
    const children = childrenByParent.get(sku) ?? [];

    const attributeColumns = collectWooAttributes(row);

    const variations: ProductVariation[] = children.map((child) => ({
      sku: value(child, "SKU"),
      price: value(child, "Sale price", "Giá khuyến mãi") || value(child, "Regular price", "Giá gốc"),
      regular_price: value(child, "Regular price", "Giá gốc"),
      instock: value(child, "In stock?", "Còn hàng?").toLowerCase() !== "0",
      image: firstImage(value(child, "Images", "Hình ảnh")),
      attributes: collectWooAttributes(child).map((attribute) => ({
        name: attribute.name,
        value: attribute.values[0] ?? "",
      })),
    }));

    return {
      name: value(row, "Name", "Tên"),
      slug: "",
      sku,
      description: value(row, "Description", "Mô tả"),
      short_description: value(row, "Short description", "Mô tả ngắn"),
      type: children.length > 0 ? "variable" : "simple",
      status: value(row, "Published").trim() === "0" ? "draft" : "publish",
      price: value(row, "Sale price", "Giá khuyến mãi") || value(row, "Regular price", "Giá gốc"),
      regular_price: value(row, "Regular price", "Giá gốc"),
      instock: value(row, "In stock?", "Còn hàng?").toLowerCase() !== "0",
      categories: splitList(value(row, "Categories", "Danh mục")),
      tags: splitList(value(row, "Tags", "Thẻ")),
      images: splitList(value(row, "Images", "Hình ảnh")),
      attributes: attributeColumns,
      variations,
    };
  });

  return { products, errors, skippedRows };
}

/** Woo names attribute columns in pairs: "Attribute N name" / "Attribute N value(s)". */
function collectWooAttributes(
  row: Record<string, string>,
): Array<{ name: string; values: string[] }> {
  const attributes: Array<{ name: string; values: string[] }> = [];

  for (let position = 1; position <= 6; position++) {
    const name = value(row, `Attribute ${position} name`);
    const values = value(row, `Attribute ${position} value(s)`);

    if (name !== "" && values !== "") {
      attributes.push({ name, values: splitList(values) });
    }
  }

  return attributes;
}

function firstImage(images: string): string | undefined {
  const list = splitList(images);
  return list[0];
}

function splitList(raw: string): string[] {
  if (raw === "") {
    return [];
  }
  return unique(
    raw
      .split(/[,|]/)
      .map((part) => part.trim())
      .filter((part) => part !== ""),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/* ------------------------------------------------------------------ etsy */

/**
 * Etsy's "Download Listings" export: one row per LISTING, with variations held
 * inside the row as comma-separated value lists rather than as separate rows.
 *
 * NOT VERIFIED AGAINST A REAL EXPORT. Etsy's column names vary with the account
 * language and with whether any listing has variations, so this follows the
 * documented shape. When it is wrong, the custom mapper is the way through, and
 * the README says so rather than implying this was tested.
 *
 * The variation model is genuinely lossy and that is Etsy's fault, not a shortcut:
 * Etsy gives the variation TYPE and the list of VALUES but no per-combination
 * price or SKU, so there is nothing to build a priced variant from. The values
 * become product attributes, and the listing stays a simple product at the
 * listing price. Inventing a price per variant would be making data up.
 */
function parseEtsy(rows: Rows): ParseBody {
  const errors: ParseBody["errors"] = [];
  let skippedRows = 0;
  const products: Product[] = [];

  rows.forEach((row, index) => {
    const name = value(row, "TITLE", "Title");

    if (name === "") {
      skippedRows++;
      errors.push({ row: index + 2, message: "No TITLE column on this row" });
      return;
    }

    // IMAGE1…IMAGE10 are separate columns, not one list.
    const images = unique(
      Array.from({ length: 10 }, (_ignored, position) =>
        value(row, `IMAGE${position + 1}`, `Image${position + 1}`),
      ).filter((url) => url !== ""),
    );

    const attributes: NonNullable<Product["attributes"]> = [];

    for (let position = 1; position <= 2; position++) {
      const attributeName = value(row, `VARIATION ${position} TYPE`);
      const values = splitList(value(row, `VARIATION ${position} VALUES`));

      if (attributeName !== "" && values.length > 0) {
        attributes.push({ name: attributeName, values, visible: true });
      }
    }

    const quantity = Number.parseInt(value(row, "QUANTITY", "Quantity"), 10);

    products.push({
      name,
      slug: "",
      sku: value(row, "SKU"),
      description: value(row, "DESCRIPTION", "Description"),
      type: "simple",
      status: "publish",
      price: value(row, "PRICE", "Price"),
      // Materials are Etsy's own vocabulary and there is nowhere better for them
      // in WooCommerce, so they join the tags rather than being dropped.
      tags: unique([
        ...splitList(value(row, "TAGS", "Tags")),
        ...splitList(value(row, "MATERIALS", "Materials")),
      ]),
      images,
      stock: Number.isFinite(quantity) ? quantity : null,
      instock: !Number.isFinite(quantity) || quantity > 0,
      attributes,
      variations: [],
    });
  });

  return { products, errors, skippedRows };
}

/* ---------------------------------------------------------------- custom */

/**
 * ANY CSV, with the columns named by hand.
 *
 * The fields are product concepts (`name`, `price`, `parent_sku`) rather than any
 * marketplace's column names, which is the point: describing a strange file used
 * to mean choosing Shopify and then explaining your file in terms of `Handle` and
 * `Option1 Name`.
 *
 * ONLY `name` IS REQUIRED. Every other field missing is simply absent rather than
 * an error, so a two-column file of names and prices imports cleanly. A row with
 * no name is the one thing that cannot be salvaged — there is nothing to create.
 *
 * Variants follow the same rule WooCommerce uses, so there is no new convention to
 * learn: a row with `parent_sku` is a variant of the product whose `sku` matches.
 */
function parseCustom(rows: Rows): ParseBody {
  const errors: ParseBody["errors"] = [];
  let skippedRows = 0;

  const parents: Rows = [];
  const childrenByParent = new Map<string, Rows>();

  rows.forEach((row, index) => {
    const parentSku = value(row, "parent_sku");

    if (parentSku !== "") {
      const bucket = childrenByParent.get(parentSku);
      if (bucket) {
        bucket.push(row);
      } else {
        childrenByParent.set(parentSku, [row]);
      }
      return;
    }

    if (value(row, "name") === "") {
      skippedRows++;
      errors.push({
        row: index + 2,
        message:
          "No product name on this row. Map a column to \"Product name\" in the column mapper — " +
          "it is the one field that cannot be left out.",
      });
      return;
    }

    parents.push(row);
  });

  const products: Product[] = parents.map((row) => {
    const sku = value(row, "sku");
    const children = sku === "" ? [] : (childrenByParent.get(sku) ?? []);

    const variations: ProductVariation[] = children.map((child) => ({
      sku: value(child, "sku"),
      price: value(child, "price") || value(child, "regular_price"),
      regular_price: value(child, "regular_price") || value(child, "price"),
      sale_price: value(child, "sale_price") || undefined,
      instock: isTruthy(value(child, "instock"), true),
      image: firstImage(value(child, "images")),
      attributes: customAttributes(child).map((attribute) => ({
        name: attribute.name,
        value: attribute.values[0] ?? "",
      })),
    }));

    const stock = Number.parseInt(value(row, "stock"), 10);

    return {
      name: value(row, "name"),
      slug: value(row, "slug"),
      sku,
      description: value(row, "description"),
      short_description: value(row, "short_description"),
      type: children.length > 0 ? "variable" : "simple",
      status: isTruthy(value(row, "status"), true) ? "publish" : "draft",
      price: value(row, "price") || value(row, "regular_price"),
      regular_price: value(row, "regular_price") || value(row, "price"),
      sale_price: value(row, "sale_price") || undefined,
      instock: isTruthy(value(row, "instock"), true),
      stock: Number.isFinite(stock) ? stock : null,
      categories: splitList(value(row, "categories")),
      tags: splitList(value(row, "tags")),
      images: splitList(value(row, "images")),
      shipping_class: value(row, "shipping_class") || undefined,
      attributes: customAttributes(row),
      variations,
    };
  });

  /*
   * A variant naming a parent that is not in the file.
   *
   * Reported rather than dropped in silence: it usually means the mapping put the
   * wrong column in `parent_sku`, and the symptom otherwise is a product count
   * quietly lower than the row count with nothing to explain it.
   */
  const knownSkus = new Set(parents.map((row) => value(row, "sku")).filter((sku) => sku !== ""));

  for (const [parentSku, orphans] of childrenByParent) {
    if (!knownSkus.has(parentSku)) {
      skippedRows += orphans.length;
      errors.push({
        row: 0,
        message:
          `${orphans.length} variant row(s) name parent SKU "${parentSku}", ` +
          "and no product in this file has that SKU.",
      });
    }
  }

  return { products, errors, skippedRows };
}

/** Attribute columns for the custom format: three name/value pairs. */
function customAttributes(
  row: Record<string, string>,
): Array<{ name: string; values: string[]; visible?: boolean }> {
  const attributes: Array<{ name: string; values: string[]; visible?: boolean }> = [];

  for (let position = 1; position <= 3; position++) {
    const name = value(row, `attribute_${position}_name`);
    const values = value(row, `attribute_${position}_value`);

    if (name !== "" && values !== "") {
      attributes.push({ name, values: splitList(values), visible: true });
    }
  }

  return attributes;
}

/**
 * Read a yes/no cell written by a human.
 *
 * Spreadsheets carry every spelling of both answers, and an unrecognised value has
 * to fall back rather than guess: a blank "in stock" column means the file simply
 * does not say, and defaulting that to out-of-stock would hide a whole catalogue
 * on the site.
 */
function isTruthy(raw: string, fallback: boolean): boolean {
  const text = raw.trim().toLowerCase();

  if (text === "") {
    return fallback;
  }

  if (["1", "yes", "y", "true", "publish", "published", "in stock", "instock", "co", "có"].includes(text)) {
    return true;
  }

  if (["0", "no", "n", "false", "draft", "out of stock", "khong", "không"].includes(text)) {
    return false;
  }

  return fallback;
}
