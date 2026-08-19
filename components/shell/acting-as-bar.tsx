"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/components/ui";

/**
 * "You are inside someone else's account."
 *
 * Deliberately NOT a badge in a corner. It is a full-width bar in the warning
 * colour, pinned above the sidebar and every screen, present on every page,
 * with no way to dismiss it. It also pushes the whole application down by its
 * own height, so the layout itself is visibly different from the ordinary one —
 * a thing peripheral vision notices even when nobody is reading.
 *
 * The reason it is this loud: while this bar is showing, everything an
 * administrator does BELONGS TO the account named on it. Starting an import
 * here creates that account's run, against that account's connected site, and
 * the worker will push the images into that account's S3 bucket. An
 * administrator who forgets which account they are in is how 5000 products land
 * in the wrong shop.
 */
export function ActingAsBar({
  account,
  adminEmail,
}: {
  account: { name: string; email: string };
  adminEmail: string;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function leave() {
    setLeaving(true);
    try {
      await fetch("/api/admin/view", { method: "DELETE" });
      // refresh() rather than a full reload: every screen in this group is
      // `force-dynamic` and re-renders server-side against the restored
      // account, so the data and the bar change together.
      router.refresh();
    } finally {
      setLeaving(false);
    }
  }

  return (
    <div
      // `role="alert"` rather than a plain banner: this is a live condition
      // about what the operator's next click will do, not page furniture.
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-warn px-3 py-2 text-on-warn lg:px-4"
    >
      <Icon name="alert-triangle" className="size-4 shrink-0" aria-hidden />

      <p className="min-w-0 text-sm font-semibold">
        Viewing and acting inside{" "}
        <span className="break-all underline decoration-2 underline-offset-2">
          {account.email}
        </span>
      </p>

      <p className="min-w-0 text-2xs opacity-90">
        Anything you start belongs to this account — its sites, its runs, its S3
        bucket. Signed in as {adminEmail}.
      </p>

      <button
        type="button"
        onClick={() => void leave()}
        disabled={leaving}
        className="ml-auto shrink-0 rounded-xs border border-on-warn/40 px-2 py-1 text-2xs font-semibold underline-offset-2 hover:bg-on-warn/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-on-warn disabled:opacity-60"
      >
        {leaving ? "Leaving…" : "Leave this account"}
      </button>
    </div>
  );
}
