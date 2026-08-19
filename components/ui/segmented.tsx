"use client";

import { cn } from "./cn";
import { Icon, type IconName } from "./icon";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  hint?: string;
}

/**
 * A row of buttons for picking one of a few equal options.
 *
 * `role="radiogroup"` rather than a strip of separate buttons: this is ONE
 * choice, not several actions, and a screen reader has to hear that.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = "md",
  block = false,
  disabled = false,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (next: T) => void;
  size?: "sm" | "md";
  block?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex gap-0.5 rounded-md border border-line bg-surface-sunken p-0.5",
        block && "flex w-full",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-sm font-medium transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-40",
              size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
              block && "flex-1",
              active
                ? "bg-surface-raised text-ink shadow-xs"
                : "text-ink-muted hover:text-ink",
            )}
          >
            {option.icon ? <Icon name={option.icon} className="size-3.5 shrink-0" /> : null}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
