"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { cn } from "./cn";
import { foldVietnamese, type ComboboxOption } from "./combobox";
import { Icon } from "./icon";
import { Spinner } from "./spinner";
import { useDismiss } from "./use-dismiss";

/**
 * A multi-value input with suggestions from the site's real data.
 *
 * The point that matters for categories and tags: every chosen value has to say
 * whether it **already exists on the site** or **will be created**. The plugin
 * resolves terms by name, so typing "T-Shirts" when the site has "T-shirts"
 * quietly creates a second term. Without this cue nobody notices until they
 * open wp-admin.
 */
export function TagInput({
  values,
  onChange,
  suggestions = [],
  placeholder = "Type and press Enter to add…",
  loading = false,
  disabled = false,
  allowCreate = true,
  createHint = "will be created",
  id,
  describedBy,
  className,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions?: ReadonlyArray<ComboboxOption>;
  placeholder?: string;
  loading?: boolean;
  disabled?: boolean;
  allowCreate?: boolean;
  createHint?: string;
  id?: string;
  describedBy?: string;
  className?: string;
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const listId = `${fieldId}-list`;

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);

  const known = useMemo(
    () => new Map(suggestions.map((option) => [foldVietnamese(option.label), option])),
    [suggestions],
  );

  const matches = useMemo(() => {
    const chosen = new Set(values.map(foldVietnamese));
    const needle = foldVietnamese(query.trim());

    return suggestions.filter((option) => {
      if (chosen.has(foldVietnamese(option.label))) {
        return false;
      }
      return needle === "" || foldVietnamese(option.label).includes(needle);
    });
  }, [suggestions, values, query]);

  const trimmed = query.trim();
  const exactExists = matches.some(
    (option) => foldVietnamese(option.label) === foldVietnamese(trimmed),
  );
  const alreadyChosen = values.some(
    (value) => foldVietnamese(value) === foldVietnamese(trimmed),
  );
  const canCreate = allowCreate && trimmed !== "" && !exactExists && !alreadyChosen;

  // The "create" entry always sits last in the suggestions, and is reachable by keyboard.
  const rowCount = matches.length + (canCreate ? 1 : 0);

  useDismiss(rootRef, () => setOpen(false), open);

  useEffect(() => {
    if (!open) {
      return;
    }
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  function add(label: string) {
    const value = label.trim();
    if (value === "") {
      return;
    }
    if (values.some((current) => foldVietnamese(current) === foldVietnamese(value))) {
      setQuery("");
      return;
    }
    onChange([...values, value]);
    setQuery("");
    setCursor(0);
  }

  function remove(index: number) {
    onChange(values.filter((_value, position) => position !== index));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (rowCount === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor((current) => (current + step + rowCount) % rowCount);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (open && cursor < matches.length) {
        add(matches[cursor].label);
      } else if (canCreate) {
        add(trimmed);
      }
      return;
    }

    // Comma as a separator: the habit comes from writing several categories on one line.
    if (event.key === "," || event.key === "Tab") {
      if (trimmed !== "") {
        event.preventDefault();
        add(trimmed);
      }
      return;
    }

    if (event.key === "Backspace" && query === "" && values.length > 0) {
      event.preventDefault();
      remove(values.length - 1);
    }
  }

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border bg-field px-2 py-1.5 transition-colors duration-fast",
          disabled
            ? "cursor-not-allowed bg-surface-sunken"
            : "cursor-text border-field-line hover:border-field-line-strong",
        )}
      >
        {values.map((value, index) => {
          const existing = known.get(foldVietnamese(value));

          return (
            <span
              key={`${value}-${index}`}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs",
                existing
                  ? "border-line bg-surface-sunken text-ink"
                  : "border-accent-border bg-accent-soft text-accent-fg",
              )}
            >
              <Icon name={existing ? "check" : "plus"} className="size-3 shrink-0" />
              <span className="truncate">{value}</span>
              {existing?.meta ? (
                <span className="tnum shrink-0 text-2xs text-ink-subtle">{existing.meta}</span>
              ) : (
                <span className="shrink-0 text-2xs opacity-80">{createHint}</span>
              )}
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${value}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(index);
                  }}
                  className="grid size-4 shrink-0 place-items-center rounded-xs transition-colors duration-fast hover:bg-surface-raised"
                >
                  <Icon name="x" className="size-2.5" />
                </button>
              ) : null}
            </span>
          );
        })}

        <input
          ref={inputRef}
          id={fieldId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={describedBy}
          autoComplete="off"
          disabled={disabled}
          value={query}
          placeholder={values.length === 0 ? placeholder : ""}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-6 min-w-32 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle disabled:cursor-not-allowed"
        />

        {loading ? <Spinner className="text-ink-subtle" label="Loading categories" /> : null}
      </div>

      {open && rowCount > 0 ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-72 w-full animate-rise overflow-y-auto rounded-md border border-line bg-surface-raised p-1 shadow-lg"
        >
          {matches.map((option, index) => (
            <li
              key={option.value}
              data-index={index}
              role="option"
              aria-selected={index === cursor}
              onPointerDown={(event) => {
                event.preventDefault();
                add(option.label);
              }}
              onPointerEnter={() => setCursor(index)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                index === cursor ? "bg-accent-soft text-accent-fg" : "text-ink",
              )}
              style={{ paddingLeft: `${0.5 + (option.depth ?? 0) * 0.875}rem` }}
            >
              <Icon name="tag" className="size-3.5 shrink-0 opacity-60" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.meta ? (
                <span className="tnum shrink-0 text-2xs text-ink-subtle">{option.meta}</span>
              ) : null}
            </li>
          ))}

          {canCreate ? (
            <li
              data-index={matches.length}
              role="option"
              aria-selected={cursor === matches.length}
              onPointerDown={(event) => {
                event.preventDefault();
                add(trimmed);
              }}
              onPointerEnter={() => setCursor(matches.length)}
              className={cn(
                "mt-1 flex cursor-pointer items-center gap-2 rounded-sm border-t border-line px-2 py-1.5 text-sm",
                cursor === matches.length ? "bg-accent-soft text-accent-fg" : "text-ink",
              )}
            >
              <Icon name="plus" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                Create “{trimmed}”
              </span>
              <span className="shrink-0 text-2xs text-ink-subtle">Enter</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
