import { jobsSnapshot, type JobsSnapshot } from "@/lib/jobs";
import { requireView } from "@/lib/view";

import { AppShell } from "@/components/shell/app-shell";

/**
 * Everything behind the login lives under this layout.
 *
 * `requireView()` wraps `requireActive()`, so a missing session or a revoked
 * licence is still caught on the server before any screen renders — not by a
 * client-side check that a disabled JavaScript engine would skip. It adds one
 * thing: `ownerId`, the account whose data every screen below here shows.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const { user, ownerId, actingAs } = await requireView();

  // Load the first queue snapshot server-side so the status bar has real
  // numbers on the very first frame instead of showing 0/0 until SSE connects.
  let initialJobs: JobsSnapshot = { running: [], queued: [], scheduled: [], history: [], at: "" };
  try {
    initialJobs = await jobsSnapshot(ownerId);
  } catch {
    // Database unreachable: still render the chrome. The status bar reports the
    // lost connection itself, and blowing up here would take down the Settings
    // screen too — the exact place someone goes to diagnose this.
  }

  return (
    <AppShell
      initialJobs={initialJobs}
      user={{ name: user.name, email: user.email, role: user.role }}
      actingAs={actingAs ? { name: actingAs.name, email: actingAs.email } : null}
    >
      {children}
    </AppShell>
  );
}
