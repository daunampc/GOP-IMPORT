"use client";

import { useState, type ReactNode } from "react";

import { Button } from "./button";
import { cn } from "./cn";
import { Icon } from "./icon";

/**
 * The error state.
 *
 * Three required parts: what went wrong, what to do next, and the technical
 * detail folded away. Folded because the operator needs it to report the
 * problem, but a stack trace across the middle of the screen buries the answer
 * to "what do I do now".
 */
export function ErrorState({
  title = "Could not load this",
  message,
  detail,
  hint,
  onRetry,
  retryLabel = "Try again",
  extra,
  className,
}: {
  title?: string;
  message: string;
  /** Technical detail — stack, error code, raw response. */
  detail?: string;
  /** The answer to "what do I do now". */
  hint?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  extra?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-bad-border bg-bad-soft px-6 py-10 text-center",
        className,
      )}
    >
      <span className="grid size-12 place-items-center rounded-full bg-bad text-on-bad">
        <Icon name="alert-circle" className="size-5" />
      </span>

      <div className="max-w-xl space-y-1">
        <p className="text-sm font-semibold text-bad-fg">{title}</p>
        <p className="text-xs break-words text-bad-fg">{message}</p>
      </div>

      {hint ? <div className="max-w-xl text-xs text-ink-muted">{hint}</div> : null}

      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        {onRetry ? (
          <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : null}
        {extra}
        {detail ? (
          <Button
            variant="ghost"
            size="sm"
            icon={open ? "chevron-up" : "chevron-down"}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "Hide the detail" : "Technical detail"}
          </Button>
        ) : null}
      </div>

      {open && detail ? (
        <pre className="max-h-56 w-full max-w-2xl overflow-auto rounded-md border border-bad-border bg-surface p-3 text-left font-mono text-2xs whitespace-pre-wrap text-ink-muted">
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
