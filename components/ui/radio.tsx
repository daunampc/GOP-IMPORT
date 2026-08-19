"use client";

import { useId, type ReactNode } from "react";

import { cn } from "./cn";

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

/**
 * A radio group. Uses a real `<fieldset>`/`<legend>` so a screen reader reads
 * the question before reading the options.
 */
export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  legend: string;
  name?: string;
  value: T;
  options: ReadonlyArray<RadioOption<T>>;
  onChange: (next: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const generated = useId();
  const group = name ?? generated;

  return (
    <fieldset className={cn("min-w-0 space-y-2", className)} disabled={disabled}>
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const id = `${group}-${option.value}`;
        const active = value === option.value;

        return (
          <div
            key={option.value}
            className={cn(
              "flex items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors duration-fast",
              active
                ? "border-accent-border bg-accent-soft"
                : "border-line bg-surface hover:border-field-line",
              (disabled || option.disabled) && "opacity-60",
            )}
          >
            <span className="relative mt-0.5 grid size-4.5 shrink-0 place-items-center">
              <input
                id={id}
                type="radio"
                name={group}
                value={option.value}
                checked={active}
                disabled={disabled || option.disabled}
                onChange={() => onChange(option.value)}
                className="peer size-4.5 cursor-pointer appearance-none rounded-full border border-field-line bg-field transition-colors duration-fast checked:border-accent hover:border-field-line-strong disabled:cursor-not-allowed"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute size-2 scale-0 rounded-full bg-accent transition-transform duration-fast peer-checked:scale-100"
              />
            </span>

            <label
              htmlFor={id}
              className={cn(
                "min-w-0 cursor-pointer text-sm leading-snug select-none",
                active ? "font-medium text-ink" : "text-ink",
              )}
            >
              {option.label}
              {option.description ? (
                <span className="mt-0.5 block text-xs font-normal text-ink-subtle">
                  {option.description}
                </span>
              ) : null}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
