"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { IconButton } from "./button";
import { cn } from "./cn";
import { Icon, type IconName } from "./icon";
import type { Tone } from "./badge";

/**
 * Corner notifications.
 *
 * The container is `aria-live="polite"`, so a screen reader announces new
 * messages without cutting across whatever it was reading. A `bad` toast does
 * NOT dismiss itself: an error that disappears after four seconds is an error
 * somebody missed.
 */

export interface Toast {
  id: string;
  tone: Tone;
  title: string;
  description?: string;
  /** Milliseconds; 0 means stay until dismissed. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

type ToastInput = Omit<Toast, "id">;

interface ToastApi {
  show: (toast: ToastInput) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  warn: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return api;
}

const ICONS: Record<Tone, IconName> = {
  neutral: "info",
  accent: "zap",
  ok: "check-circle",
  warn: "alert-triangle",
  bad: "alert-circle",
  info: "info",
};

const TONES: Record<Tone, string> = {
  neutral: "border-line bg-surface-raised text-ink",
  accent: "border-accent-border bg-accent-soft text-accent-fg",
  ok: "border-ok-border bg-ok-soft text-ok-fg",
  warn: "border-warn-border bg-warn-soft text-warn-fg",
  bad: "border-bad-border bg-bad-soft text-bad-fg",
  info: "border-info-border bg-info-soft text-info-fg",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      counter.current += 1;
      const id = `toast-${counter.current}`;
      const duration = input.duration ?? (input.tone === "bad" ? 0 : 4500);

      setToasts((current) => [...current.slice(-3), { ...input, id }]);

      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
    },
    [dismiss],
  );

  // Clear every timer when the provider goes away, otherwise setState runs on
  // an unmounted component.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, description) => show({ tone: "ok", title, description }),
      error: (title, description) => show({ tone: "bad", title, description }),
      info: (title, description) => show({ tone: "info", title, description }),
      warn: (title, description) => show({ tone: "warn", title, description }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed right-4 bottom-14 z-60 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto flex animate-rise gap-2.5 rounded-lg border px-3.5 py-3 shadow-lg",
              TONES[toast.tone],
            )}
          >
            <Icon name={ICONS[toast.tone]} className="mt-0.5 size-4 shrink-0" />

            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{toast.title}</p>
              {toast.description ? (
                <p className="mt-0.5 text-xs break-words opacity-90">{toast.description}</p>
              ) : null}
              {toast.action ? (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss(toast.id);
                  }}
                  className="mt-1.5 text-xs font-semibold underline underline-offset-2"
                >
                  {toast.action.label}
                </button>
              ) : null}
            </div>

            <IconButton
              label="Dismiss"
              icon="x"
              size="sm"
              onClick={() => dismiss(toast.id)}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
