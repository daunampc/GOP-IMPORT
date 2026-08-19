"use client";

import { useId, type ReactNode } from "react";

import { cn } from "./cn";

/**
 * An on/off switch.
 *
 * `role="switch"` on a real `<button>`: `aria-checked` tells a screen reader
 * the state, and the visually hidden "On"/"Off" text means someone who cannot
 * separate the colours still knows where it stands — knob position is not the
 * only signal.
 */
export function Switch({
  label,
  description,
  checked,
  onChange,
  disabled,
  size = "md",
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const id = useId();

  const track = size === "sm" ? "h-5 w-9" : "h-6 w-11";
  const knob = size === "sm" ? "size-3.5" : "size-4.5";
  const shift = size === "sm" ? "translate-x-4" : "translate-x-5";

  return (
    <div className={cn("flex items-start gap-3", className)}>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex shrink-0 items-center rounded-full border transition-colors duration-base",
          track,
          checked ? "border-accent bg-accent" : "border-field-line bg-surface-sunken",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "ml-0.5 rounded-full bg-surface-raised shadow-xs transition-transform duration-base ease-out-soft",
            knob,
            checked ? shift : "translate-x-0",
          )}
        />
        <span className="sr-only">{checked ? "On" : "Off"}</span>
      </button>

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
