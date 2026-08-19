"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { StoreHealthPill } from "@/components/domain/store-health";
import { useJobs } from "@/components/shell/jobs-provider";
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Code,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Panel,
  RadioGroup,
  Select,
  Stat,
  Switch,
  TagInput,
  useToast,
  type Column,
} from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { JobState } from "@/lib/jobs";
import type { LookupResponse, ProductSummary } from "@/lib/gop-client";
import {
  CONFIRM_PHRASE,
  DESTRUCTIVE_SELECTIONS,
  PURGE_SELECTIONS,
  PURGE_SELECTION_LABELS,
  type PurgeSelection,
} from "@/lib/purge-options";
import type { PublicStore } from "@/lib/stores";

/**
 * Removing products.
 *
 * The shape of this screen is the safety property: a filter is never what gets
 * executed. Choosing a filter produces a LIST, the list is what the operator
 * reads, and the list — not the filter — is what the run is built from. A
 * category that gains a product between looking and pressing cannot take that
 * product with it.
 *
 * The two selections that can empty a catalogue in one press additionally ask
 * for a typed confirmation, checked again on the server.
 */

export interface RunOption {
  id: string;
  storeId: string;
  storeLabel: string;
  sourceLabel: string;
  succeeded: number;
  status: string;
  createdAt: string;
}

export function RemoveView({ stores, runs }: { stores: PublicStore[]; runs: RunOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const { refresh } = useJobs();

  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  /*
   * The four selections THIS screen offers, and not the union.
   *
   * `PurgeSelectionKind` gained an `ids` member for the product screen, which ticks
   * products rather than describing a filter. Typing the state as the union would
   * make this component's own switch non-exhaustive over a case it can never reach
   * and has no radio button for.
   */
  const [kind, setKind] = useState<(typeof PURGE_SELECTIONS)[number]>("run");

  const [runId, setRunId] = useState("");
  const [skus, setSkus] = useState<string[]>([]);
  const [category, setCategory] = useState("");

  const [deleteImages, setDeleteImages] = useState(true);
  /**
   * Narrow the selection to products with no picture at all.
   *
   * A NARROWING, never a selection: it sits beside "a category" or "every product",
   * because on its own it would be a filter that means everything — which is the one
   * shape this screen refuses. Clearing the lookup when it changes is the same rule
   * every other control here follows: a list that was read under one filter must not
   * be confirmed under another.
   */
  const [withoutImages, setWithoutImages] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState("");

  /**
   * Two things, and the difference between them is what makes one run cover the
   * whole selection:
   *
   *  - `lookup` is a PAGE of full detail — up to 500 rows — for reading. Nobody
   *    reviews 3000 rows, and the per-product summary is what makes a page
   *    expensive to fetch.
   *  - `matched` is the COMPLETE set of ids the selection matched. It is what
   *    the run is built from, and `matched.total` is the number the confirm
   *    step quotes.
   *
   * Both come from the same call at the same instant, so the operator still
   * confirms a known, counted set rather than a filter — that property never
   * depended on the size of the list.
   */
  const [lookup, setLookup] = useState<LookupResponse | null>(null);
  const [matched, setMatched] = useState<{
    ids: number[];
    total: number;
    truncated: boolean;
  } | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const store = stores.find((entry) => entry.id === storeId) ?? null;

  // Only runs that targeted THIS site. A run against another site created
  // products with ids that mean something else entirely here.
  const runsForStore = useMemo(
    () => runs.filter((run) => run.storeId === storeId),
    [runs, storeId],
  );

  const destructive = DESTRUCTIVE_SELECTIONS.has(kind);
  const confirmed = !destructive || confirmPhrase === CONFIRM_PHRASE;

  /** Anything that changes what would match invalidates the list already shown. */
  function invalidate() {
    setLookup(null);
    setMatched(null);
    setLookupError(null);
    setStartError(null);
  }

  const selection = useMemo<PurgeSelection | null>(() => {
    switch (kind) {
      case "run":
        return runId === "" ? null : { kind: "run", runId };
      case "skus":
        return skus.length === 0 ? null : { kind: "skus", skus };
      case "category":
        return category.trim() === "" ? null : { kind: "category", category: category.trim() };
      case "all":
        return { kind: "all", confirm: true };
    }
  }, [kind, runId, skus, category]);

  async function runLookup() {
    if (selection === null || storeId === "") {
      return;
    }

    setLooking(true);
    setLookupError(null);

    try {
      const response = await fetch("/api/purge/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId, selection, limit: 500, withoutImages }),
      });

      const payload = (await response.json()) as {
        lookup?: LookupResponse;
        ids?: number[];
        total?: number;
        truncated?: boolean;
        error?: string;
      };

      if (!response.ok || !payload.lookup) {
        setLookupError(payload.error ?? "Could not read the site.");
        return;
      }

      setLookup(payload.lookup);
      setMatched({
        ids: payload.ids ?? payload.lookup.products.map((product) => product.product_id),
        total: payload.total ?? payload.lookup.total,
        truncated: payload.truncated ?? false,
      });
    } catch (caught) {
      setLookupError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLooking(false);
    }
  }

  async function start() {
    if (selection === null || lookup === null || matched === null || matched.ids.length === 0) {
      return;
    }

    setStarting(true);
    setStartError(null);

    try {
      const response = await fetch("/api/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          options: { storeId, selection, deleteImages },
          // EVERY matched id — this is what the run covers.
          ids: matched.ids,
          // Detail for the rows that were displayed. Once a product is gone its
          // result row is the only record of what it was, so the names and SKUs
          // we do have are worth carrying; the rest are staged as bare ids.
          products: lookup.products.map((product) => ({
            product_id: product.product_id,
            sku: product.sku,
            name: product.name,
          })),
          confirmPhrase,
        }),
      });

      const payload = (await response.json()) as { job?: JobState; error?: string };

      if (!response.ok || !payload.job) {
        setStartError(payload.error ?? "Unknown error.");
        return;
      }

      await refresh();
      toast.success(
        `Queued the removal of ${formatNumber(matched.ids.length)} product(s)`,
        "Close the tab if you like — the worker carries on without it.",
      );
      router.push(`/process/${payload.job.id}`);
    } catch (caught) {
      setStartError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
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
            <span className="block truncate text-2xs text-ink-subtle">/{product.slug}</span>
          </div>
        ),
      },
      {
        key: "sku",
        header: "SKU",
        width: "10rem",
        sortable: true,
        sortValue: (product) => product.sku,
        cell: (product) => (
          <span className="font-mono text-xs text-ink-muted">{product.sku || "—"}</span>
        ),
      },
      {
        key: "type",
        header: "Type",
        width: "7rem",
        hideBelow: "md",
        sortable: true,
        sortValue: (product) => product.type,
        cell: (product) => <Badge tone="neutral">{product.type}</Badge>,
      },
      {
        key: "contents",
        header: "Takes with it",
        width: "12rem",
        hideBelow: "sm",
        cell: (product) => (
          <span className="flex flex-wrap gap-1 text-2xs text-ink-muted">
            {product.variation_count > 0 ? (
              <span>{product.variation_count} variations</span>
            ) : null}
            {product.image_count > 0 ? <span>· {product.image_count} images</span> : null}
            {product.variation_count === 0 && product.image_count === 0 ? <span>—</span> : null}
            {/*
              From the plugin's own flag, which is the same definition the filter used
              — not `image_count`, which counts attachments and reads zero for a
              product whose pictures are external URLs.
            */}
            {product.has_image === false ? <Badge tone="warn">no image</Badge> : null}
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
    ],
    [],
  );

  if (stores.length === 0) {
    return (
      <Panel title="Remove products" icon="trash">
        <EmptyState
          icon="store"
          title="No sites connected"
          description="Add a site before trying to remove anything from one."
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
      <Panel title="Site" icon="store" description="Removal always targets exactly one site">
        <div className="grid gap-4 md:grid-cols-[minmax(0,24rem)_1fr] md:items-end">
          <Field label="Target site" htmlFor="purgeStore">
            <Select
              id="purgeStore"
              value={storeId}
              onChange={(event) => {
                setStoreId(event.target.value);
                setRunId("");
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
      </Panel>

      <Panel title="What to remove" icon="filter">
        <div className="space-y-4">
          <RadioGroup
            legend="Selection"
            value={kind}
            onChange={(next) => {
              setKind(next);
              setConfirmPhrase("");
              invalidate();
            }}
            options={PURGE_SELECTIONS.map((option) => ({
              value: option,
              label: PURGE_SELECTION_LABELS[option],
              description:
                option === "run"
                  ? "Uses the product ids this app recorded when the run answered — nothing has to be remembered on the site."
                  : option === "skus"
                    ? "Every product carrying one of these SKUs."
                    : option === "category"
                      ? "Products in that category and in every category beneath it."
                      : "The entire catalogue on the selected site.",
            }))}
          />

          {kind === "run" ? (
            runsForStore.length === 0 ? (
              <Alert tone="info" title="No import runs recorded for this site">
                Only runs that actually created products on this site can be used here.
              </Alert>
            ) : (
              <Field label="Import run" htmlFor="purgeRun">
                <Select
                  id="purgeRun"
                  value={runId}
                  onChange={(event) => {
                    setRunId(event.target.value);
                    invalidate();
                  }}
                >
                  <option value="">Choose a run…</option>
                  {runsForStore.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.sourceLabel} — {run.succeeded} products
                    </option>
                  ))}
                </Select>
              </Field>
            )
          ) : null}

          {kind === "skus" ? (
            <Field
              label="SKUs"
              hint="Type or paste one at a time. Every product carrying the SKU is matched."
            >
              <TagInput
                values={skus}
                suggestions={[]}
                onChange={(next) => {
                  setSkus(next);
                  invalidate();
                }}
                placeholder="Add a SKU…"
              />
            </Field>
          ) : null}

          {kind === "category" ? (
            <Field
              label="Category"
              htmlFor="purgeCategory"
              hint='Matched by name or slug. A path like "Clothing > T-shirts" uses its last segment. Sub-categories are included.'
            >
              <Input
                id="purgeCategory"
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value);
                  invalidate();
                }}
                placeholder="T-shirts"
              />
            </Field>
          ) : null}

          {kind === "all" ? (
            <Alert tone="bad" title="This selects every product on the site">
              There is no undo. What this removes is gone from the database and, unless you turn
              images off below, from the uploads folder as well.
            </Alert>
          ) : null}

          <Field
            label="Only products with no image"
            hint="Narrows whatever is selected above — it does not replace it. A product counts as having an image if it has a thumbnail, a gallery, an external image URL, or a variation with one; the last two matter because the default import mode writes external URLs rather than attachments."
          >
            <Switch
              checked={withoutImages}
              onChange={(next) => {
                setWithoutImages(next);
                // The list on screen was read under the old filter. Confirming it
                // under a new one is exactly the mistake this screen is built around.
                invalidate();
              }}
              label={withoutImages ? "Only products with no image" : "Every product that matches"}
            />
          </Field>

          <Field
            label="Image files"
            hint="Database rows are always removed. This decides whether the image files in wp-content/uploads go too."
          >
            <Switch
              checked={deleteImages}
              onChange={setDeleteImages}
              label={deleteImages ? "Delete the image files as well" : "Leave the files on disk"}
            />
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-xs text-ink-subtle">
              Nothing is removed at this step — this only shows what matches.
            </p>
            <Button
              variant="secondary"
              icon="search"
              loading={looking}
              disabled={selection === null || storeId === ""}
              onClick={() => void runLookup()}
            >
              Show what matches
            </Button>
          </div>
        </div>
      </Panel>

      {lookupError ? (
        <ErrorState
          title="Could not read the site"
          message={lookupError}
          onRetry={() => void runLookup()}
        />
      ) : null}

      {lookup !== null ? (
        <Panel
          title="Matched products"
          icon="package"
          padded={false}
          actions={
            <Badge tone={lookup.total === 0 ? "neutral" : "warn"}>
              {formatNumber(lookup.total)} matched
            </Badge>
          }
        >
          {lookup.total === 0 ? (
            <div className="p-5">
              <EmptyState
                icon="search"
                title="Nothing matched"
                description="Nothing will be removed. Adjust the selection and look again."
                action={
                  <Button variant="secondary" icon="refresh" onClick={() => void runLookup()}>
                    Look again
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <div className="grid gap-3 border-b border-line p-5 sm:grid-cols-3">
                <Stat
                  label="Products"
                  value={formatNumber(lookup.total)}
                  icon="package"
                  tone="warn"
                />
                <Stat
                  label="Variations"
                  value={formatNumber(
                    lookup.products.reduce((sum, product) => sum + product.variation_count, 0),
                  )}
                  icon="layers"
                />
                <Stat
                  label="Images"
                  value={formatNumber(
                    lookup.products.reduce((sum, product) => sum + product.image_count, 0),
                  )}
                  icon="image"
                  hint={deleteImages ? "files will be deleted too" : "files stay on disk"}
                />
              </div>

              {matched !== null && matched.total > lookup.products.length ? (
                <Alert tone="info" title="Showing a readable page — the run covers all of them">
                  <p>
                    {formatNumber(matched.total)} products match. The{" "}
                    {formatNumber(lookup.products.length)} below are shown in full so there is
                    something to read; the run is built from all{" "}
                    {formatNumber(matched.ids.length)} ids, resolved just now with the rest of this
                    list.
                  </p>
                  <p className="mt-1">
                    Rows past this page are staged by id, so their results will show the id without
                    a name — nothing looked their names up.
                  </p>
                </Alert>
              ) : null}

              {matched?.truncated ? (
                <Alert tone="warn" title="This catalogue is larger than one lookup can return">
                  <p>
                    {formatNumber(matched.total)} products match but the site returned{" "}
                    {formatNumber(matched.ids.length)}, which is the plugin’s ceiling. This run
                    removes those {formatNumber(matched.ids.length)}; run it again afterwards for
                    the remainder.
                  </p>
                </Alert>
              ) : null}

              <DataTable
                rows={lookup.products}
                columns={columns}
                rowKey={(product) => String(product.product_id)}
                caption="Products this selection matched"
              />
            </>
          )}
        </Panel>
      ) : null}

      {lookup !== null && matched !== null && matched.ids.length > 0 ? (
        <Panel title="Confirm" icon="alert-triangle">
          <div className="space-y-4">
            <Alert tone="warn" title="What a removal takes with it">
              <p>
                For each product: the product row, its variations, its image attachments, all post
                meta, category and tag links (with the counts corrected), its WooCommerce lookup
                row, its reviews and their meta, and its idempotency record.
                {deleteImages ? " Image files are unlinked from the uploads folder." : ""}
              </p>
              <p className="mt-1">
                Removing the idempotency record is what lets the same file be imported again
                afterwards — without it the site would answer “already imported” and create nothing.
              </p>
            </Alert>

            {destructive ? (
              <Field
                label={`Type ${CONFIRM_PHRASE} to confirm`}
                htmlFor="confirmPhrase"
                hint="Required for a whole category or a whole catalogue. Checked on the server too."
              >
                <Input
                  id="confirmPhrase"
                  value={confirmPhrase}
                  autoComplete="off"
                  placeholder={CONFIRM_PHRASE}
                  onChange={(event) => setConfirmPhrase(event.target.value)}
                />
              </Field>
            ) : null}

            {startError ? (
              <Alert tone="bad" title="Could not start">
                <p>{startError}</p>
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* The count of what will ACTUALLY go, not of what fits on the
                  page. "This removes the 500 below" was the old lie. */}
              <p className="text-xs text-ink-subtle">
                Removing <strong className="text-ink">{formatNumber(matched.ids.length)}</strong>{" "}
                product(s) from <Code>{store?.label || store?.url || "—"}</Code>.
              </p>
              <Button
                variant="danger"
                size="lg"
                icon="trash"
                loading={starting}
                disabled={!confirmed}
                onClick={() => void start()}
              >
                Remove {formatNumber(matched.ids.length)} product
                {matched.ids.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
