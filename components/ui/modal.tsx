"use client";

import { useId, useRef, type ReactNode } from "react";

import { Button } from "./button";
import { IconButton } from "./button";
import { cn } from "./cn";
import { useDismiss, useFocusTrap, useScrollLock } from "./use-dismiss";

/**
 * A centred dialog.
 *
 * Full focus management: move focus in on open, trap Tab inside, hand focus
 * back on close. Without all three, a keyboard user is left stranded behind the
 * overlay.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  size?: "sm" | "md" | "lg";
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

  const widths = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" } as const;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center sm:p-6">
      <div className="fixed inset-0 animate-fade-in bg-overlay" aria-hidden />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
        tabIndex={-1}
        className={cn(
          "relative w-full animate-rise rounded-xl border border-line bg-surface shadow-lg",
          widths[size],
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 id={`${id}-title`} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p id={`${id}-description`} className="mt-0.5 text-xs text-ink-subtle">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close the dialog" icon="x" onClick={onClose} />
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A confirmation dialog for actions that cannot be undone.
 *
 * Replaces `window.confirm`: the browser's own box cannot state the specific
 * consequence, cannot be formatted, and is blocked outright in some browsers.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-muted">{message}</div>
    </Modal>
  );
}
