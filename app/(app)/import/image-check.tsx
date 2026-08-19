"use client";

import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Code,
  DataTable,
  Panel,
  Stat,
  type Column,
} from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { ImageVerdict } from "@/lib/image-check";
import { IMAGE_MODE_LABELS, IMAGE_MODES } from "@/lib/import-options";

/**
 * Do the image links work? — asked before the run rather than during it, §6 C4.
 *
 * A dead image URL is otherwise discovered halfway through an import: the products
 * are already being written, and the operator reads about it in the log at the point
 * where nothing is left to decide.
 *
 * A BUTTON, not a fetch on mount, for the reasons the panel beside it gives: it is
 * the shape the removal screen uses, and firing a request or reading the clock
 * during render is what produces hydration error #418 and trips
 * `react-hooks/set-state-in-effect`.
 *
 * It does NOT gate Start, unlike "What is already on the site". A broken link is not
 * a reason to refuse to publish a catalogue — the products still import — and a
 * confirmation that blocks on something harmless is a confirmation people learn to
 * click past.
 */

interface ImageAnswer {
  distinct: number;
  checked: number;
  truncated: boolean;
  ok: number;
  warned: number;
  failed: number;
  productsAffected: number;
  results: Array<{
    url: string;
    verdict: ImageVerdict;
    status: number | null;
    contentType: string | null;
    detail: string;
    products: number;
  }>;
  checkedAt: string;
}

const VERDICT_LABELS: Record<ImageVerdict, string> = {
  ok: "Reachable",
  not_an_image: "Not an image",
  not_found: "Dead link",
  refused: "Refused",
  unreachable: "No answer",
  blocked: "Private address",
};

export function ImageCheck({
  previewId,
  images,
  imageMode,
}: {
  previewId: string;
  /** Distinct links the preview counted, so the panel can say what it will ask about. */
  images: number;
  imageMode: (typeof IMAGE_MODES)[number];
}) {
  const [answer, setAnswer] = useState<ImageAnswer | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setError(null);

    try {
      const response = await fetch("/api/import/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previewId }),
      });

      const payload = (await response.json()) as Partial<ImageAnswer> & { error?: string };

      if (!response.ok || payload.distinct === undefined) {
        setError(payload.error ?? "Could not check the image links.");
        return;
      }

      setAnswer(payload as ImageAnswer);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setChecking(false);
    }
  }

  const columns: Column<ImageAnswer["results"][number]>[] = [
    {
      key: "url",
      header: "Link",
      cell: (row) => (
        // Wrapped, never truncated: the part of a URL that explains the problem is
        // usually the end of it, which is exactly what an ellipsis removes.
        <span className="block break-all font-mono text-2xs text-ink-muted">{row.url}</span>
      ),
    },
    {
      key: "verdict",
      header: "What happened",
      width: "10rem",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={row.verdict === "not_an_image" ? "warn" : "bad"}>
            {VERDICT_LABELS[row.verdict]}
          </Badge>
          {row.status === null ? null : <Code>{String(row.status)}</Code>}
        </span>
      ),
    },
    {
      key: "detail",
      header: "Detail",
      hideBelow: "md",
      cell: (row) => <span className="text-xs text-ink-muted">{row.detail}</span>,
    },
    {
      key: "products",
      header: "Products",
      width: "6rem",
      cell: (row) => (
        <span className="tnum text-xs text-ink">{formatNumber(row.products)}</span>
      ),
    },
  ];

  return (
    <Panel
      title="Do the image links work?"
      icon="image"
      description={`${formatNumber(images)} distinct link(s) in this file — a dead one is otherwise only found part-way through the run`}
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon={answer === null ? "search" : "refresh"}
          loading={checking}
          onClick={() => void check()}
        >
          {answer === null ? "Check the links" : "Check again"}
        </Button>
      }
    >
      <div className="space-y-4">
        {error ? (
          <Alert tone="bad" title="Could not check the links">
            {error}
          </Alert>
        ) : null}

        {answer === null ? (
          <Alert tone="neutral" title="Not checked yet">
            <p>
              One request per distinct link, asking only for its headers — nothing is
              downloaded and nothing is written. Optional: the run works either way, and
              in <strong>{IMAGE_MODE_LABELS[imageMode]}</strong> mode a link that fails
              leaves that product without its image rather than stopping anything.
            </p>
          </Alert>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat
                label="Reachable"
                value={formatNumber(answer.ok)}
                icon="check"
                tone={answer.ok > 0 ? "ok" : "neutral"}
                hint="answered with an image"
              />
              <Stat
                label="Worth a look"
                value={formatNumber(answer.warned)}
                icon="info"
                tone={answer.warned > 0 ? "warn" : "neutral"}
                hint="answered, but not with an image"
              />
              <Stat
                label="Broken"
                value={formatNumber(answer.failed)}
                icon="x"
                tone={answer.failed > 0 ? "bad" : "neutral"}
                hint={`on ${formatNumber(answer.productsAffected)} product(s)`}
              />
            </div>

            {/*
              Both numbers, always. Saying "200 links checked" while a file carries
              4,000 would present a page as everything, which is the one thing every
              count on every screen here refuses to do.
            */}
            {answer.truncated ? (
              <Alert tone="warn" title="Not every link was checked">
                <p>
                  {formatNumber(answer.checked)} of {formatNumber(answer.distinct)} distinct
                  link(s) were checked — the first ones in the file. The rest were not asked
                  about, so this says nothing about them either way.
                </p>
              </Alert>
            ) : null}

            {answer.results.length === 0 ? (
              <Alert tone="ok" title="Every link answered with an image">
                <p>
                  All {formatNumber(answer.checked)} distinct link(s) are reachable and serve
                  an image. Nothing here needs attention.
                </p>
              </Alert>
            ) : (
              <DataTable
                columns={columns}
                rows={answer.results}
                rowKey={(row) => row.url}
                caption="Image links that failed or need a look"
              />
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
