"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Icon,
  cn,
  foldVietnamese,
  useDismiss,
  useFocusTrap,
  useScrollLock,
  type IconName,
} from "@/components/ui";
import { useTheme } from "./theme";

import { useJobs } from "./jobs-provider";
import { navFor } from "./nav";

/**
 * The command palette, opened with Cmd/Ctrl+K.
 *
 * Three jobs in one: jump to a screen, jump straight to a run by name, and run
 * the handful of frequent actions. For a tool an operator keeps open all day,
 * this is the shortest path between any two things.
 */

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  group: string;
  run: () => void;
}

/**
 * The outer shell decides only whether the palette is open.
 *
 * The body is a SEPARATE component that exists only while open, so every open
 * is a fresh mount with an empty query and the cursor at the top — no effect
 * has to watch `open` and reset state afterwards.
 */
export function CommandPalette({
  role,
  operator,
  open,
  onOpenChange,
}: {
  role: "admin" | "member";
  /** True for an administrator in their own account: no publishing commands. */
  operator: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open) {
    return null;
  }

  return <PaletteDialog role={role} operator={operator} onOpenChange={onOpenChange} />;
}

function PaletteDialog({
  role,
  operator,
  onOpenChange,
}: {
  role: "admin" | "member";
  operator: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { snapshot } = useJobs();
  const { choice, setChoice } = useTheme();

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useDismiss(panelRef, () => onOpenChange(false), true);
  useFocusTrap(panelRef, true);
  useScrollLock(true);

  // Focus the input on open. A command palette you have to click into has lost
  // the point of itself. Runs after `useFocusTrap`, which puts focus on the
  // first element — this is the right one.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => {
      router.push(href);
      onOpenChange(false);
    };

    // Filtered the same way the sidebar is: a screen an administrator has no
    // business on must not be reachable through ⌘K either.
    const items: Command[] = navFor(role, operator).map((item) => ({
      id: `nav-${item.href}`,
      label: item.label,
      hint: item.description,
      icon: item.icon,
      group: "Go to",
      run: go(item.href),
    }));

    for (const job of [...snapshot.running, ...snapshot.queued, ...snapshot.scheduled].slice(0, 8)) {
      items.push({
        id: `job-${job.id}`,
        label: job.sourceLabel,
        hint: `${job.status === "running" ? "Running" : "Queued"} → ${job.storeLabel}`,
        icon: "activity",
        group: "Runs in flight",
        run: go(`/process/${job.id}`),
      });
    }

    for (const job of snapshot.history.slice(0, 8)) {
      items.push({
        id: `job-${job.id}`,
        label: job.sourceLabel,
        hint: `${job.succeeded}/${job.total} succeeded → ${job.storeLabel}`,
        icon: "history",
        group: "Recent runs",
        run: go(`/process/${job.id}`),
      });
    }

    items.push(
      {
        id: "action-import",
        label: "Start a new import",
        icon: "upload",
        group: "Actions",
        run: go("/import"),
      },
      {
        id: "action-check",
        label: "Check every site's connection",
        hint: "Opens Sites and runs the checks in bulk",
        icon: "shield-check",
        group: "Actions",
        run: go("/stores?check=all"),
      },
      {
        id: "action-theme",
        label:
          choice === "dark"
            ? "Switch to the light theme"
            : choice === "light"
              ? "Follow the system theme"
              : "Switch to the dark theme",
        icon: choice === "dark" ? "sun" : "moon",
        group: "Actions",
        run: () => {
          setChoice(choice === "dark" ? "light" : choice === "light" ? "system" : "dark");
          onOpenChange(false);
        },
      },
    );

    return items;
  }, [router, snapshot, choice, setChoice, onOpenChange, role, operator]);

  const matches = useMemo(() => {
    const needle = foldVietnamese(query.trim());
    if (needle === "") {
      return commands;
    }
    return commands.filter((command) =>
      foldVietnamese(`${command.label} ${command.hint ?? ""} ${command.group}`).includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Grouped for headings, but the cursor index still runs over the FLAT list —
  // mixing two index spaces is where "Enter picked the wrong row" comes from.
  const groups: Array<{ name: string; items: Array<{ command: Command; index: number }> }> = [];
  matches.forEach((command, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === command.group) {
      last.items.push({ command, index });
    } else {
      groups.push({ name: command.group, items: [{ command, index }] });
    }
  });

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matches.length === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor((current) => (current + step + matches.length) % matches.length);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      matches[cursor]?.run();
    }
  }

  return (
    <div className="fixed inset-0 z-70 flex items-start justify-center p-4 pt-[10vh]">
      <div className="fixed inset-0 animate-fade-in bg-overlay" aria-hidden />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-xl animate-rise overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Icon name="search" className="size-4 shrink-0 text-ink-subtle" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-controls="command-palette-list"
            aria-activedescendant={matches[cursor] ? `command-${matches[cursor].id}` : undefined}
            autoComplete="off"
            value={query}
            placeholder="Search screens, runs and commands…"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-subtle"
          />
          <kbd className="rounded-xs border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs text-ink-subtle">
            Esc
          </kbd>
        </div>

        <ul
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="Results"
          className="max-h-96 overflow-y-auto p-2"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-8 text-center text-xs text-ink-subtle">
              Nothing matches “{query}”
            </li>
          ) : (
            groups.map((group) => (
              <li key={group.name}>
                <p className="px-2 pt-2 pb-1 text-2xs font-semibold tracking-wide text-ink-subtle uppercase">
                  {group.name}
                </p>
                <ul>
                  {group.items.map(({ command, index }) => (
                    <li
                      key={command.id}
                      id={`command-${command.id}`}
                      data-index={index}
                      role="option"
                      aria-selected={index === cursor}
                      onPointerEnter={() => setCursor(index)}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        command.run();
                      }}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm",
                        index === cursor ? "bg-accent-soft text-accent-fg" : "text-ink",
                      )}
                    >
                      <Icon name={command.icon} className="size-4 shrink-0 opacity-70" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{command.label}</span>
                        {command.hint ? (
                          <span className="block truncate text-2xs text-ink-subtle">
                            {command.hint}
                          </span>
                        ) : null}
                      </span>
                      {index === cursor ? (
                        <Icon name="arrow-right" className="size-3.5 shrink-0" />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
