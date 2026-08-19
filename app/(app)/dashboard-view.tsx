"use client";

import Link from "next/link";
import { useMemo } from "react";

import { JOB_STATUS, JobStatusPill } from "@/components/domain/job-status";
import { STORE_HEALTH_META, storeHealth } from "@/components/domain/store-health";
import { jobPercent, useJobs } from "@/components/shell/jobs-provider";
import {
  Alert,
  BarChart,
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  ElapsedTime,
  EmptyState,
  Icon,
  Panel,
  ProgressBar,
  StackedBar,
  Stat,
  StatusPill,
  RelativeTime,
  Tooltip,
} from "@/components/ui";
import {
  formatDayLabel,
  formatDuration,
  formatNumber,
  formatPercent,
  formatThroughput,
} from "@/lib/format";
import { isOutdated } from "@/lib/plugin-version";
import type { Stats } from "@/lib/stats";
import type { PublicStore } from "@/lib/stores";

/**
 * The dashboard.
 *
 * The previous home page was a `redirect("/import")` — there was nowhere that
 * answered "is anything wrong right now" without visiting three screens.
 *
 * The order down the page is the order of urgency: things needing attention
 * first (because they demand action), then runs in flight, then throughput,
 * then the sites.
 */
export function DashboardView({
  stores,
  stats,
  expectedPluginVersion,
}: {
  stores: PublicStore[];
  stats: Stats;
  expectedPluginVersion: string | null;
}) {
  const { snapshot } = useJobs();

  const todo = useMemo(() => {
    const items: Array<{
      id: string;
      tone: "bad" | "warn";
      title: string;
      detail: string;
      href: string;
      action: string;
    }> = [];

    for (const store of stores) {
      if (store.lastCheckOk === false) {
        items.push({
          id: `broken-${store.id}`,
          tone: "bad",
          title: `${store.label || store.url} is unreachable`,
          detail: store.lastCheckMessage ?? "No reason reported.",
          href: `/stores/${store.id}`,
          action: "Open the site",
        });
        continue;
      }

      if (store.missingFunctions.length > 0) {
        items.push({
          id: `missing-${store.id}`,
          tone: "bad",
          title: `${store.label || store.url} is missing ${store.missingFunctions.length} stored function(s)`,
          detail: `Imports will fail until they are reinstalled: ${store.missingFunctions.join(", ")}`,
          href: `/stores/${store.id}`,
          action: "See the detail",
        });
        continue;
      }

      if (isOutdated(store.pluginVersion, expectedPluginVersion)) {
        items.push({
          id: `outdated-${store.id}`,
          tone: "warn",
          title: `${store.label || store.url} is running plugin ${store.pluginVersion}`,
          detail: `The current build is ${expectedPluginVersion}. Update it to match the data contract this app speaks.`,
          href: `/stores/${store.id}`,
          action: "Open the site",
        });
        continue;
      }

      if (store.lastCheckOk === null) {
        items.push({
          id: `unknown-${store.id}`,
          tone: "warn",
          title: `${store.label || store.url} has never been checked`,
          detail: "Run a check before pushing the first batch to this site.",
          href: `/stores/${store.id}`,
          action: "Check it",
        });
      }
    }

    // Runs with failures that were never resent — the thing most often missed,
    // because it sits quietly in the history.
    const retried = new Set(
      snapshot.history.map((job) => job.retryOf).filter((id): id is string => id !== null),
    );

    for (const job of snapshot.history.slice(0, 20)) {
      if (job.failed > 0 && !retried.has(job.id)) {
        items.push({
          id: `failed-${job.id}`,
          tone: "warn",
          title: `${job.failed} failed row(s) not dealt with`,
          detail: `${job.sourceLabel} → ${job.storeLabel}`,
          href: `/process/${job.id}`,
          action: "See the failures",
        });
      }
    }

    return items;
  }, [stores, expectedPluginVersion, snapshot.history]);

  const daily = stats.daily.map((entry) => ({
    label: formatDayLabel(entry.date),
    value: entry.products,
    secondary: entry.failed,
  }));

  const hasActivity = stats.jobs > 0;

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------------ Needs attention */}
      {todo.length > 0 ? (
        <Panel
          title={`Needs attention (${todo.length})`}
          icon="alert-triangle"
          description="What will break the next import if left alone"
        >
          <ul className="space-y-2">
            {todo.map((item) => (
              <li key={item.id}>
                <Alert
                  tone={item.tone}
                  title={item.title}
                  actions={
                    <ButtonLink href={item.href} size="sm" variant="secondary" iconAfter="arrow-right">
                      {item.action}
                    </ButtonLink>
                  }
                >
                  <p className="break-words">{item.detail}</p>
                </Alert>
              </li>
            ))}
          </ul>
        </Panel>
      ) : stores.length === 0 ? (
        /*
         * A brand-new account has no sites, so an empty to-do list means
         * "nothing to check yet", not "everything is healthy". The reassuring
         * version was written when there was one shared set of sites and an
         * empty dashboard could only mean a fresh installation; with an account
         * per customer it is the first thing every new customer reads, and it
         * would be telling them their sites are fine before they have any.
         */
        <Alert
          tone="info"
          title="Nothing here yet"
          actions={
            <ButtonLink href="/stores" size="sm" variant="secondary" iconAfter="arrow-right">
              Connect a site
            </ButtonLink>
          }
        >
          Connect a WooCommerce site and this becomes the place that tells you what needs doing
          before the next import.
        </Alert>
      ) : (
        <Alert tone="ok" title="Nothing needs attention">
          Every site has been checked and is healthy, and no failed rows are waiting to be resent.
        </Alert>
      )}

      {/* ------------------------------------------------------------- In flight */}
      <Panel
        title="Running and queued"
        icon="activity"
        actions={
          <ButtonLink href="/process" size="sm" variant="secondary" iconAfter="arrow-right">
            All activity
          </ButtonLink>
        }
        padded={snapshot.running.length + snapshot.queued.length === 0}
      >
        {snapshot.running.length === 0 && snapshot.queued.length === 0 ? (
          <EmptyState
            icon="activity"
            title="Nothing running"
            description="Choose a file and one or more sites to start a new run."
            action={
              <ButtonLink href="/import" variant="primary" icon="upload">
                Start an import
              </ButtonLink>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {[...snapshot.running, ...snapshot.queued].slice(0, 6).map((job) => (
              <li key={job.id}>
                <Link
                  href={`/process/${job.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors duration-fast hover:bg-surface-sunken"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <JobStatusPill job={job} />
                      <span className="truncate text-sm font-medium text-ink">
                        {job.sourceLabel}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-ink-subtle">
                      → {job.storeLabel}
                      {job.startedAt ? (
                        <>
                          {" · running for "}
                          <ElapsedTime from={job.startedAt} to={job.finishedAt} fallback="…" />
                        </>
                      ) : null}
                    </span>
                  </span>

                  <span className="w-full max-w-64 shrink-0">
                    <ProgressBar
                      value={job.processed}
                      max={job.total}
                      tone={job.failed > 0 ? "warn" : "accent"}
                      label={`Progress of ${job.sourceLabel}`}
                      indeterminate={job.status === "queued"}
                    />
                    <span className="tnum mt-1 flex justify-between text-2xs text-ink-subtle">
                      <span>
                        {formatNumber(job.processed)} / {formatNumber(job.total)} products
                      </span>
                      <span>{job.status === "queued" ? "not started" : `${jobPercent(job)}%`}</span>
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ------------------------------------------------------------ Throughput */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Products processed"
          value={formatNumber(stats.products)}
          icon="package"
          hint={`across ${formatNumber(stats.jobs)} finished run(s)`}
          trailing={
            stats.products > 0 ? (
              <StackedBar
                total={stats.products}
                segments={[
                  {
                    value: stats.succeeded - stats.deduplicated,
                    tone: "ok",
                    label: "Created",
                  },
                  { value: stats.deduplicated, tone: "info", label: "Already present" },
                  { value: stats.failed, tone: "bad", label: "Failed" },
                ]}
              />
            ) : undefined
          }
        />

        <Stat
          label="Success rate"
          value={formatPercent(stats.successRate)}
          tone={
            stats.successRate === null ? "neutral" : stats.successRate >= 0.98 ? "ok" : "warn"
          }
          icon="check-circle"
          hint={`${formatNumber(stats.failed)} failed row(s)`}
        />

        <Stat
          label="Average speed"
          value={formatThroughput(stats.productsPerSecond)}
          icon="zap"
          hint={
            stats.avgBatchMs === null
              ? "not measured yet"
              : `${formatDuration(stats.avgBatchMs)} per batch`
          }
        />

        <Stat
          label="Already present"
          value={formatNumber(stats.deduplicated)}
          tone={stats.deduplicated > 0 ? "info" : "neutral"}
          icon="layers"
          hint="the plugin returned the existing product instead of a duplicate"
        />
      </section>

      <div className="grid gap-5 xl:grid-cols-[3fr_2fr]">
        {/* --------------------------------------------------------- Per day */}
        <Panel
          title="Products imported per day"
          icon="gauge"
          description="The last 14 days · the darker portion is failures"
        >
          {hasActivity ? (
            <BarChart data={daily} height={160} valueSuffix=" products" />
          ) : (
            <EmptyState
              icon="gauge"
              title="Nothing to plot yet"
              description="The chart appears once the first run has finished."
              action={
                <ButtonLink href="/import" variant="primary" icon="upload">
                  Run the first import
                </ButtonLink>
              }
            />
          )}
        </Panel>

        {/* ------------------------------------------------------------ Sites */}
        <Panel
          title={`Sites (${stores.length})`}
          icon="store"
          padded={stores.length === 0}
          actions={
            <ButtonLink href="/stores" size="sm" variant="secondary" iconAfter="arrow-right">
              Manage
            </ButtonLink>
          }
        >
          {stores.length === 0 ? (
            <EmptyState
              icon="store"
              title="No sites connected"
              description="Run setup.php, or open GOP_IMPORT → Connection on the site to get its API key, then add it here."
              action={
                <ButtonLink href="/stores" variant="primary" icon="plus">
                  Add a site
                </ButtonLink>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {stores.map((store) => {
                const health = storeHealth(store, expectedPluginVersion);
                const meta = STORE_HEALTH_META[health];

                return (
                  <li key={store.id}>
                    <Link
                      href={`/stores/${store.id}`}
                      className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-fast hover:bg-surface-sunken"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">
                          {store.label || store.url}
                        </span>
                        <span className="block truncate text-2xs text-ink-subtle">
                          {store.pluginVersion ? `plugin ${store.pluginVersion}` : "version unknown"}
                          {" · "}
                          checked <RelativeTime iso={store.lastCheckedAt} />
                          {store.lastCheckMs !== null ? ` (${store.lastCheckMs} ms)` : ""}
                        </span>
                      </span>
                      <StatusPill tone={meta.tone} label={meta.label} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* ----------------------------------------------------------- Recent runs */}
      {snapshot.history.length > 0 ? (
        <Panel
          title="Recent runs"
          icon="history"
          actions={
            <ButtonLink href="/process" size="sm" variant="secondary" iconAfter="arrow-right">
              See all
            </ButtonLink>
          }
          padded={false}
        >
          <ul className="divide-y divide-line">
            {snapshot.history.slice(0, 5).map((job) => (
              <li key={job.id}>
                <Link
                  href={`/process/${job.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors duration-fast hover:bg-surface-sunken"
                >
                  <JobStatusPill job={job} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">
                    {job.sourceLabel}
                  </span>
                  <span className="hidden min-w-0 max-w-48 truncate text-xs text-ink-subtle sm:block">
                    {job.storeLabel}
                  </span>
                  <span className="tnum flex shrink-0 items-center gap-2 text-xs">
                    <Badge tone="ok">{formatNumber(job.succeeded)} succeeded</Badge>
                    {job.deduplicated > 0 ? (
                      <Tooltip content="Matched an existing idempotency key — the plugin returned the original product instead of creating a second one.">
                        <Badge tone="info">{formatNumber(job.deduplicated)} already present</Badge>
                      </Tooltip>
                    ) : null}
                    {job.failed > 0 ? (
                      <Badge tone="bad">{formatNumber(job.failed)} failed</Badge>
                    ) : null}
                  </span>
                  <span className="tnum hidden shrink-0 text-xs text-ink-subtle lg:block">
                    <ElapsedTime from={job.startedAt} to={job.finishedAt} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* A quick way in, so the dashboard still leads to the work rather than only reporting on it. */}
      <Card tone="accent">
        <CardHeader
          title="Start a new import"
          description="Choose a file, map the columns if needed, read the preview, then push to one or more sites."
          actions={
            <ButtonLink href="/import" variant="primary" icon="upload">
              Open the import wizard
            </ButtonLink>
          }
        />
        <CardBody className="pt-3">
          <p className="flex items-center gap-2 text-xs text-accent-fg">
            <Icon name="command" className="size-3.5" />
            Tip: press <kbd className="font-mono">Ctrl</kbd>/<kbd className="font-mono">⌘</kbd>+
            <kbd className="font-mono">K</kbd> for the command palette, or{" "}
            <kbd className="font-mono">G</kbd> then <kbd className="font-mono">2</kbd> to go
            straight to the import wizard.
          </p>
        </CardBody>
      </Card>

      {/* The status legend stays last: colour is always paired with text, but a
          legend still helps someone reading these screens for the first time. */}
      <p className="flex flex-wrap items-center gap-3 text-2xs text-ink-subtle">
        {Object.entries(JOB_STATUS).map(([status, meta]) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <StatusPill tone={meta.tone} label={meta.label} icon={meta.icon} />
          </span>
        ))}
      </p>
    </div>
  );
}
