"use client";

import { usePathname } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";

import type { JobsSnapshot } from "@/lib/jobs";
import { Button, Icon, IconButton, ToastProvider, cn } from "@/components/ui";

import { ActingAsBar } from "./acting-as-bar";
import { CommandPalette } from "./command-palette";
import { JobsProvider } from "./jobs-provider";
import { activeNav } from "./nav";
import { Sidebar } from "./sidebar";
import { StatusBar } from "./status-bar";
import { GlobalShortcuts, ShortcutsHelp } from "./shortcuts";
import { ThemeProvider, ThemeSwitch } from "./theme";
import { UserMenu, type ShellUser } from "./user-menu";

/**
 * The application shell: vertical sidebar, top command bar, its own content
 * area, and a status bar pinned to the bottom.
 *
 * The layout is one viewport-tall column with `min-h-0` on the content area, so
 * only the content scrolls while the sidebar and both bars stay put. Without
 * `min-h-0`, long content pushes the status bar below the fold and it stops
 * being persistent at all.
 */
export function AppShell({
  initialJobs,
  user,
  actingAs,
  children,
}: {
  initialJobs: JobsSnapshot;
  user: ShellUser;
  /**
   * Set when an administrator has opened another account. Everything on screen
   * — and everything the screens create — then belongs to that account.
   */
  actingAs: { name: string; email: string } | null;
  children: ReactNode;
}) {
  const [mobileNav, setMobileNav] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);

  /*
   * An administrator in their OWN account is an operator, not a customer: no
   * Import, no Remove, and a different dashboard. The moment they open a
   * customer's account (`actingAs`) the publishing screens come back, because
   * running an import on a customer's behalf is support work.
   */
  const operator = user.role === "admin" && actingAs === null;

  const closeMobileNav = useCallback(() => setMobileNav(false), []);
  const openPalette = useCallback(() => setPalette(true), []);
  const openHelp = useCallback(() => setHelp(true), []);

  return (
    <ThemeProvider>
      <JobsProvider initial={initialJobs}>
        <ToastProvider>
          {/* One column: the acting-as bar, then the ordinary shell beneath it.
              The bar is part of the LAYOUT rather than an overlay, so it pushes
              everything down and cannot be scrolled away from or covered. */}
          <div className="flex h-screen flex-col overflow-hidden bg-canvas">
            {actingAs ? <ActingAsBar account={actingAs} adminEmail={user.email} /> : null}

            <div className="flex min-h-0 flex-1 overflow-hidden">
              <Sidebar
                mobileOpen={mobileNav}
                onMobileClose={closeMobileNav}
                role={user.role}
                operator={operator}
              />

              <div className="flex min-w-0 flex-1 flex-col">
                <CommandBar
                  user={user}
                  onOpenNav={() => setMobileNav(true)}
                  onOpenPalette={openPalette}
                  onOpenHelp={openHelp}
                />

                <main
                  className={cn(
                    "min-h-0 flex-1 overflow-y-auto",
                    // A second, quieter reminder that follows the content
                    // rather than sitting at the top of the page: the operator
                    // scrolled away from the bar is still inside the account.
                    actingAs !== null && "border-l-4 border-warn",
                  )}
                >
                  <div className="mx-auto w-full max-w-[100rem] p-4 lg:p-6">{children}</div>
                </main>

                <StatusBar />
              </div>
            </div>
          </div>

          <CommandPalette
            role={user.role}
            operator={operator}
            open={palette}
            onOpenChange={setPalette}
          />
          <ShortcutsHelp
            open={help}
            onClose={() => setHelp(false)}
            role={user.role}
            operator={operator}
          />
          <GlobalShortcuts
            role={user.role}
            operator={operator}
            onOpenPalette={openPalette}
            onOpenHelp={openHelp}
          />
        </ToastProvider>
      </JobsProvider>
    </ThemeProvider>
  );
}

function CommandBar({
  user,
  onOpenNav,
  onOpenPalette,
  onOpenHelp,
}: {
  user: ShellUser;
  onOpenNav: () => void;
  onOpenPalette: () => void;
  onOpenHelp: () => void;
}) {
  const pathname = usePathname();
  const current = activeNav(pathname);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 lg:px-4">
      <IconButton
        label="Open the navigation menu"
        icon="menu"
        className="lg:hidden"
        onClick={onOpenNav}
      />

      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold text-ink">
          {current?.label ?? "GOP_IMPORT"}
        </h1>
        {current ? (
          <p className="hidden truncate text-2xs text-ink-subtle sm:block">
            {current.description}
          </p>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* The palette button looks like a search field: someone who does not
            know the shortcut still finds it, and someone who does reads the key
            combination right off the button. */}
        <Button
          variant="secondary"
          size="sm"
          onClick={onOpenPalette}
          className={cn("hidden gap-6 text-ink-subtle sm:inline-flex")}
        >
          <span className="inline-flex items-center gap-2">
            <Icon name="search" className="size-3.5" />
            Search or run a command
          </span>
          <kbd className="rounded-xs border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs">
            ⌘K
          </kbd>
        </Button>

        <IconButton
          label="Search or run a command"
          icon="search"
          className="sm:hidden"
          onClick={onOpenPalette}
        />

        <div className="hidden md:block">
          <ThemeSwitch />
        </div>

        <IconButton label="Keyboard shortcuts" icon="command" onClick={onOpenHelp} />

        <span aria-hidden className="mx-0.5 h-6 w-px bg-line" />

        <UserMenu user={user} />
      </div>
    </header>
  );
}
