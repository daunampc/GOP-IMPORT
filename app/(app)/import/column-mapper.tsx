"use client";

import { useState } from "react";

import { Alert, Badge, Button, Icon, Select, Switch, cn } from "@/components/ui";
// From the dialect module, not `csv.ts`: this is a Client Component and has no
// need of papaparse or any parser.
import { CSV_FIELDS, DIALECT_META, DIALECT_ORDER, type KnownDialect } from "@/lib/sources/csv-dialect";

/**
 * CSV column mapping.
 *
 * `detectDialect()` guesses from the column names; a wrong guess used to be a
 * dead end, with no way to say "my `Giá bán` column IS `Regular price`". A
 * Shopbase export, or a file opened and re-saved in a localised Excel, both
 * land in exactly that case.
 *
 * A mapping is remembered against the SIGNATURE of the column set, so the next
 * export of the same shape applies it automatically — see
 * `/api/import/csv-map`.
 */
export function ColumnMapper({
  columns,
  dialect,
  onDialectChange,
  columnMap,
  onColumnMapChange,
  remember,
  onRememberChange,
  savedAt,
  disabled,
}: {
  columns: string[];
  dialect: KnownDialect;
  onDialectChange: (next: KnownDialect) => void;
  columnMap: Record<string, string>;
  onColumnMapChange: (next: Record<string, string>) => void;
  remember: boolean;
  onRememberChange: (next: boolean) => void;
  savedAt: string | null;
  disabled?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);

  const fields = CSV_FIELDS[dialect];
  const present = new Set(columns);

  // By default only the fields that NEED attention: required ones, ones mapped
  // by hand, and ones with no matching column. All eighteen rows at once is a
  // list nobody reads.
  const visible = showAll
    ? fields
    : fields.filter(
        (field) => field.required || columnMap[field.key] !== undefined || !present.has(field.key),
      );

  const missingRequired = fields.filter(
    (field) => field.required && !present.has(field.key) && !columnMap[field.key],
  );

  function set(key: string, value: string) {
    const next = { ...columnMap };
    if (value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onColumnMapChange(next);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink-muted">Read the file as</span>
          <Select
            value={dialect}
            disabled={disabled}
            aria-label="CSV format"
            onChange={(event) => onDialectChange(event.target.value as KnownDialect)}
            className="h-8 w-56 text-xs"
          >
            {/*
              Driven from DIALECT_ORDER rather than hard-coded, which is how Etsy and
              Custom appeared here without anybody having to remember this list. Two
              of the four used to be missing outright.
            */}
            {DIALECT_ORDER.map((option) => (
              <option key={option} value={option}>
                {DIALECT_META[option].label} — {DIALECT_META[option].hint}
              </option>
            ))}
          </Select>
        </div>

        <Badge tone="neutral" icon="file">
          {columns.length} columns read
        </Badge>
      </div>

      {missingRequired.length > 0 ? (
        <Alert tone="warn" title="A required column is unmapped">
          {missingRequired.map((field) => `“${field.label}”`).join(", ")} could not be mapped. The
          preview will skip or reject the rows that are missing them.
        </Alert>
      ) : null}

      <div className="scroll-frame -mx-4 px-4">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <caption className="sr-only">Mapping of file columns to data fields</caption>
          <thead>
            <tr className="border-b border-line">
              <th
                scope="col"
                className="py-2 pr-3 text-left text-2xs font-semibold tracking-wide text-ink-subtle uppercase"
              >
                Data field
              </th>
              <th
                scope="col"
                className="py-2 pr-3 text-left text-2xs font-semibold tracking-wide text-ink-subtle uppercase"
              >
                Column in the file
              </th>
              <th
                scope="col"
                className="py-2 text-left text-2xs font-semibold tracking-wide text-ink-subtle uppercase"
              >
                State
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((field) => {
              const mapped = columnMap[field.key];
              const auto = present.has(field.key);
              const resolved = mapped ?? (auto ? field.key : null);

              return (
                <tr key={field.key} className="border-b border-line last:border-0">
                  <td className="py-2 pr-3 align-middle">
                    <span className="block text-sm text-ink">{field.label}</span>
                    <span className="block font-mono text-2xs text-ink-subtle">
                      {field.key}
                      {field.required ? " · required" : ""}
                    </span>
                  </td>

                  <td className="py-2 pr-3 align-middle">
                    <Select
                      value={mapped ?? ""}
                      disabled={disabled}
                      aria-label={`Column used for ${field.label}`}
                      onChange={(event) => set(field.key, event.target.value)}
                      className="h-8 text-xs"
                    >
                      <option value="">
                        {auto ? `Auto-detected: ${field.key}` : "— not chosen —"}
                      </option>
                      {columns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </Select>
                  </td>

                  <td className="py-2 align-middle">
                    {resolved === null ? (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-2xs",
                          field.required ? "text-bad-fg" : "text-ink-subtle",
                        )}
                      >
                        <Icon name={field.required ? "alert-circle" : "minus"} className="size-3" />
                        {field.required ? "Missing" : "Unset"}
                      </span>
                    ) : mapped ? (
                      <span className="inline-flex items-center gap-1 text-2xs text-accent-fg">
                        <Icon name="link" className="size-3" />
                        Mapped by hand
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-2xs text-ok-fg">
                        <Icon name="check" className="size-3" />
                        Auto-detected
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <Button
          variant="ghost"
          size="sm"
          icon={showAll ? "chevron-up" : "chevron-down"}
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll ? "Show only what needs attention" : `Show all ${fields.length} fields`}
        </Button>

        <Switch
          size="sm"
          label="Remember this mapping for files of the same shape"
          description={
            savedAt
              ? "A saved mapping for this column set is in use."
              : "Remembered against the file's column set, not the individual file."
          }
          checked={remember}
          disabled={disabled}
          onChange={onRememberChange}
        />
      </div>
    </div>
  );
}
