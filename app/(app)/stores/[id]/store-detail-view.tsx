"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { JobStatusPill } from "@/components/domain/job-status";
import { STORE_HEALTH_META, storeHealth } from "@/components/domain/store-health";
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  Code,
  CodeBlock,
  ConfirmDialog,
  CopyButton,
  DateTime,
  DescriptionList,
  ElapsedTime,
  EmptyState,
  Icon,
  Panel,
  RelativeTime,
  Stat,
  Tabs,
  TabPanel,
  useToast,
} from "@/components/ui";
import {
  formatDuration,
  formatNumber,
} from "@/lib/format";
import type { JobState } from "@/lib/jobs";
import { isOutdated } from "@/lib/plugin-version";
import type { CheckResult, PublicStore, StoreCheckRecord } from "@/lib/stores";

import { StoreForm } from "../store-form";
import { TaxonomyBrowser } from "./taxonomy-browser";

/**
 * One site in detail.
 *
 * Where everything `/health` reports gets answered in full, where the
 * maintenance actions the plugin exposes are run, where the existing taxonomy
 * can be read, and where both histories live — imports and connection checks.
 */

type TabKey = "health" | "taxonomy" | "imports" | "checks";

/**
 * The stored API secret, on demand.
 *
 * A site API secret in plain text is equivalent to full write access to that
 * site's database, which is why `toPublic()` strips it from every ordinary
 * payload — including the one that rendered this screen. It arrives only when
 * an administrator presses the button, through a POST so it is never in a URL,
 * and the press writes an audit row before the value comes back.
 *
 * A member sees the sentence instead: they replace a secret they have lost,
 * they do not retrieve it.
 */
function SecretValue({ storeId, canReveal }: { storeId: string; canReveal: boolean }) {
  const toast = useToast();
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!canReveal) {
    return <>Encrypted with AES-256-GCM and unreadable</>;
  }

  async function reveal() {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/reveal/store/${storeId}`, { method: "POST" });
      const payload = (await response.json()) as { apiSecret?: string; error?: string };

      if (!response.ok || typeof payload.apiSecret !== "string") {
        toast.error("Could not reveal the secret", payload.error);
        return;
      }

      setSecret(payload.apiSecret);
    } finally {
      setBusy(false);
    }
  }

  if (secret === null) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-ink-muted">Encrypted with AES-256-GCM</span>
        <Button variant="secondary" size="sm" icon="key" loading={busy} onClick={() => void reveal()}>
          Reveal it
        </Button>
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Code>{secret}</Code>
      <CopyButton value={secret} iconOnly />
      <Button variant="ghost" size="sm" onClick={() => setSecret(null)}>
        Hide
      </Button>
    </span>
  );
}

export function StoreDetailView({
  initialStore,
  initialChecks,
  canReveal,
  jobs,
  expectedPluginVersion,
}: {
  initialStore: PublicStore;
  /** Administrators only: read the stored API secret back. Recorded when used. */
  canReveal: boolean;
  initialChecks: StoreCheckRecord[];
  jobs: JobState[];
  expectedPluginVersion: string | null;
}) {
  const toast = useToast();

  const [store, setStore] = useState(initialStore);
  const [checks, setChecks] = useState(initialChecks);
  const [tab, setTab] = useState<TabKey>("health");
  const [busy, setBusy] = useState<"check" | "transients" | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmTransients, setConfirmTransients] = useState(false);

  const health = storeHealth(store, expectedPluginVersion);
  const meta = STORE_HEALTH_META[health];

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/stores/${store.id}`, { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as {
      store: PublicStore;
      checks: StoreCheckRecord[];
    };
    setStore(payload.store);
    setChecks(payload.checks);
  }, [store.id]);

  async function check() {
    setBusy("check");
    try {
      const response = await fetch(`/api/stores/${store.id}/check`, { method: "POST" });
      const payload = (await response.json()) as { result?: CheckResult; error?: string };

      if (!response.ok || !payload.result) {
        toast.error("The check failed", payload.error);
        return;
      }

      await refresh();

      if (payload.result.ok) {
        toast.success("Connection is healthy", payload.result.message);
      } else {
        toast.error("This site has a problem", payload.result.message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function clearTransients() {
    setBusy("transients");
    try {
      const response = await fetch(`/api/stores/${store.id}/maintenance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear-transients" }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        elapsedMs?: number;
        error?: string;
      };

      if (!response.ok) {
        toast.error("Could not clear the transients", payload.error);
        return;
      }

      toast.success(
        `Transients cleared in ${formatDuration(payload.elapsedMs ?? 0)}`,
        payload.message,
      );
    } finally {
      setBusy(null);
      setConfirmTransients(false);
    }
  }

  const stats = useMemo(() => {
    const finished = jobs.filter((job) => job.status !== "queued" && job.status !== "running");
    return {
      jobs: finished.length,
      products: finished.reduce((sum, job) => sum + job.succeeded, 0),
      failed: finished.reduce((sum, job) => sum + job.failed, 0),
      deduplicated: finished.reduce((sum, job) => sum + job.deduplicated, 0),
    };
  }, [jobs]);

  return (
    <div className="space-y-5">
      {/* ---------------------------------------------------------------- Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <ButtonLink href="/stores" size="sm" variant="ghost" icon="arrow-left">
            Sites
          </ButtonLink>
          <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold text-ink">
            <span className="truncate">{store.label || store.url}</span>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </h2>
          <a
            href={store.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 truncate text-xs text-accent-fg hover:underline"
          >
            <Icon name="external-link" className="size-3" />
            {store.url}
          </a>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon="refresh"
            loading={busy === "check"}
            onClick={() => void check()}
          >
            Check the connection
          </Button>
          <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <ButtonLink href="/import" variant="primary" icon="upload">
            Import to this site
          </ButtonLink>
        </div>
      </div>

      {/* -------------------------------------------------------------- Warnings */}
      {store.missingFunctions.length > 0 ? (
        <Alert
          tone="bad"
          title={`${store.missingFunctions.length} stored function(s) missing — imports will fail`}
        >
          <p>
            Open <strong>GOP_IMPORT → Status</strong> in the site&rsquo;s wp-admin and press{" "}
            <strong>Install / Reinstall</strong>. If MySQL answers with error 1419, ask the host to
            run{" "}
            <Code>SET GLOBAL log_bin_trust_function_creators = 1;</Code>
          </p>
          <div className="mt-2">
            <CodeBlock code={store.missingFunctions.join("\n")} language="missing" />
          </div>
        </Alert>
      ) : null}

      {isOutdated(store.pluginVersion, expectedPluginVersion) ? (
        <Alert tone="warn" title={`This site is running plugin ${store.pluginVersion}`}>
          The current build is {expectedPluginVersion}. The data contract this app speaks was
          written for that build — update the plugin before running anything large.
        </Alert>
      ) : null}

      {store.lastCheckOk === false && store.missingFunctions.length === 0 ? (
        <Alert tone="bad" title="The last check failed">
          {store.lastCheckMessage}
        </Alert>
      ) : null}

      {store.lastCheckOk === null ? (
        <Alert
          tone="info"
          title="This site has never been checked"
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon="shield-check"
              loading={busy === "check"}
              onClick={() => void check()}
            >
              Check it now
            </Button>
          }
        >
          Run a check to find out whether the plugin has all its stored functions, before pushing the first batch.
        </Alert>
      ) : null}

      {/* ------------------------------------------------------------ Throughput */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Products published"
          value={formatNumber(stats.products)}
          icon="package"
          hint={`across ${formatNumber(stats.jobs)} run(s)`}
        />
        <Stat
          label="Failed rows"
          value={formatNumber(stats.failed)}
          tone={stats.failed > 0 ? "bad" : "neutral"}
          icon="alert-circle"
        />
        <Stat
          label="Already present"
          value={formatNumber(stats.deduplicated)}
          tone={stats.deduplicated > 0 ? "info" : "neutral"}
          icon="layers"
          hint="existed already, nothing recreated"
        />
        <Stat
          label="Check latency"
          value={store.lastCheckMs === null ? "—" : formatDuration(store.lastCheckMs)}
          icon="clock"
          hint={<RelativeTime iso={store.lastCheckedAt} />}
        />
      </section>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "health", label: "Health and maintenance", icon: "shield-check" },
          { value: "taxonomy", label: "Categories and tags", icon: "tag" },
          { value: "imports", label: "Import history", icon: "history", count: jobs.length },
          { value: "checks", label: "Check history", icon: "activity", count: checks.length },
        ]}
      />

      <TabPanel id="store-tabs" value="health" active={tab === "health"}>
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel title="What the plugin's /health reports" icon="database">
            <DescriptionList
              columns={2}
              items={[
                {
                  term: "Plugin version",
                  value: store.pluginVersion ?? "unknown",
                  hint: expectedPluginVersion
                    ? `current build: ${expectedPluginVersion}`
                    : undefined,
                },
                { term: "PHP", value: store.phpVersion ?? "unknown" },
                { term: "MySQL", value: store.mysqlVersion ?? "unknown" },
                {
                  term: "Table prefix",
                  value: store.tablePrefix ? <Code>{store.tablePrefix}</Code> : "unknown",
                },
                {
                  term: "site_url as the plugin reports it",
                  value: store.siteUrl ?? "unknown",
                  hint: "Used to build links to products in wp-admin.",
                  wide: true,
                },
                {
                  term: "Missing stored functions",
                  value:
                    store.missingFunctions.length === 0 ? (
                      <span className="inline-flex items-center gap-1 text-ok-fg">
                        <Icon name="check" className="size-3.5" />
                        All installed
                      </span>
                    ) : (
                      store.missingFunctions.join(", ")
                    ),
                  wide: true,
                },
                {
                  term: "Last checked",
                  value: <DateTime iso={store.lastCheckedAt} />,
                  hint: store.lastCheckMessage ?? undefined,
                  wide: true,
                },
              ]}
            />
          </Panel>

          <div className="space-y-5">
            <Panel title="Maintenance" icon="broom">
              <div className="space-y-3">
                <Card tone="sunken">
                  <CardBody className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">Clear WooCommerce transients</p>
                      <p className="text-xs text-ink-subtle">
                        The plugin writes straight to the database, so WooCommerce never clears its
                        own price cache. Run this when category pages show the wrong prices.
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      icon="broom"
                      loading={busy === "transients"}
                      onClick={() => setConfirmTransients(true)}
                    >
                      Clear them
                    </Button>
                  </CardBody>
                </Card>

                <Alert tone="info" title="Recalculating min/max price cannot be triggered from here">
                  That action exists on the Maintenance tab in wp-admin, but the plugin exposes no
                  HTTP route for it, so this app cannot reach it. Run it directly in{" "}
                  <strong>GOP_IMPORT → Maintenance</strong> on the site.
                </Alert>
              </div>
            </Panel>

            <Panel title="Connection settings" icon="key">
              <DescriptionList
                columns={1}
                items={[
                  {
                    term: "API key",
                    value: (
                      <span className="flex items-center gap-2">
                        <Code>{store.apiKey}</Code>
                        <CopyButton value={store.apiKey} iconOnly />
                      </span>
                    ),
                  },
                  {
                    term: "API secret",
                    value: <SecretValue storeId={store.id} canReveal={canReveal} />,
                    hint: canReveal
                      ? "Revealing it is recorded: your account, the owning account, and the time."
                      : "If the secret is lost, mint a new pair in wp-admin and press Edit here to replace it.",
                  },
                  { term: "Pin", value: store.pin === "" ? "not used" : <Code>{store.pin}</Code> },
                  {
                    term: "The /GPM/<pin> rewrite",
                    value: store.urlRewrite ? "on" : "off",
                  },
                  {
                    term: "Plugin base URL override",
                    value:
                      store.baseUrlOverride === "" ? (
                        "the default convention"
                      ) : (
                        <Code>{store.baseUrlOverride}</Code>
                      ),
                    wide: true,
                  },
                  { term: "Connected", value: <DateTime iso={store.connectedAt} /> },
                ]}
              />
            </Panel>
          </div>
        </div>
      </TabPanel>

      <TabPanel id="store-tabs" value="taxonomy" active={tab === "taxonomy"}>
        <Panel
          title="Taxonomy as it exists on the site"
          icon="tag"
          description="Read straight from the database through the plugin's /terms route"
        >
          <TaxonomyBrowser storeId={store.id} />
        </Panel>
      </TabPanel>

      <TabPanel id="store-tabs" value="imports" active={tab === "imports"}>
        <Panel title="Import history" icon="history" padded={jobs.length === 0}>
          {jobs.length === 0 ? (
            <EmptyState
              icon="history"
              title="Nothing has been published to this site yet"
              description="History is kept for 7 days."
              action={
                <ButtonLink href="/import" variant="primary" icon="upload">
                  Run the first import
                </ButtonLink>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {jobs.map((job) => (
                <li key={job.id}>
                  <Link
                    href={`/process/${job.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors duration-fast hover:bg-surface-sunken"
                  >
                    <JobStatusPill job={job} />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {job.sourceLabel}
                    </span>
                    <span className="flex shrink-0 flex-wrap gap-1">
                      <Badge tone="ok">{formatNumber(job.succeeded)} ok</Badge>
                      {job.deduplicated > 0 ? (
                        <Badge tone="info">{formatNumber(job.deduplicated)} present</Badge>
                      ) : null}
                      {job.failed > 0 ? (
                        <Badge tone="bad">{formatNumber(job.failed)} failed</Badge>
                      ) : null}
                    </span>
                    <span className="tnum hidden shrink-0 text-xs text-ink-subtle sm:block">
                      <ElapsedTime from={job.startedAt} to={job.finishedAt} />
                    </span>
                    <span className="tnum hidden shrink-0 text-xs text-ink-subtle lg:block">
                      <DateTime iso={job.createdAt} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </TabPanel>

      <TabPanel id="store-tabs" value="checks" active={tab === "checks"}>
        <Panel title="Connection check history" icon="activity" padded={checks.length === 0}>
          {checks.length === 0 ? (
            <EmptyState
              icon="shield-check"
              title="No checks yet"
              description="Every connection check writes a row here; the last 50 are kept."
              action={
                <Button
                  variant="primary"
                  icon="shield-check"
                  loading={busy === "check"}
                  onClick={() => void check()}
                >
                  Check it now
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {checks.map((record, index) => (
                <li
                  key={`${record.at}-${index}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
                >
                  <Badge tone={record.ok ? "ok" : "bad"} icon={record.ok ? "check" : "x"}>
                    {record.ok ? "Healthy" : "Failed"}
                  </Badge>
                  <span className="tnum shrink-0 text-xs text-ink-muted">
                    <DateTime iso={record.at} />
                  </span>
                  <span className="tnum shrink-0 text-xs text-ink-subtle">
                    {formatDuration(record.elapsedMs)}
                  </span>
                  {record.version ? (
                    <Badge tone="neutral">plugin {record.version}</Badge>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-subtle">
                    {record.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </TabPanel>

      <StoreForm
        open={editing}
        store={store}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          await refresh();
          toast.success("Changes saved", "The connection settings changed — run the check again.");
        }}
      />

      <ConfirmDialog
        open={confirmTransients}
        onClose={() => setConfirmTransients(false)}
        onConfirm={() => void clearTransients()}
        busy={busy === "transients"}
        tone="primary"
        title="Clear WooCommerce transients?"
        confirmLabel="Clear them"
        message={
          <>
            <p>
              Calls the cleanup procedure on the site directly. It clears WooCommerce&rsquo;s price and
              category caches; products and data are NOT touched.
            </p>
            <p className="mt-2">
              On a large site the next category page load will be slower than usual while
              WooCommerce rebuilds the cache.
            </p>
          </>
        }
      />
    </div>
  );
}
