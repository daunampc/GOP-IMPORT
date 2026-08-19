"use client";

import { useMemo, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  DataTable,
  DateTime,
  EmptyState,
  Field,
  Input,
  Panel,
  RelativeTime,
  Stat,
  Switch,
  useHydrated,
  useToast,
  type Column,
  type Tone,
} from "@/components/ui";
import { formatNumber, isWithin } from "@/lib/format";
import type { License, LicenseStatus } from "@/lib/licenses";

const STATUS: Record<LicenseStatus, { label: string; tone: Tone }> = {
  available: { label: "Unused", tone: "info" },
  active: { label: "In use", tone: "ok" },
  revoked: { label: "Revoked", tone: "bad" },
  expired: { label: "Expired", tone: "warn" },
};

/**
 * Licence key administration.
 *
 * Keys are shown in full and only here. There is no secret to protect once a
 * key is issued — its whole job is to be handed to somebody — but there is no
 * reason to scatter them across other screens either.
 */
export function AdminView({ initial }: { initial: License[] }) {
  const toast = useToast();

  const [licenses, setLicenses] = useState(initial);
  const [note, setNote] = useState("");
  const [count, setCount] = useState(1);
  /**
   * The term in days, and whether there is one at all.
   *
   * Two pieces of state rather than one nullable number, because "no expiry" and
   * "the field is momentarily empty while being retyped" are different things and
   * conflating them makes the input fight the person using it.
   */
  const [expires, setExpires] = useState(false);
  const [validDays, setValidDays] = useState(30);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<License | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const response = await fetch("/api/admin/licenses", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { licenses: License[] };
    setLicenses(payload.licenses);
  }

  async function create() {
    setCreating(true);
    try {
      const response = await fetch("/api/admin/licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note,
          count,
          // The term, not a deadline: it starts counting when the customer
          // redeems the key, so a batch minted today to sell next month arrives
          // with its full length intact.
          validDays: expires ? validDays : null,
          expiresAt: null,
        }),
      });

      const payload = (await response.json()) as { licenses?: License[]; error?: string };

      if (!response.ok || !payload.licenses) {
        toast.error("Could not create keys", payload.error);
        return;
      }

      await refresh();
      setNote("");
      setCount(1);
      toast.success(
        `Created ${payload.licenses.length} key${payload.licenses.length === 1 ? "" : "s"}`,
        expires
          ? `Each lasts ${validDays} day${validDays === 1 ? "" : "s"} from the moment it is activated — not from now.`
          : "These keys never expire. Copy them now — they are listed below and can be copied any time.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function revoke() {
    if (revoking === null) {
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/admin/licenses/${revoking.id}`, { method: "DELETE" });

      if (!response.ok) {
        toast.error("Could not revoke that key");
        return;
      }

      await refresh();
      toast.success("Key revoked", "Any account holding it loses access on its next request.");
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  }

  const summary = useMemo(
    () => ({
      total: licenses.length,
      active: licenses.filter((entry) => entry.status === "active").length,
      available: licenses.filter((entry) => entry.status === "available").length,
      revoked: licenses.filter((entry) => entry.status === "revoked").length,
    }),
    [licenses],
  );

  const columns = useMemo<Column<License>[]>(
    () => [
      {
        key: "key",
        header: "Key",
        sortable: true,
        sortValue: (row) => row.key,
        cell: (row) => (
          <span className="flex items-center gap-1.5">
            <code className="rounded-xs border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-2xs text-ink">
              {row.key}
            </code>
            <CopyButton value={row.key} iconOnly />
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        width: "8rem",
        sortable: true,
        sortValue: (row) => row.status,
        cell: (row) => <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>,
      },
      {
        key: "who",
        header: "Activated by",
        sortable: true,
        sortValue: (row) => row.activatedByEmail ?? "",
        cell: (row) =>
          row.activatedByEmail === null ? (
            <span className="text-2xs text-ink-subtle">—</span>
          ) : (
            <span className="text-sm text-ink">{row.activatedByEmail}</span>
          ),
      },
      {
        key: "note",
        header: "Note",
        hideBelow: "md",
        cell: (row) =>
          row.note === "" ? (
            <span className="text-2xs text-ink-subtle">—</span>
          ) : (
            <span className="text-xs text-ink-muted">{row.note}</span>
          ),
      },
      {
        key: "expiry",
        header: "Expiry",
        width: "13rem",
        sortable: true,
        // Unredeemed keys with a term sort after dated ones but before "never",
        // so the list groups the way somebody scanning it expects.
        sortValue: (row) => row.expiresAt ?? (row.validDays === null ? "zzz" : "zzy"),
        cell: (row) => <ExpiryCell license={row} />,
      },
      {
        key: "created",
        header: "Created",
        width: "11rem",
        hideBelow: "xl",
        sortable: true,
        sortValue: (row) => row.createdAt,
        cell: (row) => (
          <span className="text-xs text-ink-subtle">
            <DateTime iso={row.createdAt} />
          </span>
        ),
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        width: "7rem",
        cell: (row) =>
          row.status === "revoked" ? null : (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" icon="trash" onClick={() => setRevoking(row)}>
                Revoke
              </Button>
            </div>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-5">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Keys issued" value={formatNumber(summary.total)} icon="key" />
        <Stat label="In use" value={formatNumber(summary.active)} tone="ok" icon="check-circle" />
        <Stat
          label="Unused"
          value={formatNumber(summary.available)}
          tone="info"
          icon="layers"
          hint="ready to hand out"
        />
        <Stat
          label="Revoked"
          value={formatNumber(summary.revoked)}
          tone={summary.revoked > 0 ? "bad" : "neutral"}
          icon="alert-circle"
        />
      </section>

      <Panel title="Issue licence keys" icon="plus">
        <div className="grid items-end gap-4 sm:grid-cols-[1fr_8rem_auto]">
          <Field label="Note" htmlFor="note" optional hint="Who is this batch for?">
            <Input
              id="note"
              value={note}
              placeholder="Warehouse team"
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>

          <Field label="How many" htmlFor="count">
            <Input
              id="count"
              type="number"
              min={1}
              max={50}
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
              className="tnum"
            />
          </Field>

          <Button variant="primary" icon="key" loading={creating} onClick={() => void create()}>
            Generate
          </Button>
        </div>

        {/*
          The term, and the sentence that makes it unambiguous.
          "30 days" on its own invites the reading "expires 30 days from today",
          which is the opposite of what happens and the difference the operator most
          needs to know: a key minted now to sell next month arrives with its full
          thirty days, because nothing counts down until it is redeemed.
        */}
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <Switch
            checked={expires}
            onChange={setExpires}
            label="These keys expire"
            description="Leave off for keys that never expire."
          />

          {expires ? (
            <div className="grid items-end gap-4 sm:grid-cols-[10rem_1fr]">
              <Field label="Days of use" htmlFor="validDays">
                <Input
                  id="validDays"
                  type="number"
                  min={1}
                  max={3650}
                  value={validDays}
                  onChange={(event) => setValidDays(Number(event.target.value))}
                  className="tnum"
                />
              </Field>

              <Alert tone="info" title="Counted from activation, not from today">
                Each key lasts <strong>{validDays === 1 ? "1 day" : `${validDays} days`}</strong> from
                the moment the customer enters it. Mint a batch now and hand them out whenever — a key
                sitting unused loses nothing. Any number of days works; there is no fixed set.
              </Alert>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title={`Licence keys (${licenses.length})`} icon="shield-check" padded={licenses.length === 0}>
        {licenses.length === 0 ? (
          <EmptyState
            icon="key"
            title="No keys issued yet"
            description="Everyone except this administrator account needs a key before they can sign up or use the app."
            action={
              <Button variant="primary" icon="key" loading={creating} onClick={() => void create()}>
                Generate the first key
              </Button>
            }
          />
        ) : (
          <DataTable
            caption="Issued licence keys"
            rows={licenses}
            columns={columns}
            rowKey={(row) => row.id}
            defaultSort={{ key: "created", direction: "desc" }}
            rowTone={(row) =>
              row.status === "revoked" ? "bad" : row.status === "expired" ? "warn" : "none"
            }
          />
        )}
      </Panel>

      <Alert tone="info" title="How access works">
        An account can sign in without a licence, but every screen stays locked until a key is
        activated. Revoking a key removes access on that account&apos;s next request — there is no
        need to sign anybody out.
      </Alert>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => void revoke()}
        busy={busy}
        title="Revoke this licence key?"
        confirmLabel="Revoke key"
        message={
          <>
            <p>
              <code className="font-mono">{revoking?.key}</code>
              {revoking?.activatedByEmail
                ? ` is in use by ${revoking.activatedByEmail}. That account loses access immediately.`
                : " has not been used yet. Nobody is affected."}
            </p>
            <p className="mt-2">
              The key is kept on record rather than deleted, so the history of who activated what
              survives. It can never be reused.
            </p>
          </>
        }
      />
    </div>
  );
}

/**
 * What a key's lifetime looks like, in the three states it can be in.
 *
 * The distinction the operator needs is between a term that has NOT started and a
 * deadline that has. "30 days" against an unused key means thirty days waiting for
 * whoever redeems it; against a key in use it means a date. Showing the same words
 * for both would hide the only interesting thing about this design.
 *
 * The countdown is `RelativeTime`, which is measured from "now" and therefore
 * cannot be rendered on the server — the server's clock and the browser's differ
 * and React reports the mismatch as hydration error #418.
 */
function ExpiryCell({ license }: { license: License }) {
  /*
   * "Expiring soon" is measured against the clock, so it can only be decided in
   * the browser. Two separate rules force this and both are errors here, not
   * warnings: calling `Date.now()` in a render body trips `react-hooks/purity`,
   * and rendering anything clock-derived during SSR gives the server one answer
   * and the first client render another — React hydration error #418.
   *
   * Before hydration the cell simply shows the date without the warning, which is
   * true rather than merely safe.
   */
  const hydrated = useHydrated();

  // Already dated: it has been activated, or the administrator set a hard deadline.
  if (license.expiresAt !== null) {
    const soon =
      hydrated &&
      license.status === "active" &&
      isWithin(license.expiresAt, 7 * 24 * 60 * 60 * 1000);

    return (
      <span className="block text-xs">
        <span className={soon ? "font-medium text-warn-fg" : "text-ink-muted"}>
          <DateTime iso={license.expiresAt} />
        </span>
        <span className="block text-2xs text-ink-subtle">
          <RelativeTime iso={license.expiresAt} />
          {soon ? " · expiring soon" : ""}
        </span>
      </span>
    );
  }

  // A term that has not started counting yet.
  if (license.validDays !== null) {
    return (
      <span className="block text-xs text-ink-muted">
        {license.validDays === 1 ? "1 day" : `${license.validDays} days`}
        <span className="block text-2xs text-ink-subtle">once activated</span>
      </span>
    );
  }

  return <span className="text-2xs text-ink-subtle">Never expires</span>;
}
