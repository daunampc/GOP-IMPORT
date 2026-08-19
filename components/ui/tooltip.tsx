"use client";

import { useId, useState, type ReactNode } from "react";

import { cn } from "./cn";

/**
 * A floating hint.
 *
 * Appears on hover AND on keyboard focus, and is tied to its trigger with
 * `aria-describedby` — a hover-only tooltip is invisible to a keyboard user.
 *
 * This is for SUPPLEMENTARY information. Anything required has to live outside
 * a tooltip: on touch devices there is no hover state at all.
 */
export function Tooltip({
  content,
  side = "top",
  className,
  children,
}: {
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  const positions = {
    top: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
    bottom: "top-full left-1/2 mt-1.5 -translate-x-1/2",
    left: "right-full top-1/2 mr-1.5 -translate-y-1/2",
    right: "left-full top-1/2 ml-1.5 -translate-y-1/2",
  } as const;

  return (
    <span
      className={cn("relative inline-flex", className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>

      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "pointer-events-none absolute z-50 w-max max-w-64 animate-fade-in rounded-md border border-line bg-surface-raised px-2.5 py-1.5 text-xs leading-snug text-ink shadow-md",
            positions[side],
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
