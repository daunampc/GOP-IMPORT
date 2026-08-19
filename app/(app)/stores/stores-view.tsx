"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { STORE_HEALTH_META, storeHealth } from "@/components/domain/store-health";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  RelativeTime,
  Icon,
  Panel,
  Stat,
  Tooltip,
  useToast,
  type Column,
} from "@/components/ui";
import { formatDuration, formatNumber } from "@/lib/format";
import { isOutdated } from "@/lib/plugin-version";
import type { CheckResult, PublicStore } from "@/lib/stores";

import { StoreForm } from "./store-form";

/**
 * The site list.
 *
 * The big change: a green/red dot is now a verdict with words on it, and
 * everything `/health` returns is put to use — plugin version, PHP, MySQL,
 * table prefix, and the list of missing stored functions. The full detail lives
 * on each site's own page.
 */
export function StoresView({
  initial,
  expectedPluginVersion,
  autoCheck,
}: {
  initial: PublicStore[];
  expectedPluginVersion: string | null;
  autoCheck: boolean;
}) {
  const router = useRouter();
  const toast = useToast();

  const [stores, setStores] = useState(initial);
  const [checking, setChecking] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<PublicStore | null | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<PublicStore | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/stores", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { stores: PublicStore[] };
    setStores(payload.stores);
  }, []);

  const checkAll = useCallback(async () => {
    setChecking("all");
    try {
      const response = await fetch("/api/stores/check", { method: "POST" });
      const payload = (await response.json()) as {
        results?: CheckResult[];
        ok?: number;
        failed?: number;
        error?: string;
      };

      if (!response.ok || !payload.results) {
        toast.error("The check failed", payload.error);
        return;
      }

      await refresh();

      if ((payload.failed ?? 0) > 0) {
        toast.warn(
          `${payload.failed} site(s) have a problem`,
          `${payload.ok} site(s) are healthy. Open each one for the detail.`,
        );
      } else {
        toast.success(`All ${payload.ok} sites are healthy`);
      }
    } finally {
      setChecking(null);
    }
  }, [refresh, toast]);

  // The command palette opens this screen with `?check=all` to run the checks straight away.
  //
  // `queueMicrotask` is deliberate: `checkAll()` raises its busy flag the moment
  // it is called, and raising it inside the effect body means the first render
  // is immediately followed by a second. Deferring to the next microtask lets
  // the first paint complete before the busy state appears.
  useEffect(() => {
    if (!autoCheck || stores.length === 0) {
      return;
    }

    queueMicrotask(() => {
      void checkAll();
      router.replace("/stores");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, only when the page is entered with ?check=all
  }, [autoCheck]);

  async function checkOne(store: PublicStore) {
    setChecking(store.id);
    try {
      const response = await fetch(`/api/stores/${store.id}/check`, { method: "POST" });
      const payload = (await response.json()) as { result?: CheckResult; error?: string };

      if (!response.ok || !payload.result) {
        toast.error("The check failed", payload.error);
        return;
      }

      await refresh();

      if (payload.result.ok) {
        toast.success(
          `${store.label || store.url} is healthy`,
          `plugin ${payload.result.version} · ${payload.result.elapsedMs} ms`,
        );
      } else {
        toast.error(`${store.label || store.url} has a problem`, payload.result.message);
      }
    } finally {
      setChecking(null);
    }
  }

  async function remove() {
    if (confirmDelete === null) {
      return;
    }

    setDeleting(true);
    try {
      const response = await fetch(`/api/stores/${confirmDelete.id}`, { method: "DELETE" });
      if (!response.ok) {
        toast.error("Could not remove the site");
        return;
      }
      toast.success(`Removed ${confirmDelete.label || confirmDelete.url}`);
      await refresh();
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  }

  const summary = useMemo(() => {
    const health = stores.map((store) => storeHealth(store, expectedPluginVersion));
    return {
      ok: health.filter((entry) => entry === "ok").length,
      broken: health.filter((entry) => entry === "broken").length,
      outdated: health.filter((entry) => entry === "outdated").length,
      unknown: health.filter((entry) => entry === "unknown").length,
    };
  }, [stores, expectedPluginVersion]);

  const columns = useMemo<Column<PublicStore>[]>(
    () => [
      {
        key: "store",
        header: "Site",
        sortable: true,
        sortValue: (store) => store.label || store.url,
        cell: (store) => {
          const meta = STORE_HEALTH_META[storeHealth(store, expectedPluginVersion)];
          return (
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className={`size-2 shrink-0 rounded-full ${
                    meta.tone === "ok"
                      ? "bg-ok"
                      : meta.tone === "bad"
                        ? "bg-bad"
                        : meta.tone === "warn"
                          ? "bg-warn"
                          : "bg-ink-subtle"
                  }`}
                />
                <span className="truncate text-sm font-medium text-ink">
                  {store.label || store.url}
                </span>
              </div>
              <span className="block truncate text-2xs text-ink-subtle">{store.url}</span>
            </div>
          );
        },
      },
      {
        key: "health",
        header: "Health",
        width: "11rem",
        sortable: true,
        sortValue: (store) => storeHealth(store, expectedPluginVersion),
        cell: (store) => {
          const meta = STORE_HEALTH_META[storeHealth(store, expectedPluginVersion)];
          return (
            <Tooltip content={store.lastCheckMessage ?? "No check has been run yet."}>
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </Tooltip>
          );
        },
      },
      {
        key: "plugin",
        header: "Plugin",
        width: "8rem",
        sortable: true,
        sortValue: (store) => store.pluginVersion ?? "",
        hideBelow: "sm",
        cell: (store) =>
          store.pluginVersion === null ? (
            <span className="text-2xs text-ink-subtle">unknown</span>
          ) : (
            <span
              className={`tnum text-xs ${
                isOutdated(store.pluginVersion, expectedPluginVersion)
                  ? "text-warn-fg"
                  : "text-ink"
              }`}
            >
              {store.pluginVersion}
              {isOutdated(store.pluginVersion, expectedPluginVersion) ? (
                <span className="block text-2xs text-ink-subtle">
                  {expectedPluginVersion} available
                </span>
              ) : null}
            </span>
          ),
      },
      {
        key: "env",
        header: "Environment",
        hideBelow: "lg",
        cell: (store) => (
          <span className="block text-2xs text-ink-muted">
            {store.phpVersion ? `PHP ${store.phpVersion}` : "PHP —"}
            {" · "}
            {store.mysqlVersion ? `MySQL ${store.mysqlVersion}` : "MySQL —"}
            {store.tablePrefix ? (
              <span className="block font-mono">prefix {store.tablePrefix}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: "missing",
        header: "Stored function",
        width: "10rem",
        hideBelow: "xl",
        cell: (store) =>
          store.missingFunctions.length === 0 ? (
            <span className="inline-flex items-center gap-1 text-2xs text-ok-fg">
              <Icon name="check" className="size-3" />
              Complete
            </span>
          ) : (
            <Tooltip content={store.missingFunctions.join(", ")}>
              <Badge tone="bad" icon="alert-circle">
                {store.missingFunctions.length} missing
              </Badge>
            </Tooltip>
          ),
      },
      {
        key: "checked",
        header: "Checked",
        width: "9rem",
        sortable: true,
        sortValue: (store) => store.lastCheckedAt ?? "",
        hideBelow: "md",
        cell: (store) => (
          <span className="block text-2xs text-ink-muted">
            <RelativeTime iso={store.lastCheckedAt} />
            {store.lastCheckMs !== null ? (
              <span className="tnum block text-ink-subtle">
                {formatDuration(store.lastCheckMs)}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        width: "13rem",
        cell: (store) => (
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              icon="refresh"
              loading={checking === store.id}
              onClick={(event) => {
                event.stopPropagation();
                void checkOne(store);
              }}
            >
              Check
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="edit"
              onClick={(event) => {
                event.stopPropagation();
                setFormFor(store);
              }}
              aria-label={`Edit ${store.label || store.url}`}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              onClick={(event) => {
                event.stopPropagation();
                setConfirmDelete(store);
              }}
              aria-label={`Remove ${store.label || store.url}`}
            />
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- checkOne is stable across refresh/toast
    [expectedPluginVersion, checking],
  );

  return (
    <div className="space-y-5">
      {stores.length > 0 ? (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Healthy" value={formatNumber(summary.ok)} tone="ok" icon="check-circle" />
          <Stat
            label="Unreachable"
            value={formatNumber(summary.broken)}
            tone={summary.broken > 0 ? "bad" : "neutral"}
            icon="alert-circle"
          />
          <Stat
            label="Older plugin"
            value={formatNumber(summary.outdated)}
            tone={summary.outdated > 0 ? "warn" : "neutral"}
            icon="alert-triangle"
            hint={expectedPluginVersion ? `current build ${expectedPluginVersion}` : "current build unknown"}
          />
          <Stat
            label="Not checked"
            value={formatNumber(summary.unknown)}
            icon="clock"
            tone={summary.unknown > 0 ? "warn" : "neutral"}
          />
        </section>
      ) : null}

      {expectedPluginVersion === null ? (
        <Alert tone="info" title="The current plugin version could not be read">
          There is no <code className="font-mono">version.txt</code> at the plugin repository root
          and <code className="font-mono">GOP_PLUGIN_VERSION</code> is unset — so this app cannot
          warn when a site runs an older build. Everything else works normally.
        </Alert>
      ) : null}

      <Panel
        title={`Sites (${stores.length})`}
        icon="store"
        padded={stores.length === 0}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon="shield-check"
              loading={checking === "all"}
              disabled={stores.length === 0}
              onClick={() => void checkAll()}
            >
              Check them all
            </Button>
            <Button variant="primary" size="sm" icon="plus" onClick={() => setFormFor(null)}>
              Connect a site
            </Button>
          </div>
        }
      >
        {stores.length === 0 ? (
          <EmptyState
            icon="store"
            title="No sites connected"
            description="Open GOP_IMPORT → Connection in the site's wp-admin to get its API key and secret (the secret is shown exactly once), then add it here."
            action={
              <Button variant="primary" icon="plus" onClick={() => setFormFor(null)}>
                Add the first site
              </Button>
            }
          />
        ) : (
          <DataTable
            caption="Connected sites"
            rows={stores}
            columns={columns}
            rowKey={(store) => store.id}
            onRowClick={(store) => router.push(`/stores/${store.id}`)}
            rowTone={(store) => {
              const health = storeHealth(store, expectedPluginVersion);
              return health === "broken" ? "bad" : health === "outdated" ? "warn" : "none";
            }}
            paginate={false}
          />
        )}
      </Panel>

      {formFor !== undefined ? (
        <StoreForm
          open
          store={formFor}
          onClose={() => setFormFor(undefined)}
          onSaved={async () => {
            await refresh();
            toast.success(formFor === null ? "Site added" : "Changes saved");
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => void remove()}
        busy={deleting}
        title="Remove this site connection?"
        confirmLabel="Remove the site"
        message={
          <>
            <p>
              Removes <strong>{confirmDelete?.label || confirmDelete?.url}</strong> from the list.
              Products already published to the site are NOT touched.
            </p>
            <p className="mt-2">
              But any queued run aimed at this site will fail with “the target site was removed
              from the list”, and its history loses every link to a product.
            </p>
            <p className="mt-2">
              To change only the URL or the keys, use <strong>Edit</strong> rather than removing
              and re-adding.
            </p>
          </>
        }
      />
    </div>
  );
}
