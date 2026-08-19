import "server-only";

import { randomUUID } from "node:crypto";
import { eq, lt } from "drizzle-orm";

import { db } from "@/db";
import { previews } from "@/db/schema";

import type { ImportOptions } from "./import-options";
import type { CsvDialect } from "./sources/csv";
import type { Product } from "./gop-client";

/**
 * A staged run, held server-side between preview and start.
 *
 * The old flow read the file twice — once to preview, once to send — and two
 * reads can disagree: the random slug suffix alone differs. So what you saw was
 * not necessarily what got published.
 *
 * Here the file is built exactly once, the result is stored, and Start just
 * points at it. Three consequences:
 *  - what you previewed is literally what gets sent;
 *  - editing or dropping individual rows before running becomes possible;
 *  - pushing one batch to five sites is one file read, not five.
 */

const PREVIEW_TTL_MS = 60 * 60 * 1000;

/** Compact row for the table — enough to review, without shipping megabytes. */
export interface PreviewRow {
  index: number;
  name: string;
  slug: string;
  sku: string;
  /** True when the SKU was generated here rather than read from the source. */
  generatedSku: boolean;
  type: string;
  price: string;
  images: number;
  variations: number;
  categories: string[];
  tags: string[];
  /** Row-level warnings, e.g. missing name or duplicate SKU. */
  issues: string[];
}

export interface PreviewMeta {
  id: string;
  createdAt: string;
  sourceLabel: string;
  dialect: CsvDialect | null;
  columns: string[];
  /** Header-row signature, used to remember the column mapping. */
  signature: string | null;
  options: ImportOptions;
  total: number;
  /** Distinct image URLs that will have to be handled. */
  images: number;
  warnings: string[];
  errors: Array<{ row: number; message: string }>;
  skippedRows: number;
  /** SKUs appearing on more than one row — the direct cause of duplicates. */
  duplicateSkus: Array<{ sku: string; indexes: number[] }>;
  rows: PreviewRow[];
}

export async function savePreview(
  input: Omit<PreviewMeta, "id" | "createdAt">,
  products: Product[],
  createdBy: string,
): Promise<PreviewMeta> {
  const meta: PreviewMeta = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  await db.insert(previews).values({
    id: meta.id,
    createdBy,
    expiresAt: new Date(Date.now() + PREVIEW_TTL_MS),
    meta: meta as unknown as Record<string, unknown>,
    products,
  });

  // Opportunistic cleanup. A background job for a table that gains a handful of
  // rows an hour would be more machinery than the problem deserves.
  await db.delete(previews).where(lt(previews.expiresAt, new Date()));

  return meta;
}

export async function getPreview(id: string): Promise<PreviewMeta | null> {
  const [row] = await db.select().from(previews).where(eq(previews.id, id)).limit(1);

  if (!row || row.expiresAt.getTime() < Date.now()) {
    return null;
  }

  return row.meta as unknown as PreviewMeta;
}

export async function getPreviewProducts(id: string): Promise<Product[] | null> {
  const [row] = await db
    .select({ products: previews.products, expiresAt: previews.expiresAt })
    .from(previews)
    .where(eq(previews.id, id))
    .limit(1);

  if (!row || row.expiresAt.getTime() < Date.now()) {
    return null;
  }

  return row.products as Product[];
}

/** Fields that can be corrected in place before a run, safely. */
export interface RowEdit {
  name?: string;
  sku?: string;
  slug?: string;
  price?: string;
  regularPrice?: string;
  categories?: string[];
  tags?: string[];
}

export interface RowChanges {
  /** Original-array indexes of rows the operator removed. */
  dropped: number[];
  edits: Record<string, RowEdit>;
}

/**
 * Apply the operator's changes to the staged list.
 *
 * `idempotency_key` is left untouched: it was derived from the position in the
 * ORIGINAL array, so dropping row 3 does not change row 4's key. If keys
 * shifted with position, resending after removing a few rows would duplicate
 * everything that followed.
 */
export function applyRowChanges(products: Product[], changes: RowChanges): Product[] {
  const dropped = new Set(changes.dropped);

  return products
    .map((product, index) => {
      if (dropped.has(index)) {
        return null;
      }

      const edit = changes.edits[String(index)];
      if (!edit) {
        return product;
      }

      const next: Product = { ...product };

      if (edit.name !== undefined && edit.name.trim() !== "") {
        next.name = edit.name.trim();
      }
      if (edit.sku !== undefined) {
        next.sku = edit.sku.trim();
      }
      if (edit.slug !== undefined && edit.slug.trim() !== "") {
        next.slug = edit.slug.trim();
      }
      if (edit.price !== undefined) {
        next.price = edit.price.trim();
      }
      if (edit.regularPrice !== undefined) {
        next.regular_price = edit.regularPrice.trim();
      }
      if (edit.categories !== undefined) {
        next.categories = edit.categories;
      }
      if (edit.tags !== undefined) {
        next.tags = edit.tags;
      }

      return next;
    })
    .filter((product): product is Product => product !== null);
}

/**
 * Every image URL exactly once, variation images included.
 *
 * Distinct rather than per row, and that is what makes checking them affordable: a
 * file of 3,000 products sharing one size-chart image is ONE link, not 3,000 — the
 * same property that makes an S3 object key a hash of the URL.
 *
 * In file order, so a check that can only cover the first N covers the first N
 * somebody would recognise rather than an arbitrary N.
 */
export function distinctImageUrls(products: ReadonlyArray<Product>): string[] {
  const urls = new Set<string>();

  for (const product of products) {
    for (const url of product.images ?? []) {
      urls.add(url);
    }
    for (const variation of product.variations ?? []) {
      if (variation.image) {
        urls.add(variation.image);
      }
      for (const url of variation.images ?? []) {
        urls.add(url);
      }
    }
  }

  return [...urls];
}

/** How many distinct image URLs a file carries. */
export function countImages(products: ReadonlyArray<Product>): number {
  return distinctImageUrls(products).length;
}

/** SKUs that appear on more than one row — where duplicate products come from. */
export function findDuplicateSkus(
  products: ReadonlyArray<Product>,
): Array<{ sku: string; indexes: number[] }> {
  const seen = new Map<string, number[]>();

  products.forEach((product, index) => {
    const sku = product.sku?.trim();
    if (!sku) {
      return;
    }
    const bucket = seen.get(sku);
    if (bucket) {
      bucket.push(index);
    } else {
      seen.set(sku, [index]);
    }
  });

  return [...seen.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([sku, indexes]) => ({ sku, indexes }));
}

export function toRows(
  products: ReadonlyArray<Product>,
  duplicates: ReadonlyArray<{ sku: string; indexes: number[] }>,
  /** Parallel to `products`; marks the SKUs this run generated. */
  generatedSku: ReadonlyArray<boolean> = [],
): PreviewRow[] {
  const duplicateIndexes = new Map<number, string>();
  for (const entry of duplicates) {
    // The FIRST row keeps its place; only the later ones are flagged, matching
    // what the duplicate-SKU option drops.
    for (const index of entry.indexes.slice(1)) {
      duplicateIndexes.set(index, entry.sku);
    }
  }

  return products.map((product, index) => {
    const issues: string[] = [];

    if (!product.name || product.name.trim() === "") {
      issues.push("No product name — the plugin will reject this row");
    }
    if (!product.images || product.images.length === 0) {
      issues.push("No images");
    }
    const duplicate = duplicateIndexes.get(index);
    if (duplicate) {
      issues.push(`SKU "${duplicate}" also appears on an earlier row`);
    }
    if (
      product.type === "variable" &&
      (product.variations === undefined || product.variations.length === 0)
    ) {
      issues.push("Marked variable but has no variations");
    }
    if (
      (product.price === undefined || product.price === "") &&
      (product.variations?.length ?? 0) === 0
    ) {
      issues.push("No price");
    }

    return {
      index,
      name: product.name ?? "",
      slug: product.slug ?? "",
      sku: product.sku ?? "",
      generatedSku: generatedSku[index] ?? false,
      type: product.type ?? "simple",
      price: product.price === undefined ? "" : String(product.price),
      images: product.images?.length ?? 0,
      variations: product.variations?.length ?? 0,
      categories: product.categories ?? [],
      tags: product.tags ?? [],
      issues,
    };
  });
}
