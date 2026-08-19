"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "./cn";

/**
 * A checkbox.
 *
 * The tick is hand-drawn SVG rather than `accent-color`, because
 * `accent-color` cannot change the shape and produces a glaring white box in
 * the dark theme. `indeterminate` can only be set from JavaScript, hence the
 * ref.
 */
export function Checkbox({
  label,
  description,
  checked,
  indeterminate = false,
  onChange,
  disabled,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate && !checked;
    }
  }, [indeterminate, checked]);

  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <span className="relative mt-0.5 grid size-4.5 shrink-0 place-items-center">
        <input
          ref={ref}
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer size-4.5 cursor-pointer appearance-none rounded-xs border border-field-line bg-field transition-colors duration-fast checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent hover:border-field-line-strong disabled:cursor-not-allowed disabled:bg-surface-sunken"
        />
        <svg
          viewBox="0 0 16 16"
          aria-hidden
          className="pointer-events-none absolute size-3 text-on-accent opacity-0 peer-checked:opacity-100"
        >
          <path
            d="M2.5 8.5 6.5 12.5 13.5 4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span
          aria-hidden
          className="pointer-events-none absolute h-0.5 w-2 rounded-full bg-on-accent opacity-0 peer-indeterminate:opacity-100"
        />
      </span>

      <label
        htmlFor={id}
        className={cn(
          "min-w-0 cursor-pointer text-sm leading-snug select-none",
          disabled ? "cursor-not-allowed text-ink-subtle" : "text-ink",
        )}
      >
        {label}
        {description ? (
          <span className="mt-0.5 block text-xs text-ink-subtle">{description}</span>
        ) : null}
      </label>
    </div>
  );
}
