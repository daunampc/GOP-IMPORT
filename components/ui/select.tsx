"use client";

import type { ComponentProps } from "react";

import { cn } from "./cn";
import { CONTROL_BASE, CONTROL_BORDER, CONTROL_INVALID } from "./input";
import { Icon } from "./icon";

/**
 * The browser's own `<select>`, restyled and nothing more.
 *
 * Deliberately not a hand-built list of divs: the native control already has
 * keyboard navigation and type-ahead, and on mobile it opens the operating
 * system's picker. For search across a long list, use `Combobox`.
 */
export function Select({
  invalid,
  className,
  children,
  ...rest
}: { invalid?: boolean } & ComponentProps<"select">) {
  return (
    <div className="relative min-w-0">
      <select
        {...rest}
        aria-invalid={invalid || undefined}
        className={cn(
          CONTROL_BASE,
          invalid ? CONTROL_INVALID : CONTROL_BORDER,
          "h-9 appearance-none py-0 pr-9 pl-3 text-sm",
          className,
        )}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute inset-y-0 right-0 grid w-9 place-items-center text-ink-subtle">
        <Icon name="chevron-down" />
      </span>
    </div>
  );
}
