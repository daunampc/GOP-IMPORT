"use client";

import { useId, useRef, type ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** A small count to the right of the label, e.g. failed rows. */
  count?: number;
  disabled?: boolean;
}

/**
 * Thanh tab.
 *
 * Follows the WAI-ARIA tablist pattern: only the selected tab is in the tab
 * order, and left/right arrows move between tabs. Pressing Tab seven times to
 * cross seven tabs is the wrong behaviour.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  size = "md",
  className,
}: {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (next: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const usable = items.filter((item) => !item.disabled);
    if (usable.length === 0) {
      return;
    }

    const current = usable.findIndex((item) => item.value === value);
    let next = current;

    if (event.key === "ArrowRight") {
      next = (current + 1) % usable.length;
    } else if (event.key === "ArrowLeft") {
      next = (current - 1 + usable.length) % usable.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = usable.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    onChange(usable[next].value);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-value="${usable[next].value}"]`)
      ?.focus();
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn(
        "scroll-frame flex gap-1 border-b border-line",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;

        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${id}-tab-${item.value}`}
            data-value={item.value}
            aria-selected={active}
            aria-controls={`${id}-panel-${item.value}`}
            tabIndex={active ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={cn(
              "relative -mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 font-medium whitespace-nowrap transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-40",
              size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm",
              active
                ? "border-accent text-accent-fg"
                : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {item.icon ? <Icon name={item.icon} className="size-3.5" /> : null}
            {item.label}
            {typeof item.count === "number" ? (
              <span
                className={cn(
                  "tnum rounded-full px-1.5 py-0.5 text-2xs",
                  active ? "bg-accent-soft text-accent-fg" : "bg-surface-sunken text-ink-subtle",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  id,
  value,
  active,
  className,
  children,
}: {
  /** The same `id` given to `Tabs`, used to wire up `aria-labelledby`. */
  id: string;
  value: string;
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (!active) {
    return null;
  }

  return (
    <div
      role="tabpanel"
      id={`${id}-panel-${value}`}
      aria-labelledby={`${id}-tab-${value}`}
      tabIndex={0}
      className={cn("animate-fade-in focus-visible:outline-none", className)}
    >
      {children}
    </div>
  );
}
