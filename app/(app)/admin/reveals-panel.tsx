"use client";

import {
  Alert,
  Badge,
  DataTable,
  DateTime,
  EmptyState,
  Panel,
  type Column,
} from "@/components/ui";
import type { RevealKind, RevealRecord } from "@/lib/audit";

const KIND: Record<RevealKind, string> = {
  store_api_secret: "Site API secret",
  s3_secret_key: "AWS secret key",
};

/**
 * Every stored secret an administrator has read back.
 *
 * Read-only and never emptied from the interface. An operator repairing a
 * customer's bucket is ordinary work; what this list is for is being able to
 * tell that apart from anything else, later, when nobody remembers the week it
 * happened.
 *
 * No row here contains a secret. "Which one" is a site URL or a bucket name.
 */
export function RevealsPanel({ reveals }: { reveals: RevealRecord[] }) {
  const columns: Column<RevealRecord>[] = [
    {
      key: "at",
      header: "When",
      width: "12rem",
      sortable: true,
      sortValue: (row) => row.at,
      cell: (row) => <DateTime iso={row.at} />,
    },
    {
      key: "actor",
      header: "Administrator",
      sortable: true,
      sortValue: (row) => row.actorEmail,
      cell: (row) => <span className="truncate text-ink">{row.actorEmail}</span>,
    },
    {
      key: "target",
      header: "Account",
      sortable: true,
      sortValue: (row) => row.targetEmail,
      cell: (row) => <span className="truncate font-medium text-ink">{row.targetEmail}</span>,
    },
    {
      key: "kind",
      header: "Secret",
      width: "11rem",
      cell: (row) => (
        <Badge tone={row.kind === "store_api_secret" ? "bad" : "warn"} icon="key">
          {KIND[row.kind]}
        </Badge>
      ),
    },
    {
      key: "subject",
      header: "Which one",
      hideBelow: "md",
      cell: (row) => <span className="truncate text-ink-muted">{row.subjectLabel}</span>,
    },
    {
      key: "ip",
      header: "From",
      hideBelow: "xl",
      width: "10rem",
      cell: (row) => (
        <span className="font-mono text-2xs text-ink-subtle">{row.ipAddress ?? "—"}</span>
      ),
    },
  ];

  return (
    <Panel
      title="Secret reveals"
      icon="key"
      description="Every time a stored secret was read back, and by whom"
    >
      <div className="space-y-4">
        <Alert tone="info" title="This list is the point of the capability, not a restriction on it">
          Administrators can read any account&rsquo;s stored site secrets and AWS keys, because
          repairing a customer&rsquo;s configuration needs the real value. Members cannot reveal a
          stored secret at all — not even their own; they overwrite it instead. That is what makes
          this list complete.
        </Alert>

        {reveals.length === 0 ? (
          <EmptyState
            icon="key"
            title="No secret has been revealed"
            description="Nothing has read a stored site secret or AWS key back out of the database."
            action={null}
          />
        ) : (
          <DataTable
            rows={reveals}
            columns={columns}
            rowKey={(row) => row.id}
            caption="Every stored secret read back, newest first"
            defaultSort={{ key: "at", direction: "desc" }}
          />
        )}
      </div>
    </Panel>
  );
}
