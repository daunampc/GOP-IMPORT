import type { ReactNode } from "react";

import { cn } from "./cn";

/**
 * One form row: label, control, description, error.
 *
 * The error is tied to the control with `aria-describedby` at the call site;
 * this only builds a stable id and renders. An error always carries a "!" icon
 * — red alone is invisible to someone who cannot separate the colours.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  optional,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="flex items-baseline gap-2 text-xs font-semibold tracking-wide text-ink uppercase"
      >
        <span>{label}</span>
        {required ? (
          <span className="text-bad-fg normal-case" aria-hidden>
            required
          </span>
        ) : null}
        {optional ? (
          <span className="font-normal tracking-normal text-ink-subtle normal-case">
            optional
          </span>
        ) : null}
      </label>

      {children}

      {hint ? (
        <p id={htmlFor ? `${htmlFor}-hint` : undefined} className="text-xs text-ink-subtle">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p
          id={htmlFor ? `${htmlFor}-error` : undefined}
          className="flex items-start gap-1.5 text-xs font-medium text-bad-fg"
        >
          <span
            aria-hidden
            className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-bad text-2xs font-bold text-on-bad"
          >
            !
          </span>
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Groups Fields into a block under a small heading. */
export function FieldGroup({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn("min-w-0 space-y-4", className)}>
      <legend className="sr-only">{title}</legend>
      <div className="flex items-baseline gap-3 border-b border-line pb-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description ? (
          <p className="min-w-0 flex-1 truncate text-xs text-ink-subtle">{description}</p>
        ) : null}
      </div>
      {children}
    </fieldset>
  );
}
