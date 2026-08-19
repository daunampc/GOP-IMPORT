import { listReveals } from "@/lib/audit";
import { allJobsSnapshot, listJobs } from "@/lib/jobs";
import { listAccountsWithLimits } from "@/lib/limits";
import { expectedPluginVersion } from "@/lib/plugin-version.server";
import { computeStats } from "@/lib/stats";
import { listAllStores, listStores, toPublic } from "@/lib/stores";
import { requireView } from "@/lib/view";

import { DashboardView } from "./dashboard-view";
import { OperatorDashboardView } from "./operator-dashboard-view";

// Every figure here changes constantly — this page is never cached.
export const dynamic = "force-dynamic";

/**
 * Two different dashboards behind one route.
 *
 * An administrator in their own account gets the OPERATOR dashboard: every
 * account, every run, every unhealthy site. An administrator inside a customer's
 * account, and every member, gets the customer dashboard — because inside an
 * account the question is that account's question.
 *
 * Two screens rather than one with extra rows: an administrator account has no
 * sites, no runs and no throughput of its own, so the customer dashboard would be
 * a page of zeroes.
 */
export default async function DashboardPage() {
  const { user, ownerId, actingAs } = await requireView();
  const operator = user.role === "admin" && actingAs === null;

  if (operator) {
    const [accounts, snapshot, stores, reveals] = await Promise.all([
      listAccountsWithLimits(),
      allJobsSnapshot(),
      listAllStores(),
      listReveals(20),
    ]);

    const unhealthy = stores
      .filter((store) => store.lastCheckOk === false)
      .map((store) => ({
        id: store.id,
        label: store.label || store.url,
        ownerEmail: store.ownerEmail,
        message: store.lastCheckMessage ?? "The last connection check failed.",
      }));

    return (
      <OperatorDashboardView
        accounts={accounts}
        jobs={[...snapshot.running, ...snapshot.queued, ...snapshot.scheduled, ...snapshot.history]}
        storeCount={stores.length}
        unhealthyStores={unhealthy}
        reveals={reveals}
      />
    );
  }

  const [stores, jobs, expected] = await Promise.all([
    listStores(ownerId),
    listJobs(ownerId, 200),
    expectedPluginVersion(),
  ]);

  return (
    <DashboardView
      stores={stores.map(toPublic)}
      stats={computeStats(jobs)}
      expectedPluginVersion={expected}
    />
  );
}
