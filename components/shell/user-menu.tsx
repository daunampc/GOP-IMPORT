"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Badge, Icon, cn, useDismiss } from "@/components/ui";
import { signOut } from "@/lib/auth-client";

export interface ShellUser {
  name: string;
  email: string;
  role: "admin" | "member";
}

/**
 * Who is signed in, and the way out.
 *
 * Sign-out does a full `refresh()` afterwards rather than a client-side push:
 * the layout guard runs on the server, so the session cookie has to be gone
 * before the next render decides where to send them.
 */
export function UserMenu({ user }: { user: ShellUser }) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useDismiss(rootRef, () => setOpen(false), open);

  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-fast",
          open ? "bg-surface-sunken" : "hover:bg-surface-sunken",
        )}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-2xs font-semibold text-accent-fg">
          {initials || "?"}
        </span>
        <span className="hidden min-w-0 text-left lg:block">
          <span className="block max-w-32 truncate text-xs font-medium text-ink">
            {user.name}
          </span>
          <span className="block max-w-32 truncate text-2xs text-ink-subtle">{user.email}</span>
        </span>
        <Icon name={open ? "chevron-up" : "chevron-down"} className="size-3.5 text-ink-subtle" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-60 animate-rise rounded-lg border border-line bg-surface-raised p-1.5 shadow-lg"
        >
          <div className="border-b border-line px-2.5 pt-1.5 pb-2.5">
            <p className="truncate text-sm font-medium text-ink">{user.name}</p>
            <p className="truncate text-xs text-ink-subtle">{user.email}</p>
            <Badge tone={user.role === "admin" ? "accent" : "neutral"} className="mt-1.5">
              {user.role === "admin" ? "Administrator" : "Member"}
            </Badge>
          </div>

          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await signOut();
              router.push("/sign-in");
              router.refresh();
            }}
            className="mt-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-ink transition-colors duration-fast hover:bg-surface-sunken disabled:opacity-50"
          >
            <Icon name="arrow-left" className="size-4 text-ink-subtle" />
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
