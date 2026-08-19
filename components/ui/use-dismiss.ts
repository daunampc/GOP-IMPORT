"use client";

import { useEffect, type RefObject } from "react";

/**
 * Dismiss a floating layer on an outside press or Escape.
 *
 * Listens on the capture phase of `pointerdown` rather than `click`: waiting
 * for `click` means a press-drag-release that starts inside and ends outside is
 * read as an outside press, closing the list mid-selection while someone is
 * highlighting text.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      const node = ref.current;
      if (node && !node.contains(event.target as Node)) {
        onDismiss();
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismiss();
      }
    }

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, onDismiss, active]);
}

/**
 * Keep focus inside a modal layer, and give it back on close. Without this,
 * Tab walks straight through into the page behind — a keyboard user leaves the
 * dialog without ever knowing they did.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;

    const focusables = () =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null || element === document.activeElement);

    // Move focus inside on open, otherwise the very first Tab still lands in
    // the page behind.
    const first = focusables()[0];
    (first ?? node)?.focus?.();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") {
        return;
      }

      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }

      const start = items[0];
      const end = items[items.length - 1];

      if (event.shiftKey && document.activeElement === start) {
        event.preventDefault();
        end.focus();
      } else if (!event.shiftKey && document.activeElement === end) {
        event.preventDefault();
        start.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    };
  }, [ref, active]);
}

/** Lock page scrolling while a full-screen overlay is up. */
export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}
