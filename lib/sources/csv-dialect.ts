/**
 * Which CSV format a file is, and what columns each format has.
 *
 * Split out of `csv.ts` so the BROWSER can answer "what kind of file is this?"
 * without dragging the parsers and papaparse into its bundle. The import wizard
 * reads the header line of the chosen file at step one and calls
 * `detectDialect()` there — no upload, no server round trip, no full parse — so
 * this module has to be cheap and free of Node.
 *
 * Nothing here imports anything. That is the point, and it is worth keeping: the
 * moment this file needs `papaparse` or a type from `gop-client`, the reason for
 * its existence is gone.
 */

export type CsvDialect = "shopify" | "woocommerce" | "etsy" | "custom" | "unknown";
export type KnownDialect = Exclude<CsvDialect, "unknown">;

export interface CsvFieldSpec {
  /** The column name the reader expects. Mapping means filling this name in. */
  key: string;
  label: string;
  required?: boolean;
  scope: "product" | "variant";
}

/* ------------------------------------------------------------- detection */

/**
 * Guess the format from the column names alone.
 *
 * ONLY ASCII column names are compared, and that is deliberate rather than
 * incidental: step one reads the file before anybody has chosen a character
 * encoding, so a spreadsheet saved from a Vietnamese copy of Excel
 * (windows-1258) arrives with its accented column names mangled. `handle`,
 * `variant sku`, `sku`, `regular price`, `title` and `image1` survive that
 * unchanged, so the decision this function makes is unaffected by the encoding
 * question. Anything that depended on an accented name would not be.
 *
 * `custom` is never returned. It is not something a file can be — it is the
 * operator saying "none of these, I will name the columns myself".
 */
export function detectDialect(headers: ReadonlyArray<string>): CsvDialect {
  const normalized = new Set(headers.map((header) => header.trim().toLowerCase()));

  if (normalized.has("handle") && normalized.has("variant sku")) {
    return "shopify";
  }

  // Woo exports "Type"/"SKU"/"Regular price"; the Vietnamese build renames the
  // labels, so both are checked.
  if (normalized.has("sku") && (normalized.has("regular price") || normalized.has("giá gốc"))) {
    return "woocommerce";
  }

  /*
   * Etsy's "Download Listings" export. Checked LAST and only when there is no
   * `handle`, because Shopify also has a `Title` column and would otherwise be
   * mistaken for Etsy on a file that has both.
   *
   * NOT VERIFIED against a real Etsy export — see the note in the README. Etsy's
   * column names vary with the account's language and with whether the listings
   * have variations, so this follows the documented shape rather than an observed
   * file. The custom mapper is the escape hatch when it is wrong.
   */
  if (
    !normalized.has("handle") &&
    normalized.has("title") &&
    (normalized.has("image1") || normalized.has("variation 1 type"))
  ) {
    return "etsy";
  }

  return "unknown";
}

/**
 * The column names out of a CSV's first line.
 *
 * Hand-written rather than handed to papaparse, and that is the reason this module
 * exists: the browser needs the column names at step one to identify the file, and
 * pulling a whole CSV library into the bundle to read ONE LINE is the cost this
 * split was made to avoid.
 *
 * It does handle quotes, because header names genuinely contain commas
 * (`"Price, incl. tax"`) and a naive `split(",")` would silently produce two
 * columns from one — which then shows the operator a column list that does not
 * match their file.
 *
 * It does NOT handle a newline inside a quoted header, which is legal CSV and
 * vanishingly rare in a header row. If that ever appears, the server's own parse
 * is authoritative and will disagree; the column list here is explicitly a
 * preview.
 */
export function parseHeaderLine(text: string): string[] {
  const line = text.split(/\r?\n/, 1)[0] ?? "";

  const columns: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];

    if (quoted) {
      if (character === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === "," || character === ";" || character === "\t") {
      columns.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }

  columns.push(current.trim());

  // A trailing separator leaves one empty name; a file of only empty names is not
  // a header at all, so the caller gets nothing rather than a list of blanks.
  const cleaned = columns.filter((column, position) => column !== "" || position < columns.length - 1);

  return cleaned.every((column) => column === "") ? [] : cleaned;
}

/* ---------------------------------------------------------------- fields */

/**
 * The columns a person is allowed to re-map.
 *
 * Not every column each platform exports — only the ones that genuinely get
 * renamed in real life: files exported from Shopbase, files opened in a
 * Vietnamese Excel and saved again, files edited by hand. An eighty-row mapping
 * table is a table nobody reads.
 */
export const CSV_FIELDS: Record<KnownDialect, CsvFieldSpec[]> = {
  shopify: [
    { key: "Handle", label: "Product group ID (Handle)", required: true, scope: "product" },
    { key: "Title", label: "Product name", required: true, scope: "product" },
    { key: "Body (HTML)", label: "Description", scope: "product" },
    { key: "Published", label: "Published", scope: "product" },
    { key: "Product Category", label: "Category", scope: "product" },
    { key: "Tags", label: "Tags", scope: "product" },
    { key: "Image Src", label: "Image", scope: "product" },
    { key: "Variant SKU", label: "Variant SKU", scope: "variant" },
    { key: "Variant Price", label: "Variant price", scope: "variant" },
    { key: "Variant Compare At Price", label: "Variant compare-at price", scope: "variant" },
    { key: "Variant Inventory Policy", label: "Stock policy", scope: "variant" },
    { key: "Variant Image", label: "Variant image", scope: "variant" },
    { key: "Option1 Name", label: "Attribute 1 name", scope: "variant" },
    { key: "Option1 Value", label: "Attribute 1 value", scope: "variant" },
    { key: "Option2 Name", label: "Attribute 2 name", scope: "variant" },
    { key: "Option2 Value", label: "Attribute 2 value", scope: "variant" },
    { key: "Option3 Name", label: "Attribute 3 name", scope: "variant" },
    { key: "Option3 Value", label: "Attribute 3 value", scope: "variant" },
  ],
  woocommerce: [
    { key: "Name", label: "Product name", required: true, scope: "product" },
    { key: "SKU", label: "SKU", required: true, scope: "product" },
    { key: "Type", label: "Type (simple / variation)", scope: "product" },
    { key: "Parent", label: "Parent product SKU", scope: "variant" },
    { key: "Description", label: "Description", scope: "product" },
    { key: "Short description", label: "Short description", scope: "product" },
    { key: "Published", label: "Published", scope: "product" },
    { key: "Regular price", label: "Regular price", scope: "product" },
    { key: "Sale price", label: "Sale price", scope: "product" },
    { key: "In stock?", label: "In stock", scope: "product" },
    { key: "Categories", label: "Categories", scope: "product" },
    { key: "Tags", label: "Tags", scope: "product" },
    { key: "Images", label: "Images", scope: "product" },
  ],
  etsy: [
    { key: "TITLE", label: "Product name", required: true, scope: "product" },
    { key: "DESCRIPTION", label: "Description", scope: "product" },
    { key: "PRICE", label: "Price", scope: "product" },
    { key: "QUANTITY", label: "Quantity", scope: "product" },
    { key: "SKU", label: "SKU", scope: "product" },
    { key: "TAGS", label: "Tags", scope: "product" },
    { key: "MATERIALS", label: "Materials (added as tags)", scope: "product" },
    { key: "IMAGE1", label: "Image 1", scope: "product" },
    { key: "VARIATION 1 TYPE", label: "Attribute 1 name", scope: "variant" },
    { key: "VARIATION 1 VALUES", label: "Attribute 1 values", scope: "variant" },
    { key: "VARIATION 2 TYPE", label: "Attribute 2 name", scope: "variant" },
    { key: "VARIATION 2 VALUES", label: "Attribute 2 values", scope: "variant" },
  ],

  /**
   * ANY CSV, mapped by hand.
   *
   * The fields are named after product concepts rather than after any
   * marketplace's columns, and that is the whole point of this dialect. Mapping a
   * strange file used to mean choosing Shopify and then explaining your file in
   * terms of `Handle` and `Option1 Name` — you had to understand Shopify's export
   * in order to describe a file that was nothing to do with Shopify.
   *
   * Only `name` is required. Everything else missing is simply absent, not an
   * error, so a two-column file of names and prices imports fine. That is the
   * property being aimed at: any file at all works, so long as you can point at
   * which column holds the product name.
   */
  custom: [
    { key: "name", label: "Product name", required: true, scope: "product" },
    { key: "sku", label: "SKU", scope: "product" },
    { key: "slug", label: "Slug (URL)", scope: "product" },
    { key: "description", label: "Description", scope: "product" },
    { key: "short_description", label: "Short description", scope: "product" },
    { key: "price", label: "Price", scope: "product" },
    { key: "regular_price", label: "Regular price", scope: "product" },
    { key: "sale_price", label: "Sale price", scope: "product" },
    { key: "categories", label: "Categories", scope: "product" },
    { key: "tags", label: "Tags", scope: "product" },
    { key: "images", label: "Images", scope: "product" },
    { key: "stock", label: "Stock quantity", scope: "product" },
    { key: "instock", label: "In stock", scope: "product" },
    { key: "shipping_class", label: "Shipping class", scope: "product" },
    { key: "parent_sku", label: "Parent product SKU (makes this row a variant)", scope: "variant" },
    { key: "attribute_1_name", label: "Attribute 1 name", scope: "variant" },
    { key: "attribute_1_value", label: "Attribute 1 value", scope: "variant" },
    { key: "attribute_2_name", label: "Attribute 2 name", scope: "variant" },
    { key: "attribute_2_value", label: "Attribute 2 value", scope: "variant" },
    { key: "attribute_3_name", label: "Attribute 3 name", scope: "variant" },
    { key: "attribute_3_value", label: "Attribute 3 value", scope: "variant" },
  ],
};

/* ---------------------------------------------------------------- labels */

export interface DialectMeta {
  label: string;
  /** One line, said in the wizard where the choice is made. */
  hint: string;
}

export const DIALECT_META: Record<KnownDialect, DialectMeta> = {
  shopify: {
    label: "Shopify / Shopbase",
    hint: "One row per variant, grouped by Handle.",
  },
  woocommerce: {
    label: "WooCommerce",
    hint: "Variation rows point at their parent by SKU.",
  },
  etsy: {
    label: "Etsy",
    hint: "The Download Listings export. Not yet verified against a real file.",
  },
  custom: {
    label: "Custom — map the columns",
    hint: "Any CSV at all. Name which column is which; only the product name is required.",
  },
};

/** The order they are offered in. Custom last: it is the fallback, not a guess. */
export const DIALECT_ORDER: ReadonlyArray<KnownDialect> = [
  "shopify",
  "woocommerce",
  "etsy",
  "custom",
];

/* ------------------------------------------------------------ signatures */

/**
 * A fingerprint of the column set.
 *
 * Used to remember a mapping PER FILE FORMAT rather than per file: two exports
 * from the same system have the same columns, so a mapping corrected once is
 * applied again next time.
 *
 * FNV-1a, not a cryptographic hash — this is a lookup key with no security
 * requirement, and it should not pull `node:crypto` into a module the browser
 * imports.
 */
export function columnSignature(columns: ReadonlyArray<string>): string {
  const normalized = [...columns]
    .map((column) => column.trim().toLowerCase())
    .sort()
    .join(" ");

  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

/* --------------------------------------------------------- guessing a map */

/**
 * A first guess at which real column feeds which field.
 *
 * Compared with accents folded and punctuation dropped, so `"Tên sản phẩm"`
 * reaches `name` and `"Giá bán"` reaches `price`. It is only ever a starting
 * point — every guess is shown in a dropdown the operator can change, and a wrong
 * guess costs one click rather than a failed import.
 *
 * Deliberately conservative: a field with no confident match is left unmapped
 * rather than filled with the closest thing. Silently mapping `"Giá gốc"` into
 * `price` when the operator meant `regular_price` would publish wrong money.
 */
export function guessColumnMap(
  dialect: KnownDialect,
  columns: ReadonlyArray<string>,
): Record<string, string> {
  const out: Record<string, string> = {};

  /*
   * Fold to bare letters and digits: no accents, no case, no punctuation.
   *
   * The combining-mark range is written as escapes rather than as literal
   * characters — the literal form is invisible in an editor and does not survive
   * being copied through a terminal or a diff. `đ`/`Đ` needs its own line because
   * it is a distinct letter in Unicode, not a `d` with a mark, so NFD leaves it
   * alone.
   */
  const simplify = (input: string) =>
    input
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  const byShape = new Map<string, string>();
  for (const column of columns) {
    const key = simplify(column);
    if (key !== "" && !byShape.has(key)) {
      byShape.set(key, column);
    }
  }

  for (const field of CSV_FIELDS[dialect]) {
    // The field's own name, then the words a human would have written instead.
    for (const candidate of [field.key, field.label, ...(ALIASES[field.key] ?? [])]) {
      const found = byShape.get(simplify(candidate));
      if (found !== undefined) {
        out[field.key] = found;
        break;
      }
    }
  }

  return out;
}

/**
 * What people actually call these columns.
 *
 * Vietnamese included because that is what the files being imported look like —
 * these are matched with accents folded, so `"Ten san pham"` and `"Tên sản phẩm"`
 * both land.
 */
const ALIASES: Record<string, ReadonlyArray<string>> = {
  name: ["title", "product name", "product", "ten san pham", "ten", "tensanpham", "san pham", "ten hang"],
  // "ma hang" observed in a real file and missed by the first version of this list.
  // Vietnamese shops call a SKU any of these, and none of them contain "sku".
  sku: ["ma sku", "product sku", "ma san pham", "ma hang", "ma sp", "code", "ma", "barcode"],
  slug: ["url", "duong dan", "permalink", "duong dan tinh"],
  description: ["mo ta", "noi dung", "body", "body (html)", "long description", "chi tiet"],
  short_description: ["mo ta ngan", "excerpt", "tom tat"],
  price: ["gia", "gia ban", "sale price", "unit price", "amount", "don gia", "gia le"],
  regular_price: ["gia goc", "compare at price", "list price", "gia niem yet", "gia goc niem yet"],
  sale_price: ["gia khuyen mai", "gia giam", "discount price", "gia sale"],
  categories: ["category", "danh muc", "nhom san pham", "product category"],
  tags: ["tag", "the", "keywords", "nhan"],
  images: ["image", "image src", "anh", "hinh anh", "photo", "picture", "image1"],
  stock: ["quantity", "so luong", "ton kho", "qty", "inventory"],
  instock: ["in stock", "con hang", "available", "in stock?"],
  shipping_class: ["shipping", "van chuyen"],
  parent_sku: ["parent", "sku cha", "san pham cha", "parent product"],
  attribute_1_name: ["option1 name", "variation 1 type", "thuoc tinh 1", "attribute 1"],
  attribute_1_value: ["option1 value", "variation 1 values", "gia tri 1"],
  attribute_2_name: ["option2 name", "variation 2 type", "thuoc tinh 2", "attribute 2"],
  attribute_2_value: ["option2 value", "variation 2 values", "gia tri 2"],
  attribute_3_name: ["option3 name", "thuoc tinh 3", "attribute 3"],
  attribute_3_value: ["option3 value", "gia tri 3"],
};
