"use client";

import Link from "next/link";

import { JobStatusPill } from "@/components/domain/job-status";
import {
  Alert,
  Badge,
  ButtonLink,
  DataTable,
  EmptyState,
  Panel,
  ProgressBar,
  RelativeTime,
  Stat,
  type Column,
} from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { RevealRecord } from "@/lib/audit";
import { JOB_KIND_ICONS, JOB_KIND_LABELS, JOB_KIND_TONES } from "@/lib/job-display";
import type { OwnedJobState } from "@/lib/jobs";
import type { AccountRow } from "@/lib/limits";

/**
 * The operator's dashboard — what an administrator sees instead of the customer
 * one.
 *
 * A different screen rather than the customer dashboard with extra numbers on it.
 * An administrator account has no sites, no runs and no throughput of its own, so
 * the customer dashboard would be a page of zeroes and empty states; and the
 * questions are different anyway. A customer asks "did my import work". An
 * operator asks "is anything wrong across every account, and whose".
 */
export function OperatorDashboardView({
  accounts,
  jobs,
  storeCount,
  unhealthyStores,
  reveals,
}: {
  accounts: AccountRow[];
  jobs: OwnedJobState[];
  storeCount: number;
  unhealthyStores: Array<{ id: string; label: string; ownerEmail: string; message: string }>;
  reveals: RevealRecord[];
}) {
  const live = jobs.filter((job) => job.status === "running" || job.status === "queued");
  const members = accounts.filter((account) => account.role === "member");
  const restricted = accounts.filter(
    (account) =>
      !account.limits.importEnabled ||
      !account.limits.removeEnabled ||
      !account.limits.s3Allowed ||
      account.limits.maxStores !== null ||
      account.limits.maxProductsPerRun !== null ||
      account.limits.maxThreads !== null,
  );

  // Finished runs with failures nobody has resent. The one thing on this screen
  // that is somebody's problem right now.
  const failing = jobs.filter(
    (job) => job.failed > 0 && job.status !== "running" && job.status !== "queued",
  );

  const columns: Column<OwnedJobState>[] = [
    {
      key: "owner",
      header: "Account",
      sortable: true,
      sortValue: (row) => row.ownerEmail,
      cell: (row) => <span className="truncate font-medium text-ink">{row.ownerEmail}</span>,
    },
    {
      key: "kind",
      header: "Kind",
      width: "6rem",
      // Keyed off JOB_KIND_LABELS rather than a ternary: a ternary is what let the
      // `update` kind be labelled "Import" on every screen when it was added.
      cell: (row) => (
        <Badge tone={JOB_KIND_TONES[row.kind]} icon={JOB_KIND_ICONS[row.kind]}>
          {JOB_KIND_LABELS[row.kind]}
        </Badge>
      ),
    },
    {
      key: "source",
      header: "Target",
      hideBelow: "md",
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{row.storeLabel}</p>
          <p className="truncate text-2xs text-ink-subtle">{row.sourceLabel}</p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "8rem",
      cell: (row) => <JobStatusPill job={row} />,
    },
    {
      key: "progress",
      header: "Progress",
      width: "11rem",
      cell: (row) => (
        <div className="space-y-1">
          <ProgressBar
            value={row.total === 0 ? 0 : (row.processed / row.total) * 100}
            tone={row.failed > 0 ? "warn" : "accent"}
          />
          <p className="text-2xs text-ink-subtle">
            {formatNumber(row.processed)} / {formatNumber(row.total)}
          </p>
        </div>
      ),
    },
    {
      key: "createdAt",
      header: "Started",
      hideBelow: "lg",
      width: "9rem",
      sortable: true,
      sortValue: (row) => row.createdAt,
      cell: (row) => <RelativeTime iso={row.createdAt} />,
    },
    {
      key: "open",
      header: "",
      align: "right",
      width: "5rem",
      cell: (row) => (
        <Link
          href={`/process/${row.id}`}
          className="text-2xs font-medium text-accent-fg underline-offset-2 hover:underline"
        >
          Open
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <Alert tone="info" title="This account operates the service — it does not publish products">
        There is no Import or Remove here, and the API refuses them for an administrator
        account. To run something for a customer, open their account from{" "}
        <Link href="/admin" className="font-medium text-accent-fg hover:underline">
          Administration
        </Link>{" "}
        — the run then belongs to them, and uses their site and their S3 bucket.
      </Alert>

      {/* -------------------------------------------------------------- numbers */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          label="Accounts"
          value={formatNumber(accounts.length)}
          icon="store"
          hint={`${formatNumber(members.length)} member${members.length === 1 ? "" : "s"}`}
        />
        <Stat label="Connected sites" value={formatNumber(storeCount)} icon="link" />
        <Stat
          label="Running or queued"
          value={formatNumber(live.length)}
          icon="activity"
          tone={live.length > 0 ? "accent" : "neutral"}
        />
        <Stat
          label="Runs with failures"
          value={formatNumber(failing.length)}
          icon="alert-triangle"
          tone={failing.length > 0 ? "warn" : "neutral"}
          hint="not yet resent"
        />
        <Stat
          label="Restricted accounts"
          value={formatNumber(restricted.length)}
          icon="key"
          hint="a limit has been set"
        />
      </div>

      {/* ------------------------------------------------------ needs attention */}
      {unhealthyStores.length > 0 || failing.length > 0 ? (
        <Panel
          title="Needs attention"
          icon="alert-triangle"
          description="Across every account"
        >
          <ul className="space-y-2">
            {unhealthyStores.map((store) => (
              <li key={store.id}>
                <Alert
                  tone="warn"
                  title={`${store.label} is unhealthy — ${store.ownerEmail}`}
                  actions={
                    <ButtonLink
                      href={`/stores/${store.id}`}
                      size="sm"
                      variant="secondary"
                      iconAfter="arrow-right"
                    >
                      Open the site
                    </ButtonLink>
                  }
                >
                  <p className="break-words">{store.message}</p>
                </Alert>
              </li>
            ))}

            {failing.slice(0, 5).map((job) => (
              <li key={job.id}>
                <Alert
                  tone="warn"
                  title={`${formatNumber(job.failed)} failed row(s) — ${job.ownerEmail}`}
                  actions={
                    <ButtonLink
                      href={`/process/${job.id}`}
                      size="sm"
                      variant="secondary"
                      iconAfter="arrow-right"
                    >
                      See the failures
                    </ButtonLink>
                  }
                >
                  <p className="break-words">
                    {job.sourceLabel} → {job.storeLabel}
                  </p>
                </Alert>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <Alert tone="ok" title="Nothing needs attention">
          Every connected site across every account is healthy, and no finished run has
          failures waiting to be resent.
        </Alert>
      )}

      {/* ---------------------------------------------------------- all activity */}
      <Panel
        title="Activity across every account"
        icon="activity"
        padded={jobs.length === 0}
        actions={
          <ButtonLink href="/admin" size="sm" variant="secondary" iconAfter="arrow-right">
            Administration
          </ButtonLink>
        }
      >
        {jobs.length === 0 ? (
          <EmptyState
            icon="activity"
            title="No runs on the system yet"
            description="Every account's imports and removals appear here as they are started."
            action={null}
          />
        ) : (
          <DataTable
            rows={jobs.slice(0, 25)}
            columns={columns}
            rowKey={(row) => row.id}
            caption="The most recent runs across every account"
            defaultSort={{ key: "createdAt", direction: "desc" }}
            paginate={false}
          />
        )}
      </Panel>

      {/* --------------------------------------------------------- last reveals */}
      {reveals.length > 0 ? (
        <Panel
          title="Recent secret reveals"
          icon="key"
          description="Stored secrets read back out of the database"
          actions={
            <ButtonLink href="/admin" size="sm" variant="secondary" iconAfter="arrow-right">
              Full record
            </ButtonLink>
          }
        >
          <ul className="space-y-1.5 text-xs">
            {reveals.slice(0, 5).map((reveal) => (
              <li key={reveal.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <RelativeTime iso={reveal.at} />
                <span className="text-ink-subtle">·</span>
                <span className="font-medium text-ink">{reveal.actorEmail}</span>
                <span className="text-ink-subtle">read</span>
                <Badge tone={reveal.kind === "store_api_secret" ? "bad" : "warn"}>
                  {reveal.kind === "store_api_secret" ? "a site secret" : "an AWS key"}
                </Badge>
                <span className="text-ink-subtle">for</span>
                <span className="font-medium text-ink">{reveal.targetEmail}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
