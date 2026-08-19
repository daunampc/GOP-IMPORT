"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  DataTable,
  DateTime,
  EmptyState,
  Field,
  Input,
  Modal,
  Panel,
  Switch,
  useToast,
  type Column,
} from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { AccountLimits, AccountRow } from "@/lib/limits";

/**
 * Every account, and the way into one.
 *
 * "Enter" is what §4.5 asks for: open one account and work as if inside it —
 * its sites, its runs, its settings. The mechanics are in `lib/view.ts`; what
 * matters here is that pressing this button changes what EVERY screen shows and
 * what every screen creates, so the confirmation of it is not a toast that
 * fades — it is the persistent warning bar that appears across the top of the
 * application and stays there until the operator leaves.
 */
export function AccountsPanel({
  accounts,
  currentUserId,
  actingAsId,
}: {
  accounts: AccountRow[];
  currentUserId: string;
  actingAsId: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccountRow | null>(null);

  async function enter(account: AccountRow) {
    setBusy(account.id);
    try {
      const response = await fetch("/api/admin/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: account.id }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        toast.error("Could not open that account", payload.error);
        return;
      }

      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function leave() {
    setBusy("leave");
    try {
      await fetch("/api/admin/view", { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const columns: Column<AccountRow>[] = [
    {
      key: "account",
      header: "Account",
      sortable: true,
      sortValue: (row) => row.email,
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.email}</p>
          <p className="truncate text-2xs text-ink-subtle">{row.name}</p>
        </div>
      ),
    },
    {
      key: "role",
      header: "Role",
      width: "7rem",
      cell: (row) =>
        row.role === "admin" ? (
          <Badge tone="info" icon="shield-check">
            Admin
          </Badge>
        ) : (
          <Badge tone="neutral">Member</Badge>
        ),
    },
    {
      key: "state",
      header: "State",
      width: "7rem",
      cell: (row) =>
        row.disabled ? <Badge tone="bad">Disabled</Badge> : <Badge tone="ok">Active</Badge>,
    },
    {
      key: "permissions",
      header: "Allowed",
      cell: (row) => <Allowed limits={row.limits} configured={row.configured} />,
    },
    {
      key: "stores",
      header: "Sites",
      align: "right",
      width: "5rem",
      sortable: true,
      sortValue: (row) => row.stores,
      cell: (row) => formatNumber(row.stores),
    },
    {
      key: "jobs",
      header: "Runs",
      align: "right",
      width: "5rem",
      sortable: true,
      sortValue: (row) => row.jobs,
      cell: (row) => formatNumber(row.jobs),
    },
    {
      key: "createdAt",
      header: "Joined",
      hideBelow: "lg",
      width: "11rem",
      sortable: true,
      sortValue: (row) => row.createdAt,
      cell: (row) => <DateTime iso={row.createdAt} />,
    },
    {
      key: "action",
      header: "",
      align: "right",
      width: "15rem",
      cell: (row) => {
        if (row.id === currentUserId) {
          return (
            <div className="flex items-center justify-end gap-2">
              <span className="text-2xs text-ink-subtle">This is you</span>
              <Button variant="ghost" size="sm" icon="settings" onClick={() => setEditing(row)}>
                Permissions
              </Button>
            </div>
          );
        }

        if (row.id === actingAsId) {
          return (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "leave"}
              onClick={() => void leave()}
            >
              Leave
            </Button>
          );
        }

        return (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" icon="settings" onClick={() => setEditing(row)}>
              Permissions
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon="key"
              loading={busy === row.id}
              onClick={() => void enter(row)}
            >
              Enter
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <Panel
      title="Accounts"
      icon="store"
      description="Every account, and the way into one"
    >
      <div className="space-y-4">
        <Alert tone="warn" title="Entering an account changes what every screen does">
          While you are inside an account you see its sites, its runs and its settings — and
          anything you start belongs to it, including which Amazon S3 bucket a run uploads to. A
          bar across the top of the application says whose account you are in until you leave.
        </Alert>

        {accounts.length === 0 ? (
          <EmptyState icon="store" title="No accounts yet" action={null} />
        ) : (
          <DataTable
            rows={accounts}
            columns={columns}
            rowKey={(row) => row.id}
            caption="Every account on this installation"
            defaultSort={{ key: "createdAt", direction: "asc" }}
            rowTone={(row) => (row.id === actingAsId ? "warn" : "none")}
          />
        )}
      </div>

      {editing !== null ? (
        <PermissionsDialog
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
    </Panel>
  );
}

/**
 * What an account is allowed, at a glance.
 *
 * Shows what is switched OFF and what is capped, never the full list of what is
 * allowed. A row reading "import, remove, S3" for every account is noise the eye
 * learns to skip, and the one account with something switched off is exactly what
 * must not be skipped.
 */
function Allowed({ limits, configured }: { limits: AccountLimits; configured: boolean }) {
  const off: string[] = [];
  if (!limits.importEnabled) off.push("import");
  if (!limits.productEditEnabled) off.push("edit");
  if (!limits.removeEnabled) off.push("remove");
  if (!limits.s3Allowed) off.push("S3");

  const caps: string[] = [];
  if (limits.maxStores !== null) caps.push(`${limits.maxStores} site(s)`);
  if (limits.maxProductsPerRun !== null) {
    caps.push(`${formatNumber(limits.maxProductsPerRun)}/run`);
  }
  if (limits.maxThreads !== null) caps.push(`${limits.maxThreads} lane(s)`);

  if (off.length === 0 && caps.length === 0) {
    return (
      <span className="text-2xs text-ink-subtle">
        {configured ? "Everything, on purpose" : "Everything (no limits set)"}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {off.map((name) => (
        <Badge key={name} tone="bad">
          no {name}
        </Badge>
      ))}
      {caps.map((cap) => (
        <Badge key={cap} tone="warn">
          {cap}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Editing one account's permissions.
 *
 * Every field here is enforced in the route handlers as well — `lib/limits.ts`.
 * Switching import off greys the screen out for that account AND makes
 * `POST /api/import` answer 403, because hiding a button is a courtesy and the
 * API is the boundary.
 */
function PermissionsDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [limits, setLimits] = useState<AccountLimits>(account.limits);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof AccountLimits>(key: K, value: AccountLimits[K]) {
    setLimits((current) => ({ ...current, [key]: value }));
  }

  /** An empty box means "no ceiling", which is null rather than 0. */
  function setCap(key: "maxStores" | "maxProductsPerRun" | "maxThreads", raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      set(key, null);
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    set(key, Number.isNaN(parsed) ? null : Math.max(0, parsed));
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/admin/limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: account.id, ...limits }),
      });

      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        toast.error("Could not save the permissions", payload.error);
        return;
      }

      toast.success("Permissions saved", `Applied to ${account.email} immediately.`);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Permissions — ${account.email}`}
      description="Enforced by the API, not only hidden in the interface."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="save" loading={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Import" hint="Off: this account cannot start an import run at all.">
          <Switch
            checked={limits.importEnabled}
            onChange={(next) => set("importEnabled", next)}
            label={limits.importEnabled ? "Allowed" : "Blocked"}
          />
        </Field>

        <Field
          label="Change existing products"
          hint="Off: this account cannot edit a product or run a bulk change. Its own switch because the worst case is different from an import's — a bulk edit reprices a catalogue and overwrites the only copy of what the prices were."
        >
          <Switch
            checked={limits.productEditEnabled}
            onChange={(next) => set("productEditEnabled", next)}
            label={limits.productEditEnabled ? "Allowed" : "Blocked"}
          />
        </Field>

        <Field
          label="Remove products"
          hint="Off: this account cannot delete products. The most dangerous capability in the product."
        >
          <Switch
            checked={limits.removeEnabled}
            onChange={(next) => set("removeEnabled", next)}
            label={limits.removeEnabled ? "Allowed" : "Blocked"}
          />
        </Field>

        <Field
          label="Amazon S3"
          hint="Off: this account can neither choose the S3 image mode nor store AWS keys."
        >
          <Switch
            checked={limits.s3Allowed}
            onChange={(next) => set("s3Allowed", next)}
            label={limits.s3Allowed ? "Allowed" : "Blocked"}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Max connected sites" hint="Empty = no limit.">
            <Input
              type="number"
              min={0}
              value={limits.maxStores ?? ""}
              placeholder="no limit"
              onChange={(event) => setCap("maxStores", event.target.value)}
            />
          </Field>

          <Field label="Max products per run" hint="Empty = no limit.">
            <Input
              type="number"
              min={0}
              value={limits.maxProductsPerRun ?? ""}
              placeholder="no limit"
              onChange={(event) => setCap("maxProductsPerRun", event.target.value)}
            />
          </Field>

          <Field label="Max parallel batches" hint="Empty = no limit.">
            <Input
              type="number"
              min={1}
              max={32}
              value={limits.maxThreads ?? ""}
              placeholder="no limit"
              onChange={(event) => setCap("maxThreads", event.target.value)}
            />
          </Field>
        </div>

        <Alert tone="info" title="A run over the ceiling is refused, not trimmed">
          A file of 5,000 products against a 1,000 limit fails with a message saying so.
          Quietly importing the first 1,000 and reporting success would publish part of a
          catalogue and leave nobody any the wiser.
        </Alert>
      </div>
    </Modal>
  );
}
