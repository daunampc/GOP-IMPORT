"use client";

import type { ComponentProps, ReactNode } from "react";

import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

export const CONTROL_BASE =
  "w-full min-w-0 rounded-md border bg-field text-ink transition-colors duration-fast placeholder:text-ink-subtle disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle";

export const CONTROL_BORDER = "border-field-line hover:border-field-line-strong";

export const CONTROL_INVALID = "border-bad hover:border-bad";

export function Input({
  icon,
  suffix,
  invalid,
  className,
  ...rest
}: {
  icon?: IconName;
  suffix?: ReactNode;
  invalid?: boolean;
} & ComponentProps<"input">) {
  const field = (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL_BASE,
        invalid ? CONTROL_INVALID : CONTROL_BORDER,
        "h-9 text-sm",
        icon ? "pl-9" : "pl-3",
        suffix ? "pr-20" : "pr-3",
        className,
      )}
    />
  );

  if (!icon && !suffix) {
    return field;
  }

  return (
    <div className="relative min-w-0">
      {icon ? (
        <span className="pointer-events-none absolute inset-y-0 left-0 grid w-9 place-items-center text-ink-subtle">
          <Icon name={icon} />
        </span>
      ) : null}
      {field}
      {suffix ? (
        <span className="absolute inset-y-0 right-0 flex items-center pr-3 text-xs text-ink-subtle">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}
