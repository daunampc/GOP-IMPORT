"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useJobs } from "@/components/shell/jobs-provider";
import {
  Alert,
  Badge,
  Button,
  Code,
  DataTable,
  Field,
  Input,
  Panel,
  RadioGroup,
  Select,
  Stat,
  useToast,
  type Column,
} from "@/components/ui";
import {
  EDIT_CANCEL_WARNING,
  EDIT_CONFIRM_PHRASE,
  PRICE_OPERATIONS,
  PRICE_OPERATION_HINTS,
  PRICE_OPERATION_LABELS,
  PRICE_TARGETS,
  PRICE_TARGET_LABELS,
  isRelative,
  typedConfirmationReason,
  type EditItem,
  type EditOperation,
  type PriceOperation,
  type PriceTarget,
} from "@/lib/edit-options";
import { formatMoney, formatNumber } from "@/lib/format";
import type { JobState } from "@/lib/jobs";

/**
 * Changing many products at once — the dangerous half of this screen.
 *
 * Three properties, and none of them is decoration.
 *
 * **A filter is never what executes.** The preview resolves the selection into a
 * list of absolute per-product values; the operator reads those values; the run is
 * built from that list. So a product somebody else reprices between looking and
 * pressing is not swept along at a number nobody reviewed, and one that joins the
 * filter in that window is not taken at all.
 *
 * **The confirmation shows the numbers, not the count.** "340 products" cannot catch
 * a percentage typed with the decimal point in the wrong place; "199,000 → 219,000"
 * against a product name you recognise can. So the first twenty rows are shown in
 * full, and the figures beside them — the lowest and highest resulting price — are
 * computed over the WHOLE selection rather than over the twenty on screen. A summary
 * of the visible rows presented as a summary of 3,340 would be a lie in the one place
 * it matters most.
 *
 * **It runs as a run.** Queue, worker, log, Cancel, Stop, per-row results. A price
 * change across 3,000 products has exactly the same needs as an import of 3,000, and
 * a loop inside a route handler would mean no progress, no log, no way to stop it and
 * a browser tab that has to stay open.
 */

interface Preview {
  description: string;
  selected: number;
  changing: number;
  refused: Array<{ productId: number; name: string; sku: string; reason: string }>;
  vanished: number[];
  lowest: number | null;
  highest: number | null;
  saleAboveRegular: number;
  needsConfirmation: boolean;
  confirmPhrase: string;
  examples: EditItem[];
  exampleLimit: number;
}

type Kind = "price" | "clear_sale" | "stock" | "status";

const KIND_LABELS: Record<Kind, string> = {
  price: "Change a price",
  clear_sale: "End the sale",
  stock: "Set the stock",
  status: "Set the status",
};

export function BulkPanel({
  storeId,
  storeLabel,
  productIds,
  currency,
  onDone,
}: {
  storeId: string;
  storeLabel: string;
  /** Exactly what the operator selected — ticked rows, or a whole resolved filter. */
  productIds: number[];
  currency: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const { refresh } = useJobs();

  const [kind, setKind] = useState<Kind>("price");
  const [target, setTarget] = useState<PriceTarget>("regular_price");
  const [operation, setOperation] = useState<PriceOperation>("percent");
  const [value, setValue] = useState("");
  const [stockValue, setStockValue] = useState("");
  const [statusValue, setStatusValue] = useState<"publish" | "draft" | "pending" | "private">(
    "draft",
  );

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState("");
  const [starting, setStarting] = useState(false);

  /** The operation as the server will read it, or null when it is not complete. */
  function buildOperation(): EditOperation | null {
    switch (kind) {
      case "price": {
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed)) {
          return null;
        }
        return { kind: "price", target, operation, value: parsed, decimals: 0 };
      }
      case "clear_sale":
        return { kind: "clear_sale" };
      case "stock":
        return {
          kind: "stock",
          value: stockValue.trim() === "" ? "" : Number.parseInt(stockValue, 10),
        };
      case "status":
        return { kind: "status", value: statusValue };
    }
  }

  const built = buildOperation();

  /** Anything that changes what would be written invalidates the preview shown. */
  function invalidate() {
    setPreview(null);
    setPhrase("");
    setError(null);
  }

  async function runPreview() {
    if (built === null) {
      return;
    }

    setPreviewing(true);
    setError(null);

    try {
      const response = await fetch("/api/products/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview",
          storeId,
          selection: { productIds },
          operation: built,
        }),
      });

      const payload = (await response.json()) as Partial<Preview> & { error?: string };

      if (!response.ok || payload.changing === undefined) {
        setError(payload.error ?? "Could not work out what this would change.");
        return;
      }

      setPreview(payload as Preview);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPreviewing(false);
    }
  }

  async function start() {
    if (built === null || preview === null) {
      return;
    }

    setStarting(true);
    setError(null);

    try {
      const response = await fetch("/api/products/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run",
          storeId,
          selection: { productIds },
          operation: built,
          confirmPhrase: phrase,
        }),
      });

      const payload = (await response.json()) as { job?: JobState; error?: string };

      if (!response.ok || !payload.job) {
        setError(payload.error ?? "Could not start the run.");
        return;
      }

      await refresh();
      toast.success(
        `Queued a change to ${formatNumber(preview.changing)} product(s)`,
        "Close the tab if you like — the worker carries on without it.",
      );
      onDone();
      router.push(`/process/${payload.job.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  }

  const confirmed =
    preview === null || !preview.needsConfirmation || phrase.trim() === EDIT_CONFIRM_PHRASE;

  const columns: Column<EditItem>[] = [
    {
      key: "name",
      header: "Product",
      cell: (item) => (
        <div className="min-w-0">
          <span className="block truncate text-sm text-ink">{item.name}</span>
          <span className="block truncate font-mono text-2xs text-ink-subtle">
            {item.sku || `#${item.product_id}`}
          </span>
        </div>
      ),
    },
    {
      key: "change",
      header: "Now → after",
      width: "18rem",
      cell: (item) => (
        <span className="flex flex-wrap items-baseline gap-1.5 text-xs">
          <span className="tnum text-ink-muted line-through">{sideBefore(item, currency)}</span>
          <span className="text-ink-subtle">→</span>
          <span className="tnum font-medium text-ink">{sideAfter(item, currency)}</span>
        </span>
      ),
    },
  ];

  return (
    <Panel
      title={`Change ${formatNumber(productIds.length)} selected product(s)`}
      icon="refresh"
      description={`On ${storeLabel}`}
      actions={
        <Button variant="ghost" size="sm" icon="x" onClick={onDone}>
          Cancel
        </Button>
      }
    >
      <div className="space-y-4">
        <RadioGroup
          legend="What to change"
          value={kind}
          onChange={(next) => {
            setKind(next);
            invalidate();
          }}
          options={(Object.keys(KIND_LABELS) as Kind[]).map((option) => ({
            value: option,
            label: KIND_LABELS[option],
            description:
              option === "clear_sale"
                ? "Removes the sale price, so the displayed price goes back to the regular price."
                : option === "status"
                  ? "Draft and private hide a product from the shop. There is no undo list."
                  : option === "stock"
                    ? "A quantity for every selected product, or empty to stop managing stock."
                    : "By a percentage, by a fixed amount, or to one fixed price.",
          }))}
        />

        {kind === "price" ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Which price" htmlFor="bulkTarget">
              <Select
                id="bulkTarget"
                value={target}
                onChange={(event) => {
                  setTarget(event.target.value as PriceTarget);
                  invalidate();
                }}
              >
                {PRICE_TARGETS.map((option) => (
                  <option key={option} value={option}>
                    {PRICE_TARGET_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="How" htmlFor="bulkOperation" hint={PRICE_OPERATION_HINTS[operation]}>
              <Select
                id="bulkOperation"
                value={operation}
                onChange={(event) => {
                  setOperation(event.target.value as PriceOperation);
                  invalidate();
                }}
              >
                {PRICE_OPERATIONS.map((option) => (
                  <option key={option} value={option}>
                    {PRICE_OPERATION_LABELS[option]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label={operation === "percent" ? "Percent" : operation === "amount" ? "Amount" : "Price"}
              htmlFor="bulkValue"
              hint={operation === "fixed" ? undefined : "Negative to reduce, e.g. −10"}
            >
              <Input
                id="bulkValue"
                inputMode="decimal"
                value={value}
                placeholder={operation === "percent" ? "-10" : operation === "amount" ? "-10000" : "199000"}
                onChange={(event) => {
                  setValue(event.target.value);
                  invalidate();
                }}
              />
            </Field>
          </div>
        ) : null}

        {kind === "stock" ? (
          <Field
            label="Stock"
            htmlFor="bulkStock"
            hint="Empty stops managing stock, which is NOT the same as a quantity of 0. A quantity of 0 marks the product out of stock."
          >
            <Input
              id="bulkStock"
              inputMode="numeric"
              value={stockValue}
              placeholder="0"
              onChange={(event) => {
                setStockValue(event.target.value);
                invalidate();
              }}
              className="max-w-40"
            />
          </Field>
        ) : null}

        {kind === "status" ? (
          <Field label="Status" htmlFor="bulkStatus">
            <Select
              id="bulkStatus"
              value={statusValue}
              onChange={(event) => {
                setStatusValue(event.target.value as typeof statusValue);
                invalidate();
              }}
              className="max-w-48"
            >
              {(["publish", "draft", "pending", "private"] as const).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {built !== null && isRelative(built) ? (
          <Alert tone="warn" title="A relative change ends every product at a different number">
            Reading one row proves nothing about the others, so this always asks for a typed
            confirmation — however few products are selected.
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="text-xs text-ink-subtle">
            Nothing is written at this step — this only works out what would change.
          </p>
          <Button
            variant="secondary"
            icon="search"
            loading={previewing}
            disabled={built === null}
            onClick={() => void runPreview()}
          >
            Show the numbers
          </Button>
        </div>

        {error ? (
          <Alert tone="bad" title="Could not continue">
            {error}
          </Alert>
        ) : null}

        {/* -------------------------------------------------------- the preview */}
        {preview !== null ? (
          <div className="space-y-4 border-t border-line pt-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Would change"
                value={formatNumber(preview.changing)}
                icon="refresh"
                tone={preview.changing > 0 ? "warn" : "neutral"}
                hint={`of ${formatNumber(preview.selected)} selected`}
              />
              <Stat
                label="Lowest result"
                value={preview.lowest === null ? "—" : formatMoney(preview.lowest, currency)}
                icon="arrow-down"
                hint="across the whole selection"
              />
              <Stat
                label="Highest result"
                value={preview.highest === null ? "—" : formatMoney(preview.highest, currency)}
                icon="arrow-up"
                hint="across the whole selection"
              />
            </div>

            {preview.changing === 0 ? (
              <Alert tone="info" title="Nothing would change">
                Every selected product was refused or is already as asked. The reasons are listed
                below.
              </Alert>
            ) : null}

            {preview.refused.length > 0 ? (
              <Alert
                tone="warn"
                title={`${formatNumber(preview.refused.length)} product(s) refused — not changed, and not trimmed to fit`}
              >
                <ul className="mt-1 space-y-1">
                  {preview.refused.slice(0, 10).map((entry) => (
                    <li key={entry.productId} className="text-2xs text-ink-muted">
                      <strong className="text-ink">{entry.sku || `#${entry.productId}`}</strong>{" "}
                      {entry.name} — {entry.reason}
                    </li>
                  ))}
                </ul>
                {preview.refused.length > 10 ? (
                  <p className="mt-1 text-2xs text-ink-subtle">
                    …and {formatNumber(preview.refused.length - 10)} more.
                  </p>
                ) : null}
                <p className="mt-2 text-2xs text-ink-subtle">
                  A price that would land at or below zero is refused rather than clamped: it means
                  the number is wrong, not that the product should be given away.
                </p>
              </Alert>
            ) : null}

            {preview.vanished.length > 0 ? (
              <Alert
                tone="warn"
                title={`${formatNumber(preview.vanished.length)} selected product(s) are no longer on the site`}
              >
                They were there when the list was loaded and are not there now. They are simply not
                part of this run.
              </Alert>
            ) : null}

            {preview.saleAboveRegular > 0 ? (
              <Alert
                tone="info"
                title={`${formatNumber(preview.saleAboveRegular)} product(s) would have a sale price at or above the regular price`}
              >
                WooCommerce allows it, so this is not refused — but such a &ldquo;sale&rdquo; shows no
                discount to a shopper.
              </Alert>
            ) : null}

            {preview.examples.length > 0 ? (
              <div>
                <p className="mb-2 text-xs text-ink-muted">
                  {preview.changing <= preview.exampleLimit
                    ? `All ${formatNumber(preview.changing)} row(s) that would change, with the real numbers.`
                    : `The first ${formatNumber(preview.examples.length)} of ${formatNumber(preview.changing)} rows. The figures above cover all of them, not just these.`}
                </p>
                <DataTable
                  rows={preview.examples}
                  columns={columns}
                  rowKey={(item) => String(item.product_id)}
                  caption="What this change would write"
                />
              </div>
            ) : null}

            {/* ----------------------------------------------- the confirmation */}
            {preview.changing > 0 ? (
              <div className="space-y-3 rounded-md border border-line bg-surface-sunken p-4">
                <p className="text-sm text-ink">
                  <strong>{preview.description}</strong> across{" "}
                  <strong>{formatNumber(preview.changing)}</strong> product(s) on{" "}
                  <Code>{storeLabel}</Code>.
                </p>

                <p className="text-xs text-ink-muted">
                  This writes only what is named above and touches nothing else — no description, no
                  image, no slug or URL, no attributes, no variation set.
                </p>

                <p className="text-xs text-ink-muted">{EDIT_CANCEL_WARNING}</p>

                {preview.needsConfirmation ? (
                  <Field
                    label={`Type ${EDIT_CONFIRM_PHRASE} to confirm`}
                    htmlFor="bulkPhrase"
                    hint={
                      built === null
                        ? undefined
                        : typedConfirmationReason(built, preview.changing) +
                          " Checked on the server too."
                    }
                  >
                    <Input
                      id="bulkPhrase"
                      value={phrase}
                      autoComplete="off"
                      placeholder={EDIT_CONFIRM_PHRASE}
                      onChange={(event) => setPhrase(event.target.value)}
                      className="max-w-48"
                    />
                  </Field>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="danger"
                    size="lg"
                    icon="refresh"
                    loading={starting}
                    disabled={!confirmed}
                    onClick={() => void start()}
                  >
                    Change {formatNumber(preview.changing)} product
                    {preview.changing === 1 ? "" : "s"}
                  </Button>
                  <Badge tone="neutral" icon="activity">
                    Runs as a run — progress, log, Cancel and Stop
                  </Badge>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/** The product's value before, for whichever field this operation writes. */
function sideBefore(item: EditItem, currency: string): string {
  if (item.set.regular_price !== undefined) {
    return item.was.regular_price === "" ? "(empty)" : formatMoney(item.was.regular_price, currency);
  }
  if (item.set.sale_price !== undefined) {
    return item.was.sale_price === "" ? "(no sale)" : formatMoney(item.was.sale_price, currency);
  }
  if (item.set.stock !== undefined) {
    return item.was.stock === "" ? "(not managed)" : item.was.stock;
  }
  if (item.set.status !== undefined) {
    return item.was.status;
  }
  return "—";
}

function sideAfter(item: EditItem, currency: string): string {
  if (item.set.regular_price !== undefined) {
    return item.set.regular_price === "" ? "(empty)" : formatMoney(item.set.regular_price, currency);
  }
  if (item.set.sale_price !== undefined) {
    return item.set.sale_price === "" ? "(no sale)" : formatMoney(item.set.sale_price, currency);
  }
  if (item.set.stock !== undefined) {
    return item.set.stock === "" ? "(not managed)" : String(item.set.stock);
  }
  if (item.set.status !== undefined) {
    return item.set.status;
  }
  return "—";
}
