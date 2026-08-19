import { createHash, randomBytes } from "node:crypto";

import type { ImportOptions } from "./import-options";
import type { Product } from "./gop-client";

/**
 * Apply the wizard's options to a list of products, before anything is sent to
 * the plugin.
 *
 * A pure function: same input, same output — except the random slug suffix,
 * which takes a parameter so tests can pin it. That is what lets the preview
 * screen run the exact same code path as the real import, so what you see is
 * what gets published.
 */

export interface TransformContext {
  /** Lets tests inject a fixed value instead of a random one. */
  randomSuffix?: () => string;
  /** Source file name, used as the seed for idempotency keys and SKUs. */
  sourceId: string;
}

function defaultRandomSuffix(): string {
  return randomBytes(3).toString("hex");
}

export function applyOptions(
  products: Product[],
  options: ImportOptions,
  context: TransformContext,
): Product[] {
  const randomSuffix = context.randomSuffix ?? defaultRandomSuffix;

  return products.map((input, index) => {
    let product: Product = { ...input };

    product = applyForcedTerms(product, options);
    product = applyAttributes(product, options);
    product = applyVariantHandling(product, options);
    // After variant handling: flattening can promote a variation's real SKU up
    // to the parent, and a real SKU always beats a generated one.
    product = applyAutoSku(product, options, context, index);
    product = applySlug(product, options, randomSuffix, context, index);
    product = applyMode(product, options);

    // The idempotency key has to be stable across resends of the SAME batch but
    // different between two different batches. Hashing source id + position +
    // sku/slug gets both: pressing Start twice on one file will not create a
    // second row.
    product.idempotency_key = createHash("sha256")
      .update(`${context.sourceId}|${index}|${product.sku ?? ""}|${product.slug ?? ""}`)
      .digest("hex")
      .slice(0, 40);

    return product;
  });
}

/** "Force category" / "Force tag" — replaces whatever the source said. */
function applyForcedTerms(product: Product, options: ImportOptions): Product {
  const next = { ...product };

  if (options.forceCategory !== "") {
    next.categories = splitList(options.forceCategory);
  }

  if (options.forceTag !== "") {
    next.tags = splitList(options.forceTag);
  }

  return next;
}

/**
 * "Keep product attributes" — unticked, attributes at PRODUCT level are dropped.
 *
 * Attributes ON A VARIATION are always kept: without them WooCommerce cannot
 * tell which variation matches which choice, and the variable product is broken.
 */
function applyAttributes(product: Product, options: ImportOptions): Product {
  if (options.keepProductAttributes) {
    return product;
  }
  return { ...product, attributes: [] };
}

/**
 * "Flatten variants into one product" and "Make the first variant default".
 *
 * Flattening takes the price of the CHEAPEST variation, not the first one —
 * that is the price a shopper sees on a category page for a variable product,
 * so flattening with any other price would silently change the listing.
 */
function applyVariantHandling(product: Product, options: ImportOptions): Product {
  const variations = product.variations ?? [];

  if (options.flattenVariants) {
    if (variations.length === 0) {
      return { ...product, type: "simple", variations: [] };
    }

    const cheapest = variations.reduce((lowest, variation) =>
      toNumber(variation.price) < toNumber(lowest.price) ? variation : lowest,
    );

    return {
      ...product,
      type: "simple",
      sku: product.sku || cheapest.sku,
      price: cheapest.price ?? product.price,
      regular_price: cheapest.regular_price ?? product.regular_price,
      // Fold the variation images into the product gallery, otherwise
      // flattening loses them entirely.
      images: mergeImages(product, variations),
      attributes: options.keepProductAttributes ? product.attributes : [],
      default_attributes: [],
      variations: [],
    };
  }

  if (options.firstVariantAsDefault && variations.length > 0) {
    const first = variations[0];
    return {
      ...product,
      default_attributes: first.attributes.map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
      })),
    };
  }

  return product;
}

/**
 * "Generate a SKU when the row has none".
 *
 * Deliberately free of randomness and of the clock. The same row of the same
 * file always produces the same SKU, so re-running a file does not create a
 * second product beside the first — which is exactly what a random suffix here
 * would do.
 */
function applyAutoSku(
  product: Product,
  options: ImportOptions,
  context: TransformContext,
  index: number,
): Product {
  if (!options.autoSku) {
    return product;
  }

  if ((product.sku ?? "").trim() !== "") {
    return product;
  }

  const sku = buildSku(options.autoSkuPattern, {
    sourceId: context.sourceId,
    index,
    name: product.name ?? "",
    slug: product.slug ?? "",
  });

  return sku === "" ? product : { ...product, sku };
}

export interface SkuSeed {
  sourceId: string;
  /** Position in the original array, zero-based. */
  index: number;
  name: string;
  slug: string;
}

/**
 * Expand a SKU pattern.
 *
 * `{hash}` is the part that makes a pattern safe to reuse: it is derived from
 * the file, the row's position and the row's own text, so two different files
 * never collide and the same file always repeats itself.
 */
export function buildSku(pattern: string, seed: SkuSeed): string {
  if (pattern.trim() === "") {
    return "";
  }

  const base = seed.slug !== "" ? seed.slug : slugify(seed.name);

  const hash = createHash("sha256")
    .update(`${seed.sourceId}|${seed.index}|${seed.name}|${seed.slug}`)
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();

  return pattern
    .replace(/\{seq\}/g, String(seed.index + 1).padStart(4, "0"))
    .replace(/\{hash\}/g, hash)
    .replace(/\{slug\}/g, base)
    .replace(/\{name\}/g, slugify(seed.name))
    .trim();
}

function mergeImages(
  product: Product,
  variations: NonNullable<Product["variations"]>,
): string[] {
  const images = [...(product.images ?? [])];

  for (const variation of variations) {
    if (variation.image) {
      images.push(variation.image);
    }
    if (variation.images) {
      images.push(...variation.images);
    }
  }

  return [...new Set(images)];
}

/**
 * Give every product a slug, and optionally a random suffix.
 *
 * The option controls the SUFFIX ONLY. It must never decide whether a slug
 * exists at all — that was a bug: the CSV reader never sets a slug, so with the
 * suffix turned off every product reached the plugin with no slug, was written
 * with an empty `post_name`, and ended up at `domain.com/product//`.
 *
 * The random suffix itself is still worth leaving on. The plugin writes
 * straight to the database and does NOT run `wp_unique_post_slug()`, so two
 * products sharing a slug both exist and one of them is unreachable.
 */
function applySlug(
  product: Product,
  options: ImportOptions,
  randomSuffix: () => string,
  context: TransformContext,
  index: number,
): Product {
  const base = slugBase(product, context, index);

  return {
    ...product,
    slug: options.addRandomSuffixToSlug ? `${base}-${randomSuffix()}` : base,
  };
}

/**
 * A non-empty slug, whatever the source gave us.
 *
 * Four steps down, because each one can legitimately come back empty:
 * a name written entirely in a non-Latin script slugifies to nothing, and a row
 * can arrive with neither name nor SKU. The last step is derived from the file
 * and the row's position, so it is stable across re-runs like everything else
 * here — a random fallback would create a second product every time.
 */
function slugBase(product: Product, context: TransformContext, index: number): string {
  const given = (product.slug ?? "").trim();
  if (given !== "") {
    return given;
  }

  const fromName = slugify(product.name ?? "");
  if (fromName !== "") {
    return fromName;
  }

  const fromSku = slugify(product.sku ?? "");
  if (fromSku !== "") {
    return fromSku;
  }

  return `product-${createHash("sha256")
    .update(`${context.sourceId}|${index}`)
    .digest("hex")
    .slice(0, 10)}`;
}

/**
 * "Import mode".
 *
 * Complete sets `mode_import: full_data` so the plugin fills in WooCommerce's
 * defaults (tax_status, backorders, manage_stock…). Lean drops it: less meta,
 * fewer INSERTs, and products missing those fields.
 */
function applyMode(product: Product, options: ImportOptions): Product {
  if (options.mode === "standard") {
    return { ...product, mode_import: "full_data" };
  }

  const { mode_import: _dropped, ...rest } = product;
  return rest;
}

function toNumber(value: number | string | undefined): number {
  if (value === undefined || value === "") {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function splitList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    ),
  ];
}

/** Client-side slug shortening; the plugin normalises it again on its side. */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}
