"use client";

import { useEffect, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  CodeBlock,
  DescriptionList,
  Drawer,
  ErrorState,
  Field,
  Input,
  Panel,
  Skeleton,
  TagInput,
  type ComboboxOption,
} from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/format";
import type { Product } from "@/lib/gop-client";
import type { PreviewRow, RowEdit } from "@/lib/preview";

/**
 * One preview row in detail, and the place to correct it.
 *
 * The full detail is fetched per row rather than shipped with the table: 5000
 * products with variations, attributes and meta is tens of megabytes, while the
 * drawer only ever shows one row at a time.
 *
 * Only the fields that can be corrected safely are editable. Editing variations
 * or attributes here would mean rebuilding a product editor — that belongs to
 * the source file, not to the last look before running.
 */
export function ProductDrawer({
  previewId,
  row,
  edit,
  onEditChange,
  onDrop,
  dropped,
  categoryOptions,
  tagOptions,
  onClose,
  currency,
}: {
  previewId: string;
  row: PreviewRow | null;
  edit: RowEdit | undefined;
  onEditChange: (index: number, edit: RowEdit | undefined) => void;
  onDrop: (index: number, dropped: boolean) => void;
  dropped: boolean;
  categoryOptions: ComboboxOption[];
  tagOptions: ComboboxOption[];
  onClose: () => void;
  /** Display only — see `formatMoney`. Never sent to a site. */
  currency: string;
}) {
  const [product, setProduct] = useState<Product | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const index = row?.index ?? null;

  // The component is remounted per row (see `key` at the call site), so the
  // initial state is already "loading" — the effect only has to fetch.
  useEffect(() => {
    if (index === null) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/import/preview/${previewId}?index=${index}`);
        const payload = (await response.json()) as { product?: Product; error?: string };

        if (cancelled) {
          return;
        }

        if (!response.ok || !payload.product) {
          setError(payload.error ?? "Could not read the detail for this row.");
          setState("error");
          return;
        }

        setProduct(payload.product);
        setState("ready");
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
          setState("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [previewId, index]);

  if (row === null || index === null) {
    return null;
  }

  const current: RowEdit = edit ?? {};

  function patch(next: Partial<RowEdit>) {
    const merged = { ...current, ...next };
    // Drop the edit record entirely once every field is empty again — keeping an
    // empty object would badge the row as "edited" when nothing was.
    const meaningful = Object.entries(merged).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "",
    );
    onEditChange(index as number, meaningful.length === 0 ? undefined : merged);
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={row.name || `Row ${row.index + 1}`}
      description={`Row ${row.index + 1} of the file · ${row.type}`}
      width="lg"
      footer={
        <>
          <Button
            variant={dropped ? "secondary" : "danger"}
            icon={dropped ? "refresh" : "trash"}
            onClick={() => onDrop(index as number, !dropped)}
          >
            {dropped ? "Put this row back" : "Drop this row from the run"}
          </Button>
          <Button variant="primary" icon="check" onClick={onClose}>
            Xong
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {dropped ? (
          <Alert tone="warn" title="This row has been dropped">
            It will not be sent to any site. The remaining rows keep their idempotency keys, so
            dropping this one cannot cause the others to be created twice.
          </Alert>
        ) : null}

        {row.issues.length > 0 ? (
          <Alert tone="warn" title={`${row.issues.length} warning(s) on this row`}>
            <ul className="list-disc space-y-1 pl-4">
              {row.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {/* ----------------------------------------------------------- Editing */}
        <Panel title="Correct before running" icon="edit">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Product name" htmlFor="edit-name">
              <Input
                id="edit-name"
                value={current.name ?? row.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </Field>

            <Field label="SKU" htmlFor="edit-sku">
              <Input
                id="edit-sku"
                value={current.sku ?? row.sku}
                onChange={(event) => patch({ sku: event.target.value })}
              />
            </Field>

            <Field
              label="Slug"
              htmlFor="edit-slug"
              hint="Already includes the random suffix, if that option is on."
            >
              <Input
                id="edit-slug"
                value={current.slug ?? row.slug}
                onChange={(event) => patch({ slug: event.target.value })}
                className="font-mono text-xs"
              />
            </Field>

            {/*
              The FIELD stays a raw number — that is what gets published, and
              formatting it would make the value un-editable. The formatted
              version sits underneath as a hint, which is the whole point of the
              currency setting: this is the screen where somebody reads a price
              closely enough to wonder what it means.
            */}
            <Field
              label="Price"
              htmlFor="edit-price"
              hint={
                currency === "" || (current.price ?? row.price) === ""
                  ? undefined
                  : `Shows as ${formatMoney(current.price ?? row.price, currency)} — display only, the site uses its own currency`
              }
            >
              <Input
                id="edit-price"
                inputMode="decimal"
                value={current.price ?? row.price}
                onChange={(event) => patch({ price: event.target.value })}
              />
            </Field>

            <Field label="Categories" className="sm:col-span-2">
              <TagInput
                values={current.categories ?? row.categories}
                suggestions={categoryOptions}
                onChange={(next) => patch({ categories: next })}
                placeholder="Type to search the site's categories…"
              />
            </Field>

            <Field label="Tags" className="sm:col-span-2">
              <TagInput
                values={current.tags ?? row.tags}
                suggestions={tagOptions}
                onChange={(next) => patch({ tags: next })}
                placeholder="Type to search the site's tags…"
              />
            </Field>
          </div>

          {edit ? (
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
              <Badge tone="accent" icon="edit">
                This row has been edited
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                icon="refresh"
                onClick={() => onEditChange(index as number, undefined)}
              >
                Revert to the original data
              </Button>
            </div>
          ) : null}
        </Panel>

        {/* ------------------------------------------------------ Original data */}
        {state === "loading" ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-40" rounded="sm" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}

        {state === "error" ? (
          <ErrorState
            title="Could not read the detail"
            message={error ?? "Unknown error."}
            hint="A preview is kept for one hour. If it has expired, go back to the source step and preview again."
          />
        ) : null}

        {state === "ready" && product ? (
          <>
            {(product.images?.length ?? 0) > 0 ? (
              <Panel title={`Images (${product.images?.length ?? 0})`} icon="image">
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {(product.images ?? []).slice(0, 12).map((url) => (
                    // eslint-disable-next-line @next/next/no-img-element -- Images come from arbitrary external hosts; next/image needs the domain declared in advance.
                    <img
                      key={url}
                      src={url}
                      alt=""
                      loading="lazy"
                      className="aspect-square w-full rounded-md border border-line object-cover"
                    />
                  ))}
                </div>
                {(product.images?.length ?? 0) > 12 ? (
                  <p className="mt-2 text-xs text-ink-subtle">
                    Showing the first 12 of {formatNumber(product.images?.length ?? 0)}.
                  </p>
                ) : null}
              </Panel>
            ) : null}

            <Panel title="Product attributes" icon="tag">
              {(product.attributes?.length ?? 0) === 0 ? (
                <p className="text-xs text-ink-subtle">
                  No attributes at product level — most likely because “Keep product attributes”
                  is off.
                </p>
              ) : (
                <DescriptionList
                  columns={2}
                  items={(product.attributes ?? []).map((attribute) => ({
                    term: attribute.name,
                    value: attribute.values.join(", "),
                  }))}
                />
              )}
            </Panel>

            <Panel title={`Variations (${product.variations?.length ?? 0})`} icon="layers" padded={false}>
              {(product.variations?.length ?? 0) === 0 ? (
                <p className="px-4 py-4 text-xs text-ink-subtle">
                  No variations. If the source had them, “Flatten variants into one product” is on
                  — it folds the variation images into the gallery and takes the cheapest price.
                </p>
              ) : (
                <div className="scroll-frame">
                  <table className="w-full min-w-[30rem] border-collapse text-sm">
                    <caption className="sr-only">The variations</caption>
                    <thead>
                      <tr className="border-b border-line bg-surface-sunken">
                        <th scope="col" className="px-3 py-2 text-left text-2xs font-semibold tracking-wide text-ink-subtle uppercase">
                          SKU
                        </th>
                        <th scope="col" className="px-3 py-2 text-left text-2xs font-semibold tracking-wide text-ink-subtle uppercase">
                          Attributes
                        </th>
                        <th scope="col" className="px-3 py-2 text-right text-2xs font-semibold tracking-wide text-ink-subtle uppercase">
                          Price
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(product.variations ?? []).map((variation, position) => (
                        <tr key={`${variation.sku}-${position}`} className="border-b border-line last:border-0">
                          <td className="px-3 py-2 font-mono text-xs text-ink">
                            {variation.sku || "—"}
                          </td>
                          <td className="px-3 py-2 text-xs text-ink-muted">
                            {variation.attributes
                              .map((attribute) => `${attribute.name}: ${attribute.value}`)
                              .join(" · ") || "—"}
                          </td>
                          <td className="tnum px-3 py-2 text-right text-xs text-ink">
                            {variation.price === undefined ? "—" : String(variation.price)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel title="Exactly what will be sent to the plugin" icon="file">
              <CodeBlock code={JSON.stringify(product, null, 2)} language="json" wrap />
            </Panel>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
