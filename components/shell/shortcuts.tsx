"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { DescriptionList, Modal } from "@/components/ui";

import { navFor } from "./nav";

/**
 * Global keyboard shortcuts.
 *
 * Nothing is captured while the caret is in an input — typing "g" in a search
 * box and being navigated away is what makes people give up on shortcuts
 * entirely. The single exception is Cmd/Ctrl+K, since a modifier combination
 * cannot collide with typing.
 */

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function GlobalShortcuts({
  role,
  operator,
  onOpenPalette,
  onOpenHelp,
}: {
  role: "admin" | "member";
  /** True for an administrator in their own account: no publishing shortcuts. */
  operator: boolean;
  onOpenPalette: () => void;
  onOpenHelp: () => void;
}) {
  const router = useRouter();
  // Vim-style chord: `g` then a digit. The window forgets after 900ms.
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === "k") {
          event.preventDefault();
          onOpenPalette();
        }
        return;
      }

      if (event.altKey || isTypingTarget(event.target)) {
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        onOpenHelp();
        return;
      }

      if (event.key.toLowerCase() === "g") {
        pending.current = { key: "g", at: Date.now() };
        return;
      }

      const chord = pending.current;
      if (chord && Date.now() - chord.at < 900) {
        const target = navFor(role, operator).find((item) => item.key === event.key);
        if (target) {
          event.preventDefault();
          router.push(target.href);
        }
        pending.current = null;
        return;
      }

      pending.current = null;
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router, onOpenPalette, onOpenHelp, role, operator]);

  return null;
}

export function ShortcutsHelp({
  open,
  onClose,
  role,
  operator,
}: {
  open: boolean;
  onClose: () => void;
  role: "admin" | "member";
  operator: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Press ? at any time to reopen this"
      size="md"
    >
      <div className="space-y-5">
        <DescriptionList
          columns={1}
          items={[
            { term: "Ctrl / ⌘ + K", value: "Open the command palette" },
            { term: "?", value: "Open this shortcut list" },
            { term: "Esc", value: "Close the open dialog, drawer or palette" },
          ]}
        />

        <div className="space-y-2">
          <h3 className="text-xs font-semibold tracking-wide text-ink-subtle uppercase">
            Go to a screen — press G then the digit
          </h3>
          <DescriptionList
            columns={2}
            items={navFor(role, operator).map((item) => ({
              term: `G then ${item.key}`,
              value: item.label,
            }))}
          />
        </div>

        <p className="text-xs text-ink-subtle">
          Shortcuts are inert while the caret is in an input — except Ctrl/⌘+K.
        </p>
      </div>
    </Modal>
  );
}
