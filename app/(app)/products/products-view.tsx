"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { StoreHealthPill } from "@/components/domain/store-health";
import { useJobs } from "@/components/shell/jobs-provider";
import {
  Alert,
  Badge,
  BulkBar,
  Button,
  ButtonLink,
  Code,
  DataTable,
  EmptyState,
  Field,
  Icon,
  Input,
  Panel,
  Select,
  Switch,
  Stat,
  useToast,
  type Column,
} from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/format";
import type { ProductSummary } from "@/lib/gop-client";
import type { JobState } from "@/lib/jobs";
import type { PluginSupport } from "@/lib/plugin-support";
import { CONFIRM_PHRASE, TICKED_CONFIRMATION_ABOVE, purgeNeedsConfirmation } from "@/lib/purge-options";
import { adminProductUrl } from "@/lib/store-links";
import type { PublicStore } from "@/lib/stores";

import { BulkPanel } from "./bulk-panel";
import { EditDrawer } from "./edit-drawer";

/**
 * Product management for a customer account.
 *
 * The honesty rule this screen is built around: **a page is never presented as
 * everything.** The plugin caps one summary lookup at 500 products, that cap is real
 * and stays, and so every count on screen says both numbers — how many are shown and
 * how many the filter matched on the site. Showing only what came back is the exact
 * dishonesty the removal flow already had to fix once, and it is not coming back here.
 *
 * The filtering is SERVER-side for the same reason. A search box that filtered only
 * the rows already loaded would silently miss everything past the first page, which
 * reads — to whoever is using it — exactly like a product that is not on the site.
 */

type StoreWithSupport = PublicStore & { support: PluginSupport };

export function ProductsView({
  stores,
  canEdit,
  canRemove,
  operatorOnly,
  currency,
}: {
  stores: StoreWithSupport[];
  canEdit: boolean;
  canRemove: boolean;
  /** An administrator in their own account: read-only, exactly as Import and Remove. */
  operatorOnly: boolean;
  currency: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const { refresh } = useJobs();

  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  /** Only products with no picture at all. Needs plugin 3.7.0; the route refuses below it. */
  const [withoutImages, setWithoutImages] = useState(false);
  const [category, setCategory] = useState("");
  const [skuQuery, setSkuQuery] = useState("");

  const [products, setProducts] = useState<ProductSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * Ids resolved from the WHOLE filter, when the operator asked for that.
   *
   * Held apart from `selected` deliberately: "the 100 rows I ticked" and "everything
   * the filter matched" are different promises, and a single set could not tell a
   * screen which one it is holding.
   */
  const [filterIds, setFilterIds] = useState<number[] | null>(null);

  const [editing, setEditing] = useState<ProductSummary | null>(null);
  const [bulk, setBulk] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const store = stores.find((entry) => entry.id === storeId) ?? null;
  const supported = store?.support.ok ?? false;
  const live = canEdit && !operatorOnly && supported;

  /** Anything that changes what would match makes the loaded list stale. */
  function invalidate() {
    setProducts(null);
    setTotal(0);
    setOffset(0);
    setMore(false);
    setSelected(new Set());
    setFilterIds(null);
    setError(null);
  }

  async function load(nextOffset: number, withIds = false) {
    if (storeId === "") {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/products/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId,
          search: skuQuery.trim() === "" ? search.trim() : "",
          skus: skuQuery.trim() === "" ? [] : skuQuery.trim().split(/[\s,]+/).filter(Boolean),
          category: category.trim(),
          status: status === "" ? undefined : status,
          withoutImages,
          limit: 100,
          offset: nextOffset,
          withIds,
        }),
      });

      const payload = (await response.json()) as {
        products?: ProductSummary[];
        total?: number;
        shown?: number;
        more?: boolean;
        ids?: number[] | null;
        idsTruncated?: boolean;
        error?: string;
      };

      if (!response.ok || payload.products === undefined) {
        setError(payload.error ?? "Could not read the site.");
        return;
      }

      // Appending rather than replacing when paging: the operator is building up a
      // working set, and a "Load more" that replaced the table would lose their ticks.
      setProducts((current) =>
        nextOffset === 0 ? payload.products! : [...(current ?? []), ...payload.products!],
      );
      setTotal(payload.total ?? 0);
      setOffset(nextOffset);
      setMore(payload.more ?? false);

      if (withIds) {
        setFilterIds(payload.ids ?? null);

        if (payload.idsTruncated === true) {
          toast.error(
            "The site would not return every matching id",
            "This catalogue is larger than the plugin's ceiling. Narrow the filter before selecting everything.",
          );
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  /** Which ids a bulk action would cover: the whole filter, or just the ticks. */
  const targetIds = useMemo(
    () => filterIds ?? [...selected].map((key) => Number.parseInt(key, 10)).filter(Number.isFinite),
    [filterIds, selected],
  );

  const deleteNeedsPhrase = purgeNeedsConfirmation("ids", targetIds.length);

  async function deleteSelected() {
    if (targetIds.length === 0) {
      return;
    }

    setDeleting(true);

    try {
      const detail = (products ?? [])
        .filter((product) => targetIds.includes(product.product_id))
        .map((product) => ({
          product_id: product.product_id,
          sku: product.sku,
          name: product.name,
        }));

      const response = await fetch("/api/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          options: {
            storeId,
            selection: { kind: "ids", productIds: targetIds },
            deleteImages: true,
          },
          ids: targetIds,
          // Names and SKUs for the rows we have. Once a product is deleted its result
          // row is the only surviving record of what it was.
          products: detail,
          confirmPhrase: deletePhrase,
        }),
      });

      const payload = (await response.json()) as { job?: JobState; error?: string };

      if (!response.ok || !payload.job) {
        setError(payload.error ?? "Could not start the removal.");
        return;
      }

      await refresh();
      toast.success(
        `Queued the removal of ${formatNumber(targetIds.length)} product(s)`,
        "Close the tab if you like — the worker carries on without it.",
      );
      router.push(`/process/${payload.job.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
      setDeletePhrase("");
    }
  }

  const columns = useMemo<Column<ProductSummary>[]>(
    () => [
      {
        key: "name",
        header: "Product",
        sortable: true,
        sortValue: (product) => product.name,
        cell: (product) => (
          <div className="min-w-0">
            <span className="block truncate text-sm text-ink">{product.name}</span>
            <span className="block truncate font-mono text-2xs text-ink-subtle">
              {product.sku || `#${product.product_id}`}
            </span>
          </div>
        ),
      },
      {
        key: "price",
        header: "Price",
        width: "11rem",
        align: "right",
        sortable: true,
        sortValue: (product) => Number.parseFloat(product.price) || 0,
        cell: (product) => (
          <div className="text-right">
            <span className="tnum block text-sm text-ink">
              {product.price === "" ? "—" : formatMoney(product.price, currency)}
            </span>
            {/* The regular price is only worth showing when a sale is HIDING it —
                otherwise it is the same number printed twice. */}
            {(product.sale_price ?? "") !== "" &&
            (product.regular_price ?? "") !== "" &&
            product.regular_price !== product.price ? (
              <span className="tnum block text-2xs text-ink-subtle line-through">
                {formatMoney(product.regular_price!, currency)}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: "stock",
        header: "Stock",
        width: "7rem",
        align: "right",
        hideBelow: "md",
        cell: (product) => (
          <span className="tnum text-xs text-ink-muted">
            {product.manage_stock === true ? (product.stock ?? "0") : "—"}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        width: "7rem",
        hideBelow: "sm",
        sortable: true,
        sortValue: (product) => product.status,
        cell: (product) => (
          <Badge tone={product.status === "publish" ? "neutral" : "warn"}>{product.status}</Badge>
        ),
      },
      {
        key: "type",
        header: "Type",
        width: "9rem",
        hideBelow: "lg",
        cell: (product) => (
          <span className="flex flex-wrap items-center gap-1 text-2xs text-ink-muted">
            <Badge tone="neutral">{product.type}</Badge>
            {product.variation_count > 0 ? <span>{product.variation_count} var</span> : null}
            {product.image_count > 0 ? <span>· {product.image_count} img</span> : null}
          </span>
        ),
      },
      {
        key: "categories",
        header: "Categories",
        hideBelow: "lg",
        cell: (product) => (
          <span className="block truncate text-2xs text-ink-subtle">
            {product.categories.join(", ") || "—"}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        width: "7rem",
        cell: (product) => (
          <div className="flex items-center justify-end gap-1">
            {live ? (
              <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(product)}>
                Edit
              </Button>
            ) : null}
            {store ? (
              <a
                href={adminProductUrl(store, product.product_id)}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${product.name} in wp-admin`}
                className="grid size-7 place-items-center rounded-sm text-ink-subtle transition-colors duration-fast hover:bg-surface hover:text-accent-fg"
              >
                <Icon name="external-link" className="size-3.5" />
              </a>
            ) : null}
          </div>
        ),
      },
    ],
    [currency, live, store],
  );

  if (stores.length === 0) {
    return (
      <Panel title="Products" icon="package">
        <EmptyState
          icon="store"
          title="No sites connected"
          description="Add a site before managing the products on one."
          action={
            <ButtonLink href="/stores" variant="primary" icon="plus">
              Add a site
            </ButtonLink>
          }
        />
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      {operatorOnly ? (
        <Alert tone="info" title="An administrator account does not change products of its own">
          This screen is read-only here. Open the customer&rsquo;s account from the Accounts screen
          and work inside it, so the change belongs to them — the same rule Import and Remove follow,
          and the routes refuse it either way.
        </Alert>
      ) : null}

      {!canEdit && !operatorOnly ? (
        <Alert tone="warn" title="Changing products is switched off for this account">
          The list below still works, and each product still opens in wp-admin. Ask an administrator
          to enable product editing.
        </Alert>
      ) : null}

      <Panel title="Site" icon="store" description="Product management targets exactly one site">
        <div className="grid gap-4 md:grid-cols-[minmax(0,24rem)_1fr] md:items-end">
          <Field label="Site" htmlFor="productStore">
            <Select
              id="productStore"
              value={storeId}
              onChange={(event) => {
                setStoreId(event.target.value);
                invalidate();
              }}
            >
              {stores.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label || entry.url}
                </option>
              ))}
            </Select>
          </Field>

          {store ? (
            <div className="flex flex-wrap items-center gap-2 pb-2">
              <StoreHealthPill store={store} expectedVersion={null} />
              <span className="truncate text-xs text-ink-subtle">{store.url}</span>
            </div>
          ) : null}
        </div>

        {store !== null && !supported ? (
          <Alert tone="bad" title="This site's plugin is too old for this screen" className="mt-4">
            <p>{store.support.message}</p>
            <p className="mt-2 text-2xs">
              The reason this refuses to open rather than degrading: an older plugin does not reject
              the search filter, it <strong>ignores</strong> it — so a search would quietly return
              the whole catalogue and every product would look like a match.
            </p>
          </Alert>
        ) : null}
      </Panel>

      {supported ? (
        <>
          <Panel title="Find products" icon="search">
            <div className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-4">
                <Field
                  label="Name contains"
                  htmlFor="productSearch"
                  hint="Searched on the site, not in the loaded rows."
                >
                  <Input
                    id="productSearch"
                    value={search}
                    placeholder="Áo khoác"
                    onChange={(event) => {
                      setSearch(event.target.value);
                      invalidate();
                    }}
                  />
                </Field>

                <Field
                  label="Exact SKUs"
                  htmlFor="productSkus"
                  hint="Space or comma separated. Overrides the name search."
                >
                  <Input
                    id="productSkus"
                    value={skuQuery}
                    placeholder="AO-001 AO-002"
                    onChange={(event) => {
                      setSkuQuery(event.target.value);
                      invalidate();
                    }}
                  />
                </Field>

                <Field
                  label="Category"
                  htmlFor="productCategory"
                  hint="Includes sub-categories. Matched by name or slug."
                >
                  <Input
                    id="productCategory"
                    value={category}
                    placeholder="T-shirts"
                    onChange={(event) => {
                      setCategory(event.target.value);
                      invalidate();
                    }}
                  />
                </Field>

                <Field label="Status" htmlFor="productStatus">
                  <Select
                    id="productStatus"
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value);
                      invalidate();
                    }}
                  >
                    <option value="">Any status</option>
                    {["publish", "draft", "pending", "private", "future"].map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field
                  label="Images"
                  hint="A thumbnail, a gallery, an external image URL or a pictured variation all count as having one."
                >
                  <Switch
                    checked={withoutImages}
                    onChange={(next) => {
                      setWithoutImages(next);
                      invalidate();
                    }}
                    label={withoutImages ? "Only without an image" : "Any"}
                  />
                </Field>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <p className="text-xs text-ink-subtle">
                  Every filter is applied on the site, so a match past the first page is still found.
                </p>
                <Button
                  variant="secondary"
                  icon="search"
                  loading={loading && offset === 0}
                  onClick={() => void load(0)}
                >
                  {products === null ? "Find products" : "Search again"}
                </Button>
              </div>
            </div>
          </Panel>

          {error ? (
            <Alert tone="bad" title="Could not read the site">
              {error}
            </Alert>
          ) : null}

          {products !== null ? (
            <Panel
              title="Products"
              icon="package"
              padded={false}
              actions={
                <Badge tone={total === 0 ? "neutral" : "accent"}>
                  {formatNumber(products.length)} of {formatNumber(total)}
                </Badge>
              }
            >
              {total === 0 ? (
                <div className="p-5">
                  <EmptyState
                    icon="search"
                    title="Nothing matched"
                    description="No product on this site matches that. The filter ran on the site, so this is not a paging artefact."
                    action={
                      <Button variant="secondary" icon="refresh" onClick={() => void load(0)}>
                        Search again
                      </Button>
                    }
                  />
                </div>
              ) : (
                <>
                  <div className="grid gap-3 border-b border-line p-5 sm:grid-cols-3">
                    <Stat
                      label="Matched on the site"
                      value={formatNumber(total)}
                      icon="package"
                      hint="what the filter found"
                    />
                    <Stat
                      label="Loaded here"
                      value={formatNumber(products.length)}
                      icon="layers"
                      hint={more ? "more pages available" : "all of them"}
                    />
                    <Stat
                      label="Selected"
                      value={formatNumber(targetIds.length)}
                      icon="check-circle"
                      tone={targetIds.length > 0 ? "warn" : "neutral"}
                      hint={filterIds !== null ? "the whole filter" : "ticked rows"}
                    />
                  </div>

                  {/*
                    The number of loaded rows and the number matched, always both.
                    "500 products" with 12,480 on the site is the sentence this screen
                    exists not to print.
                  */}
                  {more ? (
                    <Alert tone="info" title="This is a page, not the whole catalogue">
                      <p>
                        {formatNumber(total)} products match on the site;{" "}
                        {formatNumber(products.length)} are loaded here. The plugin returns at most
                        500 per page because the per-product detail is what makes a page expensive.
                      </p>
                      <p className="mt-1">
                        To act on all {formatNumber(total)} without loading them, use{" "}
                        <strong>Select everything that matched</strong> below — it resolves every
                        matching id on the site in one cheap call.
                      </p>
                    </Alert>
                  ) : null}

                  <DataTable
                    rows={products}
                    columns={columns}
                    rowKey={(product) => String(product.product_id)}
                    selectable={live || canRemove}
                    selected={selected}
                    onSelectedChange={(next) => {
                      setSelected(next);
                      // Ticking a row means "these rows", which is a different promise
                      // from "everything the filter matched".
                      setFilterIds(null);
                    }}
                    caption="Products on this site"
                  />

                  <div className="flex flex-wrap items-center gap-3 border-t border-line p-4">
                    {more ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="chevron-down"
                        loading={loading && offset > 0}
                        // The next offset IS the number of rows already loaded — they
                        // accumulate rather than being replaced.
                        onClick={() => void load(products.length)}
                      >
                        Load the next page
                      </Button>
                    ) : null}

                    {(live || canRemove) && total > products.length ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="check-circle"
                        loading={loading}
                        onClick={() => void load(0, true)}
                      >
                        Select everything that matched ({formatNumber(total)})
                      </Button>
                    ) : null}

                    {filterIds !== null ? (
                      <Badge tone="warn" icon="alert-triangle">
                        {formatNumber(filterIds.length)} ids resolved from the filter
                      </Badge>
                    ) : null}
                  </div>
                </>
              )}
            </Panel>
          ) : null}

          {/* ---------------------------------------------------- bulk actions */}
          {targetIds.length > 0 && !bulk && !confirmingDelete ? (
            <BulkBar
              count={targetIds.length}
              onClear={() => {
                setSelected(new Set());
                setFilterIds(null);
              }}
            >
              {live ? (
                <Button size="sm" variant="primary" icon="refresh" onClick={() => setBulk(true)}>
                  Change them
                </Button>
              ) : null}
              {canRemove && !operatorOnly ? (
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete them
                </Button>
              ) : null}
            </BulkBar>
          ) : null}

          {bulk && store !== null ? (
            <BulkPanel
              storeId={storeId}
              storeLabel={store.label || store.url}
              productIds={targetIds}
              currency={currency}
              onDone={() => setBulk(false)}
            />
          ) : null}

          {confirmingDelete ? (
            <Panel title="Delete these products" icon="alert-triangle">
              <div className="space-y-4">
                <Alert tone="bad" title={`This removes ${formatNumber(targetIds.length)} product(s)`}>
                  <p>
                    For each product: the product row, its variations, its image attachments, all
                    post meta, category and tag links with the counts corrected, its WooCommerce
                    lookup row, its reviews and their meta, its idempotency record, and the image
                    files in uploads.
                  </p>
                  <p className="mt-1">
                    There is no undo. It runs as a removal run, so it has progress, a log, Cancel and
                    a per-table report of what left.
                  </p>
                </Alert>

                {deleteNeedsPhrase ? (
                  <Field
                    label={`Type ${CONFIRM_PHRASE} to confirm`}
                    htmlFor="deletePhrase"
                    hint={`Required above ${TICKED_CONFIRMATION_ABOVE} products, because past that a table stops being a list you have read. Checked on the server too.`}
                  >
                    <Input
                      id="deletePhrase"
                      value={deletePhrase}
                      autoComplete="off"
                      placeholder={CONFIRM_PHRASE}
                      onChange={(event) => setDeletePhrase(event.target.value)}
                      className="max-w-48"
                    />
                  </Field>
                ) : null}

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="danger"
                    size="lg"
                    icon="trash"
                    loading={deleting}
                    disabled={deleteNeedsPhrase && deletePhrase !== CONFIRM_PHRASE}
                    onClick={() => void deleteSelected()}
                  >
                    Delete {formatNumber(targetIds.length)} product
                    {targetIds.length === 1 ? "" : "s"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setConfirmingDelete(false);
                      setDeletePhrase("");
                    }}
                  >
                    Keep them
                  </Button>
                  <span className="text-xs text-ink-subtle">
                    From <Code>{store?.label || store?.url || "—"}</Code>
                  </span>
                </div>
              </div>
            </Panel>
          ) : null}
        </>
      ) : null}

      <EditDrawer
        product={editing}
        storeId={storeId}
        currency={currency}
        onClose={() => setEditing(null)}
        onSaved={() => {
          // Re-read from the site rather than patching the row in place. The plugin
          // derives values this screen does not send — the displayed price from the
          // sale price, the stock status from the quantity — so a locally patched row
          // would show something the site does not hold.
          void load(0);
        }}
      />
    </div>
  );
}
