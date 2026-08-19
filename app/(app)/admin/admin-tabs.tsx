"use client";

import { useState } from "react";

import { Tabs, type TabItem } from "@/components/ui";
import type { RevealRecord } from "@/lib/audit";
import type { AllJobsSnapshot } from "@/lib/jobs";
import type { License } from "@/lib/licenses";
import type { AccountRow } from "@/lib/limits";

import { AccountsPanel } from "./accounts-panel";
import { AdminView } from "./admin-view";
import { AllRunsPanel } from "./all-runs-panel";
import { RevealsPanel } from "./reveals-panel";

/**
 * The operator's screen.
 *
 * Four things, and they are four tabs rather than four routes because an
 * operator moves between them constantly — a customer rings, you find the
 * account, you look at their runs, you go into the account, you come back to
 * check the record of what you did.
 */
type Tab = "accounts" | "runs" | "licenses" | "reveals";

export function AdminTabs({
  accounts,
  currentUserId,
  actingAsId,
  jobs,
  licenses,
  reveals,
}: {
  accounts: AccountRow[];
  currentUserId: string;
  actingAsId: string | null;
  jobs: AllJobsSnapshot;
  licenses: License[];
  reveals: RevealRecord[];
}) {
  const [tab, setTab] = useState<Tab>("accounts");

  const items: ReadonlyArray<TabItem<Tab>> = [
    { value: "accounts", label: "Accounts", icon: "store", count: accounts.length },
    {
      value: "runs",
      label: "All runs",
      icon: "activity",
      count: jobs.running.length + jobs.queued.length,
    },
    { value: "licenses", label: "Licences", icon: "key", count: licenses.length },
    { value: "reveals", label: "Secret reveals", icon: "shield-check", count: reveals.length },
  ];

  return (
    <div className="space-y-4">
      <Tabs items={items} value={tab} onChange={setTab} />

      {tab === "accounts" ? (
        <AccountsPanel
          accounts={accounts}
          currentUserId={currentUserId}
          actingAsId={actingAsId}
        />
      ) : null}

      {tab === "runs" ? <AllRunsPanel initial={jobs} /> : null}
      {tab === "licenses" ? <AdminView initial={licenses} /> : null}
      {tab === "reveals" ? <RevealsPanel reveals={reveals} /> : null}
    </div>
  );
}
