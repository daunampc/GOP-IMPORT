import type { IconName } from "@/components/ui";

/** The primary navigation. Shared by the sidebar, the command palette and the shortcuts. */
export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  description: string;
  /** Digit that follows the `g` shortcut (press `g`, then `1`). */
  key: string;
  /** Shown to administrators only. */
  adminOnly?: boolean;
  /**
   * Publishing screens.
   *
   * Hidden from an administrator working in their OWN account: an administrator
   * account operates the service and does not publish products of its own. They
   * reappear the moment the administrator opens a customer's account, because
   * publishing on a customer's behalf is support work.
   */
  publishing?: boolean;
}

export const NAV: ReadonlyArray<NavItem> = [
  {
    href: "/",
    label: "Dashboard",
    icon: "dashboard",
    description: "Site health, runs in flight, throughput",
    key: "1",
  },
  {
    href: "/import",
    label: "Import",
    icon: "upload",
    description: "Choose a file, map columns, preview, then run",
    key: "2",
    publishing: true,
  },
  {
    href: "/products",
    label: "Products",
    icon: "package",
    description: "What is on a site: search, edit prices and stock, change many at once",
    key: "3",
    /*
     * A CUSTOMER capability, so it is hidden from an administrator in their own
     * account — the same rule Import and Remove follow, for the same reason: an
     * administrator account operates the service and does not change products of its
     * own. It reappears inside a customer's account, where the change belongs to them.
     *
     * The navigation is a courtesy. `refusePublishingAsAdmin` in the routes is the
     * boundary.
     */
    publishing: true,
  },
  {
    href: "/remove",
    label: "Remove",
    icon: "trash",
    description: "Select by run, SKU, category or everything — preview, then delete",
    key: "4",
    publishing: true,
  },
  {
    href: "/process",
    label: "Activity",
    icon: "activity",
    description: "Queue, progress, per-row results",
    key: "5",
  },
  {
    href: "/stores",
    label: "Sites",
    icon: "store",
    description: "Connections, plugin health, maintenance, taxonomy",
    key: "6",
  },
  {
    href: "/settings",
    label: "Settings",
    icon: "settings",
    description: "Theme, import defaults, environment, Redis",
    key: "7",
  },
  {
    href: "/admin",
    label: "Administration",
    icon: "shield-check",
    description: "Accounts, permissions, all runs, licence keys, secret reveals",
    key: "8",
    adminOnly: true,
  },
];

/**
 * The navigation a given viewer can see.
 *
 * `operator` is true for an administrator in their OWN account — the case where
 * the publishing screens do not apply. Inside a customer's account it is false,
 * and the full navigation returns.
 */
export function navFor(role: "admin" | "member", operator = false): NavItem[] {
  return NAV.filter((item) => {
    if (item.adminOnly && role !== "admin") {
      return false;
    }
    if (item.publishing && operator) {
      return false;
    }
    return true;
  });
}

/**
 * The navigation item matching a path.
 *
 * Prefix-matched so `/process/abc123` still highlights Activity, but `/` only
 * matches itself — otherwise the dashboard would light up everywhere.
 */
export function activeNav(pathname: string): NavItem | undefined {
  if (pathname === "/") {
    return NAV[0];
  }
  return NAV.slice(1).find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
}
