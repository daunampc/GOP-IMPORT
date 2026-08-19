"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "./cn";
import { Icon } from "./icon";
import { Spinner } from "./spinner";
import { useDismiss } from "./use-dismiss";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Depth in the hierarchy, used for indentation. 0 is a root. */
  depth?: number;
  /** Secondary text on the right, e.g. "12 products". */
  meta?: string;
  description?: string;
  disabled?: boolean;
}

/** Diacritic-insensitive matching — typing "ao thun" has to find "Áo Thun". */
export function foldVietnamese(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * A searchable single-value picker.
 *
 * Built to the WAI-ARIA combobox pattern: the input keeps focus the whole time
 * it is open, and the highlighted option is announced through
 * `aria-activedescendant` rather than by moving focus — moving focus into the
 * list would take the caret away from the text being typed.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  emptyLabel = "Nothing matches",
  loading = false,
  disabled = false,
  clearable = false,
  invalid = false,
  id,
  describedBy,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<ComboboxOption>;
  placeholder?: string;
  emptyLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  invalid?: boolean;
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

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const matches = useMemo(() => {
    if (query.trim() === "") {
      return options;
    }
    const needle = foldVietnamese(query.trim());
    return options.filter((option) => foldVietnamese(option.label).includes(needle));
  }, [options, query]);

  // Close and clear the query in the SAME action, rather than letting an effect
  // watch `open` and clean up afterwards — that would add a render with the
  // list already shut but the old text still in the box.
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  useDismiss(rootRef, close, open);

  // The highlighted option has to stay in view while arrowing through.
  useEffect(() => {
    if (!open) {
      return;
    }
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, open]);

  function commit(option: ComboboxOption) {
    if (option.disabled) {
      return;
    }
    onChange(option.value);
    close();
    inputRef.current?.blur();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setCursor(0);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor((current) => {
        if (matches.length === 0) {
          return 0;
        }
        return (current + step + matches.length) % matches.length;
      });
      return;
    }

    if (event.key === "Enter" && open) {
      const option = matches[cursor];
      if (option) {
        event.preventDefault();
        commit(option);
      }
      return;
    }

    if (event.key === "Home" && open) {
      event.preventDefault();
      setCursor(0);
    }

    if (event.key === "End" && open) {
      event.preventDefault();
      setCursor(Math.max(0, matches.length - 1));
    }
  }

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <div
        className={cn(
          "flex h-9 items-center gap-1 rounded-md border bg-field pr-1 pl-3 transition-colors duration-fast",
          invalid ? "border-bad" : "border-field-line hover:border-field-line-strong",
          disabled && "cursor-not-allowed bg-surface-sunken",
        )}
      >
        <input
          ref={inputRef}
          id={fieldId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[cursor] ? `${listId}-${cursor}` : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          disabled={disabled}
          value={open ? query : (selected?.label ?? "")}
          placeholder={selected ? selected.label : placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle disabled:cursor-not-allowed"
        />

        {loading ? <Spinner className="mr-1 text-ink-subtle" label="Loading the list" /> : null}

        {clearable && selected && !disabled ? (
          <button
            type="button"
            aria-label="Clear the selection"
            onClick={() => {
              onChange("");
              close();
            }}
            className="grid size-7 place-items-center rounded-sm text-ink-subtle transition-colors duration-fast hover:bg-surface-sunken hover:text-ink"
          >
            <Icon name="x" className="size-3.5" />
          </button>
        ) : null}

        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "Close the list" : "Open the list"}
          disabled={disabled}
          onClick={() => {
            setOpen((current) => !current);
            inputRef.current?.focus();
          }}
          className="grid size-7 place-items-center rounded-sm text-ink-subtle transition-colors duration-fast hover:bg-surface-sunken hover:text-ink"
        >
          <Icon name={open ? "chevron-up" : "chevron-down"} className="size-3.5" />
        </button>
      </div>

      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-72 w-full animate-rise overflow-y-auto rounded-md border border-line bg-surface-raised p-1 shadow-lg"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-ink-subtle">{emptyLabel}</li>
          ) : (
            matches.map((option, index) => {
              const active = index === cursor;
              const chosen = option.value === value;

              return (
                <li
                  key={option.value}
                  id={`${listId}-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={chosen}
                  aria-disabled={option.disabled || undefined}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    commit(option);
                  }}
                  onPointerEnter={() => setCursor(index)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                    active ? "bg-accent-soft text-accent-fg" : "text-ink",
                    option.disabled && "cursor-not-allowed opacity-50",
                  )}
                  style={{ paddingLeft: `${0.5 + (option.depth ?? 0) * 0.875}rem` }}
                >
                  <Icon
                    name="check"
                    className={cn("size-3.5", chosen ? "opacity-100" : "opacity-0")}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                    {option.description ? (
                      <span className="block truncate text-2xs text-ink-subtle">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  {option.meta ? (
                    <span className="tnum shrink-0 text-2xs text-ink-subtle">{option.meta}</span>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** Wraps a list in a titled box — for when several groups are needed. */
export function ComboboxHint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-ink-subtle">{children}</p>;
}
