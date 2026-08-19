"use client";

import { useId, useRef, type ReactNode } from "react";

import { IconButton } from "./button";
import { cn } from "./cn";
import { useDismiss, useFocusTrap, useScrollLock } from "./use-dismiss";

/**
 * A drawer sliding in from the right edge.
 *
 * For the detail of one row (a product in the preview, one import result): it
 * keeps the context of the table behind it, where a Modal covers everything.
 *
 * Same focus management as Modal — this is still a modal layer.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  width = "md",
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  width?: "sm" | "md" | "lg";
  footer?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useDismiss(panelRef, onClose, open);
  useFocusTrap(panelRef, open);
  useScrollLock(open);

  if (!open) {
    return null;
  }

  const widths = { sm: "sm:max-w-md", md: "sm:max-w-xl", lg: "sm:max-w-3xl" } as const;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="fixed inset-0 animate-fade-in bg-overlay" aria-hidden />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        className={cn(
          "relative flex h-full w-full animate-slide-left flex-col border-l border-line bg-surface shadow-lg",
          widths[width],
        )}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="truncate text-base font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 truncate text-xs text-ink-subtle">{description}</p>
            ) : null}
          </div>
          <IconButton label="Close the drawer" icon="x" onClick={onClose} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
