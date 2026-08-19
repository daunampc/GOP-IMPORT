"use client";

import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Code,
  DataTable,
  Panel,
  Stat,
  type Column,
} from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/format";
import { WRITE_MODE_LABELS, type WriteMode } from "@/lib/import-options";
import { UPDATE_NEVER_WRITES } from "@/lib/product-update";
import type { PublicStore } from "@/lib/stores";

/**
 * How much of this file is already on the site — answered BEFORE the run.
 *
 * The gap this closes is not cosmetic. `findDuplicateSkus` finds SKUs repeated
 * inside the file; nothing ever asked the SITE whether those SKUs were already on
 * it. So a file of products that had already been published imported as a second
 * set of products, and the operator found out by discovering the catalogue doubled.
 *
 * Deliberately a BUTTON rather than a fetch on mount, for two reasons that both
 * matter here. It is the shape the removal screen already uses — choose, then
 * "Show what matches", then confirm the list — so the two dangerous screens behave
 * the same way. And reading the clock or firing a request during render is what
 * produces hydration error #418 and trips `react-hooks/set-state-in-effect`; a
 * click has a browser, a real answer and no server render to disagree with.
 *
 * In the two write modes the Start button stays disabled until this has been run
 * for every selected site. A preview whose most consequential number is optional
 * is a preview that number will be skipped in.
 */

export interface ExistingAnswer {
  storeId: string;
  storeLabel: string;
  total: number;
  existing: number;
  missing: number;
  withoutSku: number;
  fields: Array<{ field: string; label: string; rows: number }>;
  examples: Array<{
    sku: string;
    name: string;
    productId: number;
    isVariation: boolean;
    currentPrice: string;
    filePrice: string;
    status: string;
  }>;
  checkedAt: string;
}

export function ExistingCheck({
  previewId,
  stores,
  writeMode,
  answers,
  onAnswers,
  currency,
}: {
  previewId: string;
  stores: PublicStore[];
  writeMode: WriteMode;
  /** Keyed by store id. Held by the wizard so it survives a step change. */
  answers: Record<string, ExistingAnswer>;
  onAnswers: (next: Record<string, ExistingAnswer>) => void;
  /** Display only — see `formatMoney`. Never sent to a site. */
  currency: string;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setError(null);

    const collected: Record<string, ExistingAnswer> = {};

    try {
      // One site at a time. Firing five requests at five shops in parallel to save
      // a second is load on somebody's live server for no benefit — this is a
      // question, not the run.
      for (const store of stores) {
        const response = await fetch("/api/import/exists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ previewId, storeId: store.id, examples: 20 }),
        });

        const payload = (await response.json()) as Partial<ExistingAnswer> & {
          error?: string;
          code?: string;
        };

        if (!response.ok || payload.existing === undefined) {
          setError(payload.error ?? `Could not read ${store.label || store.url}.`);
          return;
        }

        collected[store.id] = payload as ExistingAnswer;
      }

      onAnswers(collected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  }

  const checked = stores.length > 0 && stores.every((store) => answers[store.id] !== undefined);

  const columns: Column<ExistingAnswer["examples"][number]>[] = [
    {
      key: "name",
      header: "On the site now",
      cell: (row) => (
        <div className="min-w-0">
          <span className="block truncate text-sm text-ink">{row.name}</span>
          <span className="block truncate font-mono text-2xs text-ink-subtle">{row.sku}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "6rem",
      hideBelow: "md",
      cell: (row) => (
        <Badge tone={row.status === "publish" ? "neutral" : "warn"}>{row.status}</Badge>
      ),
    },
    {
      key: "change",
      header: "Price: site → file",
      width: "16rem",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="tnum text-ink-muted">{formatMoney(row.currentPrice, currency)}</span>
          <span className="text-ink-subtle">→</span>
          <span className="tnum font-medium text-ink">
            {row.filePrice === "" ? "unchanged" : formatMoney(row.filePrice, currency)}
          </span>
        </span>
      ),
    },
  ];

  return (
    <Panel
      title="What is already on the site"
      icon="search"
      description={`Asked before the run, because “${WRITE_MODE_LABELS[writeMode]}” writes over products that are on sale`}
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon={checked ? "refresh" : "search"}
          loading={checking}
          disabled={stores.length === 0}
          onClick={() => void check()}
        >
          {checked ? "Check again" : "Check the site"}
        </Button>
      }
    >
      <div className="space-y-4">
        {error ? (
          <Alert tone="bad" title="Could not check the site">
            {error}
          </Alert>
        ) : null}

        {!checked ? (
          <Alert tone="warn" title="Not checked yet">
            <p>
              Nothing has been read from{" "}
              {stores.length === 1 ? "the site" : `the ${stores.length} selected sites`} yet, so how
              many of these rows already exist is unknown. In{" "}
              <strong>{WRITE_MODE_LABELS[writeMode]}</strong> mode that is the number that decides
              what this run does, so it has to be answered before starting.
            </p>
          </Alert>
        ) : null}

        {stores.map((store) => {
          const answer = answers[store.id];

          if (answer === undefined) {
            return null;
          }

          const wouldRun =
            writeMode === "update_only" ? answer.existing : answer.existing + answer.missing;

          return (
            <div key={store.id} className="space-y-3 rounded-md border border-line p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral" icon="store">
                  {answer.storeLabel}
                </Badge>
                <span className="text-xs text-ink-subtle">
                  {formatNumber(answer.total)} row(s) read from the file
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <Stat
                  label="Already on the site"
                  value={formatNumber(answer.existing)}
                  icon="refresh"
                  tone={answer.existing > 0 ? "warn" : "neutral"}
                  hint="matched by SKU — these get updated"
                />
                <Stat
                  label="Not on the site"
                  value={formatNumber(answer.missing)}
                  icon="plus"
                  tone={writeMode === "update_only" && answer.missing > 0 ? "bad" : "neutral"}
                  hint={
                    writeMode === "update_only"
                      ? "reported as failures — nothing is created"
                      : "these get created"
                  }
                />
                <Stat
                  label="This run touches"
                  value={formatNumber(wouldRun)}
                  icon="package"
                  hint={`of ${formatNumber(answer.total)} rows`}
                />
              </div>

              {answer.withoutSku > 0 ? (
                <Alert tone="warn" title={`${formatNumber(answer.withoutSku)} row(s) have no SKU`}>
                  Nothing can be matched without a SKU, so these can never be updated —{" "}
                  {writeMode === "update_only"
                    ? "in “Update only” they are reported as failures."
                    : "they are created as new products."}
                </Alert>
              ) : null}

              {writeMode === "update_only" && answer.missing > 0 ? (
                <Alert
                  tone="bad"
                  title={`${formatNumber(answer.missing)} row(s) would NOT be published`}
                >
                  <p>
                    “Update only” creates nothing. These rows are recorded as failures with the
                    reason, so they can be downloaded as a CSV, checked, and imported separately if
                    they really are new products.
                  </p>
                </Alert>
              ) : null}

              {answer.fields.length > 0 ? (
                <div>
                  <p className="mb-2 text-xs text-ink-muted">
                    Fields this file would write, and on how many rows. A blank cell writes nothing —
                    it is the file being silent, not an instruction to clear the field.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {answer.fields.map((field) => (
                      <Badge key={field.field} tone="neutral">
                        {field.label} · {formatNumber(field.rows)}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {answer.examples.length > 0 ? (
                <div>
                  <p className="mb-2 text-xs text-ink-muted">
                    The first {answer.examples.length} matched row(s), with the site&rsquo;s current
                    price beside the file&rsquo;s. A count cannot catch the right number of rows
                    matching for the wrong reason; a name you recognise can.
                  </p>
                  <DataTable
                    rows={answer.examples}
                    columns={columns}
                    rowKey={(row) => `${store.id}:${row.productId}`}
                    caption={`Rows of this file already on ${answer.storeLabel}`}
                  />
                </div>
              ) : null}
            </div>
          );
        })}

        {checked ? (
          <Alert tone="info" title="What an update never writes">
            <ul className="space-y-1">
              {UPDATE_NEVER_WRITES.map((entry) => (
                <li key={entry.field} className="text-2xs text-ink-muted">
                  <strong className="text-ink">{entry.field}</strong> — {entry.why}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-2xs text-ink-subtle">
              Matching is by <Code>SKU</Code>. A SKU that matches more than one product on the site
              is refused for that row and touches neither product.
            </p>
          </Alert>
        ) : null}
      </div>
    </Panel>
  );
}

/** True when every selected site has been checked — the Start gate. */
export function everyStoreChecked(
  stores: ReadonlyArray<{ id: string }>,
  answers: Record<string, ExistingAnswer>,
): boolean {
  return stores.length > 0 && stores.every((store) => answers[store.id] !== undefined);
}
