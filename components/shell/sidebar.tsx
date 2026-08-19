"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Icon, IconButton, Tooltip, cn } from "@/components/ui";

import { useJobs } from "./jobs-provider";
import { activeNav, navFor } from "./nav";

const COLLAPSE_KEY = "tsd-sidebar-collapsed";

/**
 * The VERTICAL navigation rail, collapsible.
 *
 * Vertical on purpose: the list keeps growing, and on a horizontal bar every
 * new entry eats into the content width — which the results tables need badly.
 *
 * The collapsed state lives in `localStorage` and is read with lazy
 * initialisation, so the sidebar never expands and then snaps shut after the
 * page has already painted.
 */
export function Sidebar({
  mobileOpen,
  onMobileClose,
  role,
  operator,
}: {
  mobileOpen: boolean;
  onMobileClose(): void;
  role: "admin" | "member";
  /** True for an administrator in their own account: no publishing screens. */
  operator: boolean;
}) {
  const pathname = usePathname();
  const active = activeNav(pathname);
  const { snapshot } = useJobs();

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      // Private mode blocks writes — still usable for this session.
    }
  }, [collapsed]);

  // Close the mobile overlay after navigating, otherwise tapping an item leaves
  // the menu covering the page it just opened.
  useEffect(() => {
    onMobileClose();
  }, [pathname, onMobileClose]);

  const activeCount = snapshot.running.length + snapshot.queued.length;

  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Close the menu"
          onClick={onMobileClose}
          className="fixed inset-0 z-40 animate-fade-in bg-overlay lg:hidden"
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col border-r border-line bg-canvas-deep transition-[width,transform] duration-base ease-out-soft lg:static lg:translate-x-0",
          collapsed ? "w-16" : "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div

          className={cn(
            "flex h-14 shrink-0 items-center border-b border-line",
            collapsed ? "justify-center px-2" : "justify-between px-4",
          )}
        >
          <div
            onClick={() => setCollapsed(false)}
            className="flex min-w-0 items-center gap-2 font-semibold tracking-tight text-ink"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-on-accent">
              <Icon name="package" className="size-4" />
            </span>
            {!collapsed ? <span className="truncate text-sm">GOP_IMPORT</span> : null}
          </div>

          {!collapsed ? (
            <IconButton
              label="Collapse the sidebar"
              icon="panel-left"
              size="sm"
              className="hidden lg:inline-flex"
              onClick={() => setCollapsed(true)}
            />
          ) : null}
        </div>

        <nav aria-label="Main navigation" className="min-h-0 flex-1 overflow-y-auto p-2">
          <ul className="space-y-1">
            {navFor(role, operator).map((item) => {
              const isActive = active?.href === item.href;
              const badge = item.href === "/process" && activeCount > 0 ? activeCount : null;

              const link = (
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-md py-2 text-sm font-medium transition-colors duration-fast",
                    collapsed ? "justify-center px-2" : "px-3",
                    isActive
                      ? "bg-surface text-ink shadow-xs"
                      : "text-ink-muted hover:bg-surface hover:text-ink",
                  )}
                >
                  {/* The left rule is a second cue for the current item, so the
                      signal is not carried by background shade alone. */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-0 h-5 w-0.5 rounded-full bg-accent transition-opacity duration-fast",
                      isActive ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <Icon
                    name={item.icon}
                    className={cn("size-4.5", isActive && "text-accent-fg")}
                  />
                  {!collapsed ? <span className="truncate">{item.label}</span> : null}
                  {badge !== null ? (
                    <span
                      className={cn(
                        "tnum ml-auto rounded-full bg-accent px-1.5 py-0.5 text-2xs font-semibold text-on-accent",
                        collapsed && "absolute top-1 right-1 ml-0 px-1",
                      )}
                    >
                      {badge}
                    </span>
                  ) : null}
                </Link>
              );

              return (
                <li key={item.href}>
                  {collapsed ? (
                    <Tooltip content={item.label} side="right" className="w-full">
                      {link}
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        <div className={cn("shrink-0 border-t border-line p-2", collapsed && "flex justify-center")}>
          {collapsed ? (
            <IconButton
              label="Expand the sidebar"
              icon="chevron-right"
              size="sm"
              onClick={() => setCollapsed(false)}
            />
          ) : (
            <p className="px-2 py-1 text-2xs leading-relaxed text-ink-subtle">
              Press <kbd className="font-mono">Ctrl</kbd>+<kbd className="font-mono">K</kbd> for
              the command palette
            </p>
          )}
        </div>
      </aside>
    </>
  );
}
