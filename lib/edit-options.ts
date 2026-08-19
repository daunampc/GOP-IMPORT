import { z } from "zod";

import { MAX_UPDATE_BATCH } from "./gop-client";

/**
 * Options and arithmetic for a BULK EDIT run.
 *
 * A separate shape from `ImportOptions` and `PurgeOptions` for the same reason
 * those two are separate from each other: almost nothing an import cares about —
 * encoding, slug suffixes, image handling, variant flattening — means anything
 * when the work is "change the price of 3,000 products that already exist", and a
 * shared type would have claimed otherwise on every screen that reads it.
 *
 * Everything in this file is PURE. It is imported by the product screen in the
 * browser as well as by the route handler and the worker, so it must not touch the
 * database, bullmq or ioredis — see the note at the bottom of
 * `lib/purge-options.ts` for what that costs when it goes wrong.
 */

/* ------------------------------------------------------------- the operation */

export const PRICE_OPERATIONS = ["percent", "amount", "fixed"] as const;
export type PriceOperation = (typeof PRICE_OPERATIONS)[number];

export const PRICE_OPERATION_LABELS: Record<PriceOperation, string> = {
  percent: "By a percentage",
  amount: "By a fixed amount",
  fixed: "To one fixed price",
};

export const PRICE_OPERATION_HINTS: Record<PriceOperation, string> = {
  percent: "−10 takes 10% off every price. Each product ends up at a different number.",
  amount: "−10000 takes 10,000 off every price. Each product ends up at a different number.",
  fixed: "Every selected product ends up at exactly this price.",
};

/** Which price a change applies to. */
export const PRICE_TARGETS = ["regular_price", "sale_price"] as const;
export type PriceTarget = (typeof PRICE_TARGETS)[number];

export const PRICE_TARGET_LABELS: Record<PriceTarget, string> = {
  regular_price: "Regular price",
  sale_price: "Sale price",
};

/**
 * The four things a bulk edit can do.
 *
 * Deliberately NOT one object with every field optional. A discriminated union
 * means "change the price" and "change the status" cannot be half-specified
 * together, and it means the screen, the route and the worker all narrow on the
 * same tag rather than each inventing its own idea of which fields matter.
 */
export const editOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("price"),
    target: z.enum(PRICE_TARGETS).default("regular_price"),
    operation: z.enum(PRICE_OPERATIONS),
    /** A percentage, an amount, or the fixed price — read according to `operation`. */
    value: z.coerce.number().finite(),
    /**
     * Round the result to this many decimals. 0 for a currency with no minor unit,
     * which is the common case here (VND).
     */
    decimals: z.coerce.number().int().min(0).max(4).default(0),
  }),
  z.object({
    kind: z.literal("clear_sale"),
  }),
  z.object({
    kind: z.literal("stock"),
    /** A quantity, or `""` to stop managing stock — which is not a quantity of zero. */
    value: z.union([z.coerce.number().int().min(0), z.literal("")]),
  }),
  z.object({
    kind: z.literal("status"),
    value: z.enum(["publish", "draft", "pending", "private"]),
  }),
]);

export type EditOperation = z.infer<typeof editOperationSchema>;

export const editOptionsSchema = z.object({
  storeId: z.string().min(1, "Pick a site first"),
  operation: editOperationSchema,

  threads: z.coerce.number().int().min(1).max(32).default(4),
  batchSize: z.coerce.number().int().min(1).max(MAX_UPDATE_BATCH).default(MAX_UPDATE_BATCH),

  /**
   * Display currency, copied from the account at the moment the run was reviewed.
   *
   * On the run for the same reason the import carries it: the results table read
   * next week has to show the same symbol the operator was looking at when they
   * pressed the button. Display only — it changes nothing on any site.
   */
  displayCurrency: z.string().trim().default(""),
});

export type EditOptions = z.infer<typeof editOptionsSchema>;

/* --------------------------------------------------------------- the payload */

/**
 * One product in a bulk edit — RESOLVED, not a rule to re-evaluate.
 *
 * This is the same property the removal screen is built on, applied here: **a
 * filter is never what executes.** The filter produces a list, the operator reads
 * the list with its real numbers, and the run is built from that list. So each row
 * carries the ABSOLUTE value to write, worked out at preview time, plus what the
 * product was at that moment.
 *
 * Three consequences, and all three are the point:
 *
 *  - a product whose price somebody else changes between looking and pressing is
 *    not silently swept along at a number nobody reviewed;
 *  - a product that joins the filter in that window is not taken along at all;
 *  - the payload IS the audit list — what the operator confirmed is literally what
 *    the worker sends.
 */
export interface EditItem {
  /**
   * The match key, and the reason the plugin gained one.
   *
   * A product with no SKU cannot be addressed by SKU, and two products sharing one
   * are refused rather than guessed at. This screen has listed products by id, so
   * it uses ids.
   */
  product_id: number;
  sku: string;
  name: string;
  /** Absolute values to write. Only the keys this operation touches are present. */
  set: {
    regular_price?: string;
    sale_price?: string;
    stock?: number | "";
    status?: "publish" | "draft" | "pending" | "private";
  };
  /** What it was when the operator looked. Carried so the results can quote it. */
  was: {
    price: string;
    regular_price: string;
    sale_price: string;
    status: string;
    stock: string;
  };
}

/* ------------------------------------------------------------- the arithmetic */

/** The current state of one product, as the lookup reports it. */
export interface PricedProduct {
  product_id: number;
  sku: string;
  name: string;
  status: string;
  /** The DISPLAYED price — the sale price while a sale runs. */
  price: string;
  regular_price?: string;
  sale_price?: string;
  stock?: string;
}

export type ResolveOutcome =
  | { ok: true; item: EditItem }
  /**
   * Refused, with the reason. NOT clamped, and not dropped silently.
   *
   * "Refuse, never silently trim" — a percentage that would take a price to zero
   * or below is a mistake in the percentage, not an instruction to give the product
   * away, and quietly clamping it to 0 would report success on a catalogue priced
   * at nothing.
   */
  | { ok: false; product: PricedProduct; reason: string };

/**
 * Work out what one product would become. Pure, and shared by the preview, the
 * confirmation and the run — so the number on screen is the number that gets sent.
 */
export function resolveEdit(
  product: PricedProduct,
  operation: EditOperation,
): ResolveOutcome {
  const was = {
    price: product.price ?? "",
    regular_price: product.regular_price ?? "",
    sale_price: product.sale_price ?? "",
    status: product.status ?? "",
    stock: product.stock ?? "",
  };

  const base = { product_id: product.product_id, sku: product.sku, name: product.name, was };

  switch (operation.kind) {
    case "price": {
      const current =
        operation.target === "sale_price"
          ? (product.sale_price ?? "")
          : (product.regular_price ?? product.price ?? "");

      if (operation.operation !== "fixed" && current.trim() === "") {
        return {
          ok: false,
          product,
          reason:
            operation.target === "sale_price"
              ? "It has no sale price, so there is nothing to change by a percentage or an amount."
              : "It has no regular price, so there is nothing to change by a percentage or an amount.",
        };
      }

      const from = operation.operation === "fixed" ? 0 : Number.parseFloat(current);

      if (operation.operation !== "fixed" && !Number.isFinite(from)) {
        return {
          ok: false,
          product,
          reason: `Its current price (${current}) is not a number this can do arithmetic on.`,
        };
      }

      const raw =
        operation.operation === "percent"
          ? from * (1 + operation.value / 100)
          : operation.operation === "amount"
            ? from + operation.value
            : operation.value;

      const next = round(raw, operation.decimals);

      // Refused, with the number named, rather than clamped to zero.
      if (!Number.isFinite(next) || next <= 0) {
        return {
          ok: false,
          product,
          reason: `It would end up at ${next} — at or below zero. Nothing was changed.`,
        };
      }

      return {
        ok: true,
        item: { ...base, set: { [operation.target]: String(next) } },
      };
    }

    case "clear_sale": {
      if ((product.sale_price ?? "").trim() === "") {
        return { ok: false, product, reason: "It is not on sale, so there is nothing to end." };
      }

      // `""` is what ends a sale. The plugin puts the displayed price back to the
      // regular price already on the product.
      return { ok: true, item: { ...base, set: { sale_price: "" } } };
    }

    case "stock":
      return { ok: true, item: { ...base, set: { stock: operation.value } } };

    case "status": {
      if (product.status === operation.value) {
        return { ok: false, product, reason: `It is already ${operation.value}.` };
      }

      return { ok: true, item: { ...base, set: { status: operation.value } } };
    }
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/* ------------------------------------------------------- describing and gating */

/** One line naming what a run did, kept on the run for its whole life. */
export function describeEdit(operation: EditOperation): string {
  switch (operation.kind) {
    case "price": {
      const target = PRICE_TARGET_LABELS[operation.target].toLowerCase();

      if (operation.operation === "percent") {
        const sign = operation.value >= 0 ? "+" : "";
        return `Change ${target} by ${sign}${operation.value}%`;
      }
      if (operation.operation === "amount") {
        const sign = operation.value >= 0 ? "+" : "";
        return `Change ${target} by ${sign}${operation.value}`;
      }
      return `Set ${target} to ${operation.value}`;
    }
    case "clear_sale":
      return "End the sale";
    case "stock":
      return operation.value === "" ? "Stop managing stock" : `Set stock to ${operation.value}`;
    case "status":
      return `Set status to ${operation.value}`;
  }
}

/**
 * A change whose effect DIFFERS per row.
 *
 * The distinction that decides whether a typed confirmation is required. A fixed
 * price can be checked by reading one example — every row ends at the same number.
 * A percentage cannot: each row ends somewhere different, so reading one row proves
 * nothing about the other 3,339, and a percentage applied to the wrong filter is
 * precisely how a whole catalogue gets mispriced.
 */
export function isRelative(operation: EditOperation): boolean {
  return operation.kind === "price" && operation.operation !== "fixed";
}

/**
 * Above this many products, the preview can no longer show every row it is about to
 * change, so a typed confirmation is required.
 *
 * Twenty rather than the removal screen's 500 because the two are different acts of
 * reading. Auditing 500 product NAMES is plausible — you are checking a list.
 * Auditing 500 arithmetic RESULTS is not. Twenty is enough to catch the two
 * mistakes that actually happen: a wrong filter shows up as unfamiliar names in the
 * first rows, and a wrong operation shows up in the first row.
 */
export const TYPED_CONFIRMATION_ABOVE = 20;

/** Rows shown in full in the preview. Deliberately the same number. */
export const PREVIEW_EXAMPLES = TYPED_CONFIRMATION_ABOVE;

/** The phrase an operator types before a bulk edit that cannot be read row by row. */
export const EDIT_CONFIRM_PHRASE = "UPDATE";

/**
 * Does this run need the phrase typed?
 *
 * Two clauses, both sayable in one sentence on screen:
 *
 *  1. more products than the preview can show in full — the operator cannot have
 *     read every row it is about to change;
 *  2. any RELATIVE change, however small — twelve products at −90% is still a
 *     mispriced catalogue, just a smaller one.
 */
export function needsTypedConfirmation(
  operation: EditOperation,
  count: number,
): boolean {
  return count > TYPED_CONFIRMATION_ABOVE || isRelative(operation);
}

/** Why it is being asked for, in the operator's words rather than a rule number. */
export function typedConfirmationReason(
  operation: EditOperation,
  count: number,
): string {
  const tooMany = count > TYPED_CONFIRMATION_ABOVE;
  const relative = isRelative(operation);

  if (tooMany && relative) {
    return (
      `This changes ${count.toLocaleString("en-GB")} products, more than the ${TYPED_CONFIRMATION_ABOVE} ` +
      `shown below, and each one ends up at a different number because the change is relative.`
    );
  }

  if (relative) {
    return (
      "The change is relative, so every product ends up at a different number — reading one row " +
      "proves nothing about the others."
    );
  }

  return (
    `This changes ${count.toLocaleString("en-GB")} products, more than the ${TYPED_CONFIRMATION_ABOVE} ` +
    `shown below, so not every row it touches is on screen.`
  );
}

/**
 * What a bulk edit cannot promise, said on the confirmation.
 *
 * The same discipline as `STOP_WARNING`: the sentence that is easy to leave off is
 * the one somebody needs a week later. A removal that is cancelled halfway leaves
 * the un-deleted products alone, which is a comfortable thing to say. A price
 * change that is cancelled halfway leaves the already-changed products **changed**,
 * and Cancel does not put them back.
 */
export const EDIT_CANCEL_WARNING =
  "If this run is cancelled or stopped halfway, the products it has already changed stay " +
  "changed. Cancel stops the run; it does not put the old values back. What each row was is " +
  "recorded in the run's results, which is the only record of it — the site has overwritten it.";
