"use client";

import { useMemo, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Drawer,
  Field,
  Input,
  Select,
  TagInput,
  useToast,
} from "@/components/ui";
import { formatMoney } from "@/lib/format";
import type { ProductSummary } from "@/lib/gop-client";

/**
 * Editing ONE product.
 *
 * Level 1 of the three confirmation levels: the whole change is on screen, every old
 * value sits beside its new one, and there is nothing to type. One product takes one
 * request, so this saves synchronously rather than creating a run — a run exists to
 * give progress, a log and Cancel to work that takes minutes, and putting a single
 * price correction on the Activity screen between two 14,000-product imports would be
 * ceremony rather than safety.
 *
 * The rule that makes it safe is the same one the whole feature rests on: only fields
 * the operator actually TOUCHED are sent. A field left alone is absent from the
 * request, so it is not written — as opposed to being sent as its current value,
 * which would look identical here and would overwrite anything changed on the site in
 * between.
 */

/** A value the operator typed, or `undefined` for "not touched". */
type Draft = {
  name?: string;
  status?: string;
  regularPrice?: string;
  salePrice?: string;
  stock?: string;
  categories?: string[];
};

const STATUSES = ["publish", "draft", "pending", "private"] as const;

export function EditDrawer({
  product,
  storeId,
  currency,
  onClose,
  onSaved,
}: {
  product: ProductSummary | null;
  storeId: string;
  currency: string;
  onClose: () => void;
  /** Hands back the fields that actually moved, so the row can be refreshed. */
  onSaved: (productId: number, changed: Record<string, { from: unknown; to: unknown }>) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keyed on the product so opening a different row starts from a clean draft
  // rather than carrying the previous product's edits into it.
  const key = product?.product_id ?? 0;

  const current = useMemo(
    () => ({
      name: product?.name ?? "",
      status: product?.status ?? "publish",
      regularPrice: product?.regular_price ?? "",
      salePrice: product?.sale_price ?? "",
      stock: product?.stock ?? "",
      categories: product?.categories ?? [],
    }),
    [product],
  );

  function set<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setError(null);
  }

  /**
   * Which fields the operator actually changed.
   *
   * Compared against the CURRENT value rather than merely "was it typed in": typing
   * a value and then typing the original back is not a change, and sending it would
   * put a pointless write on the site and a misleading row in the results.
   */
  const touched = useMemo(() => {
    const out: Array<{ field: keyof Draft; label: string; from: string; to: string }> = [];

    const compare = (field: keyof Draft, label: string, from: string, to: string | undefined) => {
      if (to !== undefined && to !== from) {
        out.push({ field, label, from, to });
      }
    };

    compare("name", "Name", current.name, draft.name?.trim());
    compare("status", "Status", current.status, draft.status);
    compare("regularPrice", "Regular price", current.regularPrice, draft.regularPrice?.trim());
    compare("salePrice", "Sale price", current.salePrice, draft.salePrice?.trim());
    compare("stock", "Stock", current.stock, draft.stock?.trim());

    if (draft.categories !== undefined) {
      const before = [...current.categories].sort().join(", ");
      const after = [...draft.categories].sort().join(", ");
      if (before !== after) {
        out.push({
          field: "categories",
          label: "Categories",
          from: current.categories.join(", ") || "(none)",
          to: draft.categories.join(", ") || "(none)",
        });
      }
    }

    return out;
  }, [draft, current]);

  async function save() {
    if (product === null || touched.length === 0) {
      return;
    }

    setSaving(true);
    setError(null);

    /*
     * ONLY the touched fields. Built key by key rather than spread from the draft,
     * because a spread would carry every key the draft ever held — including ones
     * the operator typed into and then reverted.
     */
    const body: Record<string, unknown> = { storeId, productId: product.product_id };

    for (const entry of touched) {
      switch (entry.field) {
        case "name":
          body.name = entry.to;
          break;
        case "status":
          body.status = entry.to;
          break;
        case "regularPrice":
          body.regularPrice = entry.to;
          break;
        case "salePrice":
          body.salePrice = entry.to;
          break;
        case "stock":
          body.stock = entry.to;
          break;
        case "categories":
          body.categories = draft.categories;
          break;
      }
    }

    try {
      const response = await fetch("/api/products/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as {
        ok?: boolean;
        changed?: Record<string, { from: unknown; to: unknown }>;
        error?: string;
      };

      if (!response.ok || payload.ok !== true) {
        setError(payload.error ?? "Could not save.");
        return;
      }

      const changed = payload.changed ?? {};
      const moved = Object.keys(changed).length;

      // "Saved" and "saved and nothing was different" are not the same thing, and a
      // toast that says the first when the second happened is how somebody concludes
      // the tool does nothing.
      toast.success(
        moved === 0 ? "Nothing to change" : `Saved — ${moved} field(s) changed`,
        moved === 0
          ? "The product was already exactly as asked, so nothing was written."
          : Object.keys(changed).join(", "),
      );

      onSaved(product.product_id, changed);
      setDraft({});
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      key={key}
      open={product !== null}
      onClose={() => {
        setDraft({});
        setError(null);
        onClose();
      }}
      title={product?.name ?? "Product"}
      description={
        product === null ? undefined : (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-2xs">{product.sku || "no SKU"}</span>
            <Badge tone="neutral">{product.type}</Badge>
            {product.variation_count > 0 ? (
              <Badge tone="info">{product.variation_count} variations</Badge>
            ) : null}
          </span>
        )
      }
      width="md"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-subtle">
            {touched.length === 0
              ? "Nothing changed yet. Only the fields you edit are written."
              : `${touched.length} field(s) will be written. Everything else is left exactly as it is.`}
          </p>
          <Button
            variant="primary"
            icon="check"
            loading={saving}
            disabled={touched.length === 0}
            onClick={() => void save()}
          >
            Save {touched.length > 0 ? `${touched.length} change(s)` : ""}
          </Button>
        </div>
      }
    >
      {product === null ? null : (
        <div className="space-y-5">
          {error ? (
            <Alert tone="bad" title="Could not save">
              {error}
            </Alert>
          ) : null}

          {product.variation_count > 0 ? (
            <Alert tone="info" title="This is a variable product">
              Changing the price here changes the PARENT&rsquo;s price. Each variation has its own
              price and its own SKU, and is edited through its own SKU — the variation set itself is
              never rebuilt, because that would change variation ids.
            </Alert>
          ) : null}

          <Field label="Name" htmlFor="editName">
            <Input
              id="editName"
              value={draft.name ?? current.name}
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Regular price"
              htmlFor="editRegular"
              hint="Empty clears it. The displayed price follows: it is the sale price while a sale runs, otherwise this."
            >
              <Input
                id="editRegular"
                inputMode="decimal"
                value={draft.regularPrice ?? current.regularPrice}
                onChange={(event) => set("regularPrice", event.target.value)}
              />
            </Field>

            <Field
              label="Sale price"
              htmlFor="editSale"
              hint="Empty ENDS the sale, and the displayed price goes back to the regular price."
            >
              <Input
                id="editSale"
                inputMode="decimal"
                value={draft.salePrice ?? current.salePrice}
                onChange={(event) => set("salePrice", event.target.value)}
              />
            </Field>

            <Field
              label="Stock"
              htmlFor="editStock"
              hint="A number, or empty to stop managing stock — which is not the same as a quantity of 0. A quantity of 0 marks it out of stock."
            >
              <Input
                id="editStock"
                inputMode="numeric"
                value={draft.stock ?? current.stock}
                onChange={(event) => set("stock", event.target.value)}
              />
            </Field>

            <Field label="Status" htmlFor="editStatus">
              <Select
                id="editStatus"
                value={draft.status ?? current.status}
                onChange={(event) => set("status", event.target.value)}
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
                {/* A status the site already holds but this screen does not offer —
                    `future`, say — must stay selectable, or opening the drawer and
                    saving would quietly move it to `publish`. */}
                {(STATUSES as ReadonlyArray<string>).includes(current.status) ? null : (
                  <option value={current.status}>{current.status}</option>
                )}
              </Select>
            </Field>
          </div>

          <Field
            label="Categories"
            hint="Replaces the whole set. Names are matched on the site, and one that does not exist is created — so a wrong capital letter makes a second category."
          >
            <TagInput
              values={draft.categories ?? current.categories}
              suggestions={[]}
              onChange={(next) => set("categories", next)}
              placeholder="Add a category…"
            />
          </Field>

          {/* ------------------------------------------------- old beside new */}
          {touched.length > 0 ? (
            <div className="rounded-md border border-line bg-surface-sunken p-4">
              <p className="mb-3 text-xs font-medium text-ink">What will be written</p>
              <ul className="space-y-2">
                {touched.map((entry) => (
                  <li key={entry.field} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <span className="min-w-28 text-ink-subtle">{entry.label}</span>
                    <span className="tnum text-ink-muted line-through">
                      {display(entry.field, entry.from, currency)}
                    </span>
                    <span className="text-ink-subtle">→</span>
                    <span className="tnum font-medium text-ink">
                      {display(entry.field, entry.to, currency)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-2xs text-ink-subtle">
                Nothing else is touched — not the images, not the slug or URL, not the variations,
                not the attributes.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

/** Money through `formatMoney`; an empty value named rather than left blank. */
function display(field: keyof Draft, value: string, currency: string): string {
  if (value === "") {
    return "(empty)";
  }

  if (field === "regularPrice" || field === "salePrice") {
    return formatMoney(value, currency);
  }

  return value;
}
