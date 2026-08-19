import type { Product, ProductUpdate } from "./gop-client";

/*
 * Turning a row that was read for an IMPORT into a row that OVERWRITES a product.
 *
 * No "server-only" and no value imports beyond a type: the import wizard runs this
 * in the browser to show, before anything is sent, exactly which fields a re-sync
 * would write. `import type` is erased at compile time, so nothing of
 * `gop-client` — and therefore nothing of `node:crypto` — reaches the bundle.
 */

/**
 * THE DANGEROUS CONVERSION, and it is dangerous in a specific, provable way.
 *
 * A `Product` built for an import is NOT a partial description of a change. The
 * CSV reader fills every field it knows about, using `""` and `[]` for columns the
 * file does not even have — `description: value(row, "Description")` returns `""`
 * when there is no Description column at all. Handing that straight to
 * `/products/update` would send `"description": ""` for every row, and `""` on
 * that route means CLEAR IT ON PURPOSE. A file of SKUs and prices would wipe the
 * description of every product it touched.
 *
 * Two more traps in the same object:
 *
 *  - `slug` is ALWAYS set, by `applySlug`, and normally carries a random suffix.
 *    Sending it would rewrite the URL of every product in the file — silently, and
 *    with no way back to the old URLs.
 *  - `idempotency_key` is derived from the source id, the row index, the sku AND
 *    the slug — so a fresh read of the same file produces a DIFFERENT key. It is
 *    useless as a matching key here and must not be sent; matching is by SKU,
 *    which is what "already on the site" means to the person reading the screen.
 *
 * So the rule is deliberately narrow, and narrow in the safe direction:
 *
 *   a field is written ONLY when the row carries a real value for it.
 *
 * The cost is stated rather than hidden: a file-driven update can never CLEAR a
 * field. Clearing one is a deliberate act on one product, which is what the
 * product screen's editor is for. Choosing the other way round would mean every
 * missing column silently emptied a column of the catalogue, and no amount of
 * confirmation text makes that a reasonable default.
 */
export function toProductUpdate(product: Product): ProductUpdate | null {
  const sku = (product.sku ?? "").trim();

  // With no SKU there is nothing to match on. Not an error here — the caller
  // decides what to do with a row that cannot be matched, and `describeUpdate`
  // below is what tells the operator how many such rows there are.
  if (sku === "") {
    return null;
  }

  const update: ProductUpdate = { sku };

  const name = (product.name ?? "").trim();
  if (name !== "") {
    update.name = name;
  }

  const description = (product.description ?? "").trim();
  if (description !== "") {
    update.description = product.description;
  }

  const shortDescription = (product.short_description ?? "").trim();
  if (shortDescription !== "") {
    update.short_description = product.short_description;
  }

  /*
   * Prices.
   *
   * `regular_price` and `sale_price` are the inputs; the plugin derives the
   * displayed `_price` from whichever of them ends up on the product. `price` is
   * sent only when there is no `regular_price` to send, matching the alias
   * relationship the import path already has — sending both would be two ways to
   * set one value.
   *
   * `sale_price` is only ever sent when the row HAS one. A row with no sale price
   * must not end a sale that is running on the site: the file is silent about the
   * sale, and silence is not an instruction.
   */
  const regular = money(product.regular_price);
  const price = money(product.price);
  const sale = money(product.sale_price);

  if (regular !== null) {
    update.regular_price = regular;
  } else if (price !== null) {
    update.price = price;
  }

  if (sale !== null) {
    update.sale_price = sale;
  }

  // A real quantity, including 0 — which is meaningful, and which the plugin turns
  // into `outofstock` because nothing else would. `null` is the CSV reader saying
  // the file has no stock column, and that is not a quantity.
  if (typeof product.stock === "number" && Number.isFinite(product.stock)) {
    update.stock = product.stock;
  }

  /*
   * `instock` is deliberately NEVER sent from a file.
   *
   * The CSV readers default it to `true` when the file has no stock column
   * (`instock: value(row, "In stock?") !== "0"` and friends), so a file that says
   * nothing about availability is indistinguishable from a file that says "in
   * stock". Sending it would put an entire out-of-stock catalogue back on sale on
   * the strength of a column that was never there.
   *
   * Nothing is lost that matters: a shop syncing availability syncs quantities,
   * and the plugin derives `outofstock` from a quantity of 0 on its own.
   */

  if ((product.categories ?? []).length > 0) {
    update.categories = product.categories;
  }

  if ((product.tags ?? []).length > 0) {
    update.tags = product.tags;
  }

  const shippingClass = (product.shipping_class ?? "").trim();
  if (shippingClass !== "") {
    update.shipping_class = shippingClass;
  }

  return update;
}

function money(value: number | string | undefined): number | string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const trimmed = value.trim();

  // "null" is the plugin's own long-standing convention for "no price" and reaches
  // this point through the import pipeline. It means absent, not zero.
  if (trimmed === "" || trimmed === "null") {
    return null;
  }

  return trimmed;
}

/** Field names in the order they read best on screen. */
const FIELD_ORDER: ReadonlyArray<keyof ProductUpdate> = [
  "name",
  "regular_price",
  "price",
  "sale_price",
  "stock",
  "description",
  "short_description",
  "categories",
  "tags",
  "shipping_class",
];

export const UPDATE_FIELD_LABELS: Partial<Record<keyof ProductUpdate, string>> = {
  name: "Name",
  regular_price: "Regular price",
  price: "Price",
  sale_price: "Sale price",
  stock: "Stock",
  description: "Description",
  short_description: "Short description",
  categories: "Categories",
  tags: "Tags",
  shipping_class: "Shipping class",
};

/**
 * Fields NEVER written by a file-driven update, with the reason.
 *
 * On screen rather than only in this comment: "it updates the products" is not a
 * sentence anybody can check, and an operator who believes a re-sync replaces
 * images will find out from a customer.
 */
export const UPDATE_NEVER_WRITES: ReadonlyArray<{ field: string; why: string }> = [
  {
    field: "Slug and URL",
    why: "The slug is generated per read, with a random suffix, so sending it would rewrite every product's URL.",
  },
  {
    field: "Images",
    why: "Replacing a gallery creates and deletes attachments, which changes image ids and removes files.",
  },
  {
    field: "Variations",
    why: "Rebuilding the variation set changes variation ids. A variation is updated by its own SKU instead.",
  },
  {
    field: "Attributes",
    why: "Rewriting attributes rebuilds the variation set.",
  },
  {
    field: "Anything the row leaves empty",
    why: "A blank cell is the file being silent, not an instruction to clear the field. Clear a field by editing the one product.",
  },
];

export interface UpdatePlan {
  /** Rows that can be matched, with only the fields they actually write. */
  updates: ProductUpdate[];
  /** Rows with no SKU. Nothing can match them, so an update cannot cover them. */
  withoutSku: number;
  /** Which fields this file would write at all, most common first. */
  fields: Array<{ field: keyof ProductUpdate; label: string; rows: number }>;
}

/**
 * What a re-sync of this file WOULD write, worked out before anything is sent.
 *
 * The per-field row counts are the useful part. "This file updates 1,240 products"
 * is not checkable; "1,240 rows write a regular price and 3 write a description"
 * immediately shows an operator whether the file is the price list they think it is
 * or a half-empty export that would also touch descriptions.
 */
export function planUpdate(products: ReadonlyArray<Product>): UpdatePlan {
  const updates: ProductUpdate[] = [];
  let withoutSku = 0;

  const counts = new Map<keyof ProductUpdate, number>();

  for (const product of products) {
    const update = toProductUpdate(product);

    if (update === null) {
      withoutSku++;
      continue;
    }

    updates.push(update);

    for (const field of FIELD_ORDER) {
      if (update[field] !== undefined) {
        counts.set(field, (counts.get(field) ?? 0) + 1);
      }
    }
  }

  const fields = FIELD_ORDER.filter((field) => (counts.get(field) ?? 0) > 0).map((field) => ({
    field,
    label: UPDATE_FIELD_LABELS[field] ?? String(field),
    rows: counts.get(field) ?? 0,
  }));

  return { updates, withoutSku, fields };
}
