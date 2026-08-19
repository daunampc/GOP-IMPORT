"use client";

import { useId, useMemo, useState, type ReactNode } from "react";

import { Button, IconButton } from "./button";
import { Checkbox } from "./checkbox";
import { cn } from "./cn";
import { Icon } from "./icon";
import { Select } from "./select";
import { SkeletonTable } from "./skeleton";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  /** Enables sorting. Needs `sortValue` unless the cell is a plain string or number. */
  sortable?: boolean;
  sortValue?: (row: T) => string | number;
  align?: "left" | "right" | "center";
  /** A fixed width, e.g. "8rem". Leave empty and the column flexes. */
  width?: string;
  /** Hide the column on narrow screens rather than letting the table sprawl. */
  hideBelow?: "sm" | "md" | "lg" | "xl";
}

export type SortDirection = "asc" | "desc";

export interface SortState {
  key: string;
  direction: SortDirection;
}

const HIDE = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
} as const;

const ALIGN = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
} as const;

/**
 * The data table: sorting, pagination, multi-row selection.
 *
 * Always inside its own `scroll-frame` — a wide table scrolls horizontally
 * within that frame and does NOT push the page. This is what stops the layout
 * breaking at 1280px once a results table has many columns.
 *
 * Sorting and pagination are internal state; the selection is held by the
 * caller, because the bulk actions (cancel, resend, delete) live outside the
 * table.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  defaultSort,
  pageSize: initialPageSize = 25,
  pageSizeOptions = [25, 50, 100, 250],
  paginate = true,
  selectable = false,
  selected,
  onSelectedChange,
  onRowClick,
  rowTone,
  loading = false,
  empty,
  dense = false,
  className,
}: {
  rows: ReadonlyArray<T>;
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T, index: number) => string;
  /** Describes the table to a screen reader. Required — an unlabelled table is a mute one. */
  caption: string;
  defaultSort?: SortState;
  pageSize?: number;
  pageSizeOptions?: ReadonlyArray<number>;
  paginate?: boolean;
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelectedChange?: (next: Set<string>) => void;
  onRowClick?: (row: T) => void;
  /** A faint background tint reflecting the row's state. */
  rowTone?: (row: T) => "none" | "ok" | "warn" | "bad" | "accent";
  loading?: boolean;
  empty?: ReactNode;
  dense?: boolean;
  className?: string;
}) {
  const id = useId();
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null);
  const [rawPage, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const sorted = useMemo(() => {
    if (!sort) {
      return rows;
    }

    const column = columns.find((entry) => entry.key === sort.key);
    if (!column?.sortable) {
      return rows;
    }

    const read = column.sortValue ?? ((row: T) => String(column.cell(row, 0) ?? ""));
    const factor = sort.direction === "asc" ? 1 : -1;

    return [...rows].sort((left, right) => {
      const a = read(left);
      const b = read(right);

      if (typeof a === "number" && typeof b === "number") {
        return (a - b) * factor;
      }
      // `localeCompare` with the vi locale so "Ă" sorts beside "A" rather than at the end.
      return String(a).localeCompare(String(b), "vi") * factor;
    });
  }, [rows, columns, sort]);

  const pageCount = paginate ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;

  // Filtering rows can push the current page out of range. Clamped on READ
  // rather than synchronised by an effect: the valid page is derivable from the
  // row count and the page size, so keeping a second copy in state only buys an
  // extra render with a wrong value in the middle.
  const page = Math.min(rawPage, pageCount - 1);

  const visible = paginate ? sorted.slice(page * pageSize, page * pageSize + pageSize) : sorted;

  const visibleKeys = visible.map((row, index) => rowKey(row, index));
  const allSelected =
    selectable && visibleKeys.length > 0 && visibleKeys.every((key) => selected?.has(key));
  const someSelected = selectable && visibleKeys.some((key) => selected?.has(key));

  function toggleAll(next: boolean) {
    if (!onSelectedChange) {
      return;
    }
    const draft = new Set(selected ?? []);
    for (const key of visibleKeys) {
      if (next) {
        draft.add(key);
      } else {
        draft.delete(key);
      }
    }
    onSelectedChange(draft);
  }

  function toggleOne(key: string, next: boolean) {
    if (!onSelectedChange) {
      return;
    }
    const draft = new Set(selected ?? []);
    if (next) {
      draft.add(key);
    } else {
      draft.delete(key);
    }
    onSelectedChange(draft);
  }

  function onHeaderClick(column: Column<T>) {
    if (!column.sortable) {
      return;
    }
    setSort((current) => {
      if (current?.key !== column.key) {
        return { key: column.key, direction: "asc" };
      }
      return current.direction === "asc"
        ? { key: column.key, direction: "desc" }
        : null;
    });
    setPage(0);
  }

  if (loading) {
    return <SkeletonTable rows={6} columns={columns.length} className={cn("p-4", className)} />;
  }

  if (rows.length === 0 && empty) {
    return <>{empty}</>;
  }

  const cellPadding = dense ? "px-3 py-1.5" : "px-3 py-2.5";

  const TONES = {
    none: "",
    ok: "bg-ok-soft",
    warn: "bg-warn-soft",
    bad: "bg-bad-soft",
    accent: "bg-accent-soft",
  } as const;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="scroll-frame">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>

          <thead>
            <tr className="border-b border-line bg-surface-sunken">
              {selectable ? (
                <th scope="col" className={cn("w-10", cellPadding)}>
                  <Checkbox
                    label={<span className="sr-only">Select every visible row</span>}
                    checked={Boolean(allSelected)}
                    indeterminate={Boolean(someSelected)}
                    onChange={toggleAll}
                  />
                </th>
              ) : null}

              {columns.map((column) => {
                const active = sort?.key === column.key;

                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    aria-sort={
                      active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
                    }
                    className={cn(
                      "text-2xs font-semibold tracking-wide text-ink-subtle uppercase",
                      cellPadding,
                      ALIGN[column.align ?? "left"],
                      column.hideBelow && HIDE[column.hideBelow],
                    )}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => onHeaderClick(column)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-xs transition-colors duration-fast hover:text-ink",
                          column.align === "right" && "flex-row-reverse",
                          active && "text-accent-fg",
                        )}
                      >
                        <span className="truncate">{column.header}</span>
                        <Icon
                          name={
                            active
                              ? sort.direction === "asc"
                                ? "arrow-up"
                                : "arrow-down"
                              : "chevrons-up-down"
                          }
                          className={cn("size-3", !active && "opacity-40")}
                        />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {visible.map((row, index) => {
              const key = rowKey(row, index);
              const tone = rowTone?.(row) ?? "none";
              const isSelected = selected?.has(key) ?? false;

              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-b border-line last:border-0",
                    TONES[tone],
                    isSelected && "bg-accent-soft",
                    onRowClick && "cursor-pointer hover:bg-surface-sunken",
                  )}
                >
                  {selectable ? (
                    <td className={cellPadding} onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        label={<span className="sr-only">Select row {index + 1}</span>}
                        checked={isSelected}
                        onChange={(next) => toggleOne(key, next)}
                      />
                    </td>
                  ) : null}

                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        "min-w-0 align-middle text-ink",
                        cellPadding,
                        ALIGN[column.align ?? "left"],
                        column.hideBelow && HIDE[column.hideBelow],
                      )}
                    >
                      {column.cell(row, page * pageSize + index)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {paginate && sorted.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2">
          <p className="tnum text-xs text-ink-subtle">
            {page * pageSize + 1}–{Math.min(sorted.length, (page + 1) * pageSize)} of{" "}
            {sorted.length} rows
            {selectable && (selected?.size ?? 0) > 0 ? (
              <span className="ml-2 text-accent-fg">· {selected?.size} selected</span>
            ) : null}
          </p>

          <div className="flex items-center gap-2">
            <label htmlFor={`${id}-size`} className="text-xs text-ink-subtle">
              Per page
            </label>
            <Select
              id={`${id}-size`}
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(0);
              }}
              className="h-8 w-24 text-xs"
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>

            <div className="flex items-center gap-1">
              <IconButton
                label="First page"
                icon="chevrons-up-down"
                size="sm"
                className="rotate-90"
                disabled={page === 0}
                onClick={() => setPage(0)}
              />
              <IconButton
                label="Previous page"
                icon="chevron-left"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              />
              <span className="tnum px-1 text-xs text-ink-muted">
                {page + 1} / {pageCount}
              </span>
              <IconButton
                label="Trang sau"
                icon="chevron-right"
                size="sm"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The bulk-action bar, shown once rows are selected. */
export function BulkBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children: ReactNode;
}) {
  if (count === 0) {
    return null;
  }

  return (
    <div className="flex animate-rise flex-wrap items-center gap-2 border-b border-accent-border bg-accent-soft px-3 py-2">
      <span className="tnum text-xs font-medium text-accent-fg">{count} rows selected</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <Button variant="ghost" size="sm" icon="x" onClick={onClear} className="ml-auto">
        Clear
      </Button>
    </div>
  );
}
