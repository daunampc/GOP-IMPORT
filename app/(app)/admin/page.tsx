import { listReveals } from "@/lib/audit";
import { allJobsSnapshot } from "@/lib/jobs";
import { listLicenses } from "@/lib/licenses";
import { requireAdmin } from "@/lib/session";
import { listAccountsWithLimits } from "@/lib/limits";
import { requireView } from "@/lib/view";

import { AdminTabs } from "./admin-tabs";

export const dynamic = "force-dynamic";

/**
 * Full oversight of every account.
 *
 * Every read on this page goes through an explicitly named cross-account
 * function — `listAccountsWithLimits`, `allJobsSnapshot`, `listReveals` — rather
 * than through the ordinary per-account helpers with a flag flipped. That is the
 * whole reason those functions have separate names: this is the only page
 * entitled to call them, and it is obvious from a diff that it is doing so.
 */
export default async function AdminPage() {
  // Members are sent to the dashboard rather than shown a 403 they cannot act on.
  await requireAdmin();

  // Read for the "you are in this account" marker on the accounts list. The
  // administration screen itself is never scoped to the account being viewed —
  // it is the way OUT of one.
  const { user, actingAs } = await requireView();

  const [accounts, jobs, licenses, reveals] = await Promise.all([
    listAccountsWithLimits(),
    allJobsSnapshot(),
    listLicenses(),
    listReveals(),
  ]);

  return (
    <AdminTabs
      accounts={accounts}
      currentUserId={user.id}
      actingAsId={actingAs?.id ?? null}
      jobs={jobs}
      licenses={licenses}
      reveals={reveals}
    />
  );
}
