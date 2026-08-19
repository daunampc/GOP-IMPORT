"use client";

import { useMemo, useState } from "react";

import {
  Alert,
  AlertList,
  Badge,
  Button,
  Code,
  DataTable,
  EmptyState,
  Field,
  Icon,
  Input,
  Panel,
  Segmented,
  Select,
  Stat,
  Tooltip,
  cn,
  foldVietnamese,
  type Column,
} from "@/components/ui";
import { CURRENCY_DISCLAIMER, formatMoney, formatNumber, formatSeconds } from "@/lib/format";
import { WRITE_MODE_LABELS, writesOverExisting } from "@/lib/import-options";
import type { PreviewMeta, PreviewRow, RowEdit } from "@/lib/preview";
import type { Estimate } from "@/lib/stats";
import type { PublicStore } from "@/lib/stores";

import { ExistingCheck, everyStoreChecked, type ExistingAnswer } from "./existing-check";
import { ImageCheck } from "./image-check";

/**
 * The preview-and-run step.
 *
 * The previous build showed the first 20 rows across 7 columns, with images and
 * variations reduced to counts — so "what you see is what gets published" held
 * for those 20 rows and no others.
 *
 * This is the WHOLE list: paginated, sortable, filterable down to rows with
 * warnings, searchable by SKU or name, with every row openable in detail and
 * correctable or droppable before anything runs.
 */

type RowFilter = "all" | "issues" | "edited" | "dropped";

/**
 * A Date as `<input type="datetime-local">` wants it: local wall time, no zone.
 *
 * Hand-assembled rather than sliced off `toISOString()`, which would silently
 * shift the value by the reader's UTC offset — an operator in Vietnam picking 9am
 * would get a run at 4pm the previous day.
 */
function toLocalInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Back the other way: the field's local wall time to an absolute instant.
 *
 * `new Date("2026-08-18T09:00")` with no zone suffix is interpreted in the
 * BROWSER's zone, which is exactly what is wanted — the operator means nine in
 * the morning where they are — and `toISOString()` then makes that unambiguous
 * for the server.
 */
function isoFromLocal(local: string): string | null {
  if (local === "") {
    return null;
  }

  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function ReviewStep({
  preview,
  estimate,
  stores,
  dropped,
  edits,
  onOpenRow,
  onDrop,
  onStart,
  starting,
  startError,
  currency,
  existing,
  onExisting,
}: {
  preview: PreviewMeta;
  estimate: Estimate;
  stores: PublicStore[];
  dropped: ReadonlySet<number>;
  edits: Record<string, RowEdit>;
  onOpenRow: (row: PreviewRow) => void;
  onDrop: (index: number, dropped: boolean) => void;
  /**
   * `null` means start now; an ISO 8601 string schedules it.
   *
   * `everyMinutes` turns it into a repeating series instead — §6 C2 — in which case
   * the string is when the FIRST occurrence is due.
   */
  onStart: (scheduledFor: string | null, everyMinutes?: number) => void;
  starting: boolean;
  startError: string | null;
  /** For display only — see `formatMoney`. Never sent to a site. */
  currency: string;
  /** Answers from `/api/import/exists`, keyed by store id. Held by the wizard. */
  existing: Record<string, ExistingAnswer>;
  onExisting: (next: Record<string, ExistingAnswer>) => void;
}) {
  const [filter, setFilter] = useState<RowFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [when, setWhen] = useState<"now" | "later" | "repeat">("now");
  /** Interval for a repeating series. A day is the case this exists for. */
  const [everyMinutes, setEveryMinutes] = useState(1440);
  const [localWhen, setLocalWhen] = useState("");
  const [minLocalWhen, setMinLocalWhen] = useState("");

  /*
   * Both of these are read from the clock, and the clock is touched in an EVENT
   * HANDLER rather than during render — twice over deliberately.
   *
   * Calling `Date.now()` in a render body is a lint error here, not a warning
   * (`react-hooks/purity`), and rendering anything derived from "now" during SSR
   * gives the server one value and the first client render another, which React
   * reports as hydration error #418. Switching to "later" is a click, so by then
   * there is a browser, a real clock and no server render to disagree with.
   *
   * Seeding the field with an hour from now also means it opens on something
   * sensible rather than empty.
   */
  function chooseLater() {
    const now = Date.now();

    setMinLocalWhen(toLocalInput(new Date(now + 60_000)));

    if (localWhen === "") {
      setLocalWhen(toLocalInput(new Date(now + 60 * 60_000)));
    }

    setWhen("later");
  }

  const withIssues = preview.rows.filter((row) => row.issues.length > 0).length;
  const remaining = preview.total - dropped.size;

  const overwrites = writesOverExisting(preview.options.writeMode);
  const startAllowed = !overwrites || everyStoreChecked(stores, existing);

  const rows = useMemo(() => {
    const needle = foldVietnamese(query.trim());

    return preview.rows.filter((row) => {
      if (filter === "issues" && row.issues.length === 0) {
        return false;
      }
      if (filter === "edited" && edits[String(row.index)] === undefined) {
        return false;
      }
      if (filter === "dropped" && !dropped.has(row.index)) {
        return false;
      }

      if (needle === "") {
        return true;
      }

      return foldVietnamese(`${row.name} ${row.sku} ${row.slug}`).includes(needle);
    });
  }, [preview.rows, filter, query, edits, dropped]);

  const columns = useMemo<Column<PreviewRow>[]>(
    () => [
      {
        key: "index",
        header: "#",
        width: "4rem",
        align: "right",
        sortable: true,
        sortValue: (row) => row.index,
        cell: (row) => <span className="tnum text-xs text-ink-subtle">{row.index + 1}</span>,
      },
      {
        key: "name",
        header: "Product name",
        sortable: true,
        sortValue: (row) => row.name,
        cell: (row) => (
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 truncate text-sm",
                dropped.has(row.index) ? "text-ink-subtle line-through" : "text-ink",
              )}
            >
              {row.name || <span className="text-bad-fg">(no name)</span>}
            </span>
            {edits[String(row.index)] ? (
              <Tooltip content="This row was corrected by hand before running">
                <Icon name="edit" className="size-3.5 shrink-0 text-accent-fg" />
              </Tooltip>
            ) : null}
          </div>
        ),
      },
      {
        key: "sku",
        header: "SKU",
        sortable: true,
        sortValue: (row) => row.sku,
        hideBelow: "sm",
        cell: (row) => (
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-ink-muted">{row.sku || "—"}</span>
            {row.generatedSku ? (
              // Say so on the row itself. A SKU that appeared from nowhere is
              // exactly the kind of thing nobody notices until it is on a site.
              <Tooltip content="Generated here — the source row had no SKU">
                <Badge tone="accent">auto</Badge>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        key: "type",
        header: "Type",
        width: "6rem",
        sortable: true,
        sortValue: (row) => row.type,
        hideBelow: "md",
        cell: (row) => (
          <Badge tone={row.type === "variable" ? "accent" : "neutral"}>{row.type}</Badge>
        ),
      },
      {
        key: "price",
        header: "Price",
        align: "right",
        width: "8rem",
        sortable: true,
        sortValue: (row) => Number.parseFloat(row.price) || 0,
        hideBelow: "md",
        // Formatted for READING only. The number published is `row.price`
        // unchanged — the symbol is a label, not arithmetic.
        cell: (row) => (
          <span className="tnum text-xs">
            {row.price === "" ? "—" : formatMoney(row.price, currency)}
          </span>
        ),
      },
      {
        key: "images",
        header: "Images",
        align: "right",
        width: "5rem",
        sortable: true,
        sortValue: (row) => row.images,
        hideBelow: "lg",
        cell: (row) => (
          <span className={cn("tnum text-xs", row.images === 0 && "text-warn-fg")}>
            {row.images}
          </span>
        ),
      },
      {
        key: "variations",
        header: "Variations",
        align: "right",
        width: "6rem",
        sortable: true,
        sortValue: (row) => row.variations,
        hideBelow: "lg",
        cell: (row) => <span className="tnum text-xs">{row.variations}</span>,
      },
      {
        key: "issues",
        header: "Warnings",
        width: "9rem",
        sortable: true,
        sortValue: (row) => row.issues.length,
        cell: (row) =>
          row.issues.length === 0 ? (
            <span className="text-2xs text-ink-subtle">—</span>
          ) : (
            <Tooltip content={row.issues.join(" · ")}>
              <Badge tone="warn" icon="alert-triangle">
                {row.issues.length}
              </Badge>
            </Tooltip>
          ),
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        width: "8rem",
        cell: (row) => (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" icon="search" onClick={() => onOpenRow(row)}>
              Detail
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={dropped.has(row.index) ? "refresh" : "trash"}
              onClick={() => onDrop(row.index, !dropped.has(row.index))}
              aria-label={
                dropped.has(row.index)
                  ? `Put row ${row.index + 1} back`
                  : `Drop row ${row.index + 1}`
              }
            />
          </div>
        ),
      },
    ],
    [dropped, edits, onOpenRow, onDrop, currency],
  );

  return (
    <div className="space-y-5">
      {/* -------------------------------------------------------------- Estimate */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Products to publish"
          value={formatNumber(remaining)}
          icon="package"
          hint={
            dropped.size > 0
              ? `${formatNumber(dropped.size)} row(s) dropped`
              : `of ${formatNumber(preview.total)} rows read`
          }
          tone={remaining === 0 ? "bad" : "neutral"}
        />
        <Stat
          label="Images to handle"
          value={formatNumber(preview.images)}
          icon="image"
          hint="deduplicated, variation images included"
        />
        <Stat
          label="Batches"
          value={formatNumber(estimate.batches)}
          icon="layers"
          hint={`${preview.options.batchSize} per batch · ${preview.options.threads} in parallel`}
        />
        <Stat
          label="Estimated per site"
          value={formatSeconds(estimate.seconds)}
          icon="clock"
          tone={estimate.basis === "measured" ? "neutral" : "warn"}
          hint={
            estimate.basis === "measured"
              ? "based on speeds measured from history"
              : "a rough guess — no history to measure yet"
          }
        />
      </section>

      {/* -------------------------------------------------------------- Warnings */}
      {preview.warnings.length > 0 ? (
        <Alert tone="warn" title={`${preview.warnings.length} thing(s) worth checking`}>
          <AlertList items={preview.warnings} />
        </Alert>
      ) : null}

      {preview.errors.length > 0 ? (
        <Alert tone="bad" title={`${preview.errors.length} error(s) reading the file`}>
          <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-4">
            {preview.errors.slice(0, 50).map((error, index) => (
              <li key={`${error.row}-${index}`}>
                Row {error.row}: {error.message}
              </li>
            ))}
          </ul>
          {preview.errors.length > 50 ? (
            <p className="mt-1">…and {preview.errors.length - 50} more.</p>
          ) : null}
        </Alert>
      ) : null}

      {preview.duplicateSkus.length > 0 ? (
        <Alert
          tone={preview.options.skipRepeatedSku ? "info" : "warn"}
          title={`${preview.duplicateSkus.length} SKU(s) appear on more than one row`}
        >
          <p>
            {preview.options.skipRepeatedSku
              ? '"Skip repeated SKUs" is on, so the repeats have already been dropped from this run.'
              : '"Skip repeated SKUs" is off — every row will be published, and the site will end up with several products sharing a SKU.'}
          </p>
          <p className="mt-1">
            For example:{" "}
            {preview.duplicateSkus.slice(0, 5).map((entry) => (
              <Code key={entry.sku} className="mr-1">
                {entry.sku}
              </Code>
            ))}
          </p>
        </Alert>
      ) : null}

      {/* ----------------------------------------------------------------- Table */}
      <Panel
        title="Review every row"
        icon="file"
        description={`${preview.sourceLabel}${preview.dialect ? ` · ${preview.dialect} format` : ""}`}
        padded={false}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              icon="search"
              placeholder="Search by name or SKU…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search the preview"
              className="h-8 w-56 text-xs"
            />
            <Segmented
              label="Filter rows"
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All (${preview.total})` },
                { value: "issues", label: `Warnings (${withIssues})`, icon: "alert-triangle" },
                {
                  value: "edited",
                  label: `Edited (${Object.keys(edits).length})`,
                  icon: "edit",
                },
                { value: "dropped", label: `Dropped (${dropped.size})`, icon: "trash" },
              ]}
            />
          </div>
        }
      >
        <DataTable
          caption="The products that will be published"
          rows={rows}
          columns={columns}
          rowKey={(row) => String(row.index)}
          defaultSort={{ key: "index", direction: "asc" }}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          onRowClick={onOpenRow}
          rowTone={(row) =>
            dropped.has(row.index) ? "bad" : row.issues.length > 0 ? "warn" : "none"
          }
          empty={
            <EmptyState
              icon="search"
              title="No row matches the filter"
              description="Change the search term, or pick a different filter above."
              action={
                <Button
                  variant="secondary"
                  icon="refresh"
                  onClick={() => {
                    setFilter("all");
                    setQuery("");
                  }}
                >
                  Clear the filter
                </Button>
              }
            />
          }
        />

        {/*
          Said under the table where the prices actually are, not only on the
          Settings screen where the choice was made. A symbol in a column is
          exactly the kind of thing that gets read as "this is what the shop will
          charge in", and it is not.
        */}
        {currency !== "" ? (
          <p className="border-t border-line px-3 py-2 text-2xs text-ink-subtle">
            {CURRENCY_DISCLAIMER}
          </p>
        ) : null}
      </Panel>

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent-border bg-accent-soft px-3 py-2">
          <span className="tnum text-xs font-medium text-accent-fg">
            {selected.size} rows selected
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon="trash"
            onClick={() => {
              for (const key of selected) {
                onDrop(Number(key), true);
              }
              setSelected(new Set());
            }}
          >
            Drop the selected rows
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="refresh"
            onClick={() => {
              for (const key of selected) {
                onDrop(Number(key), false);
              }
              setSelected(new Set());
            }}
          >
            Put them back
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="x"
            className="ml-auto"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}

      {/* ------------------------------------------- Already on the site (§2.4) */}
      {writesOverExisting(preview.options.writeMode) ? (
        <ExistingCheck
          previewId={preview.id}
          stores={stores}
          writeMode={preview.options.writeMode}
          answers={existing}
          onAnswers={onExisting}
          currency={currency}
        />
      ) : null}

      {/* ------------------------------------------------ Do the links work (§6 C4) */}
      {preview.images > 0 ? (
        <ImageCheck
          previewId={preview.id}
          images={preview.images}
          imageMode={preview.options.imageMode}
        />
      ) : null}

      {/* ------------------------------------------------------------------- Run */}
      <Panel title="Run this batch" icon="play">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink-muted">This creates</span>
            <Badge tone="accent" icon="activity">
              {stores.length} run(s)
            </Badge>
            <span className="text-sm text-ink-muted">— one per site:</span>
            {stores.map((store) => (
              <Badge key={store.id} tone="neutral" icon="store">
                {store.label || store.url}
              </Badge>
            ))}
          </div>

          {remaining === 0 ? (
            <Alert tone="bad" title="There is nothing left to run">
              Every row has been dropped. Put at least one back before starting.
            </Alert>
          ) : null}

          {startError ? (
            <Alert tone="bad" title="Could not queue the run">
              {startError}
            </Alert>
          ) : null}

          <Segmented
            label="When to run this batch"
            value={when}
            onChange={(next) => {
              if (next === "later" || next === "repeat") {
                chooseLater();
              }

              setWhen(next as "now" | "later" | "repeat");
            }}
            options={[
              { value: "now", label: "Start now", icon: "play" },
              { value: "later", label: "Start later", icon: "clock" },
              { value: "repeat", label: "Repeat", icon: "refresh" },
            ]}
          />

          {when === "repeat" ? (
            <div className="space-y-3 rounded-md border border-line bg-surface-sunken p-3">
              <Field
                label="First run at"
                htmlFor="firstRunAt"
                hint="Your own clock. Every occurrence after this one is one interval later, counted from this time rather than from when the last one happened."
              >
                <Input
                  id="firstRunAt"
                  type="datetime-local"
                  value={localWhen}
                  min={minLocalWhen === "" ? undefined : minLocalWhen}
                  onChange={(event) => setLocalWhen(event.target.value)}
                  className="max-w-64"
                />
              </Field>

              <Field label="Then every" htmlFor="everyMinutes">
                <Select
                  id="everyMinutes"
                  value={String(everyMinutes)}
                  onChange={(event) => setEveryMinutes(Number(event.target.value))}
                  className="max-w-64"
                >
                  <option value="60">Hour</option>
                  <option value="360">6 hours</option>
                  <option value="720">12 hours</option>
                  <option value="1440">Day</option>
                  <option value="10080">Week</option>
                </Select>
              </Field>

              {/*
                The sentence that stops this being mistaken for something it is not.
                Everything else on this screen rests on "the preview is a contract";
                a repeat re-sends that contract, it does not go and look at the file
                again — and somebody expecting a nightly feed to be picked up would
                otherwise find out weeks later.
              */}
              <Alert tone="warn" title="It re-sends THIS data, every time">
                The {formatNumber(remaining)} products are staged with the series now. Every
                occurrence publishes exactly these — it does not re-read the file, so a new export
                tomorrow will not be picked up. That makes it right for keeping a shop matching a
                price list, and wrong for a feed that changes.
                <span className="mt-1 block">
                  One series goes to one site. Each occurrence appears under{" "}
                  <strong>Scheduled</strong> as an ordinary run with its own results and its own
                  Cancel, and the series itself can be paused or deleted on the Activity screen.
                  Missed occurrences — a server that was off — are skipped rather than fired in a
                  burst afterwards.
                </span>
              </Alert>
            </div>
          ) : null}

          {when === "later" ? (
            <div className="space-y-3 rounded-md border border-line bg-surface-sunken p-3">
              <Field
                label="Start at"
                htmlFor="scheduledFor"
                hint="Your own clock. The run fires at this time whether or not anyone is signed in."
              >
                <Input
                  id="scheduledFor"
                  type="datetime-local"
                  value={localWhen}
                  min={minLocalWhen === "" ? undefined : minLocalWhen}
                  onChange={(event) => setLocalWhen(event.target.value)}
                  className="max-w-64"
                />
              </Field>

              <Alert tone="info" title="A scheduled run does not depend on this preview">
                The {formatNumber(remaining)} products are staged in the database the moment you
                schedule it, in the same write as the run itself. Previews expire after an hour; this
                does not. Close the tab, sign out, restart the server — it still runs.
                <span className="mt-1 block">
                  It appears under <strong>Scheduled</strong> on the Activity screen until then,
                  where it can be moved or cancelled. The account&rsquo;s import permission is checked
                  again when it fires, so a run scheduled today can still be refused tomorrow.
                </span>
              </Alert>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="lg"
              icon={when === "now" ? "play" : when === "later" ? "clock" : "refresh"}
              loading={starting}
              disabled={
                remaining === 0 ||
                stores.length === 0 ||
                (when !== "now" && localWhen === "") ||
                // In the write modes the site MUST have been read first. The
                // number of rows already there is what decides what this run
                // does, and a preview whose most consequential number is
                // optional is a preview that number gets skipped in.
                !startAllowed
              }
              onClick={() =>
                onStart(
                  when === "now" ? null : isoFromLocal(localWhen),
                  when === "repeat" ? everyMinutes : undefined,
                )
              }
            >
              {when === "now"
                ? `Publish ${formatNumber(remaining)} products`
                : when === "later"
                  ? `Schedule ${formatNumber(remaining)} products`
                  : `Repeat ${formatNumber(remaining)} products`}
            </Button>

            <p className="text-xs text-ink-subtle">
              {startAllowed ? (
                <>
                  The job goes to the queue and the worker takes it from there. Closing the tab or
                  restarting the web process stops neither.
                </>
              ) : (
                <>
                  Press <strong className="text-ink">Check the site</strong> above first. In{" "}
                  <strong className="text-ink">
                    {WRITE_MODE_LABELS[preview.options.writeMode]}
                  </strong>{" "}
                  mode this run writes over products that are already on sale, and how many of them
                  there are is not known until the site has been read.
                </>
              )}
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
