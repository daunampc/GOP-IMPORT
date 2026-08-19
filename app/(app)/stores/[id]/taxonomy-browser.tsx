"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  Segmented,
  Skeleton,
  foldVietnamese,
} from "@/components/ui";
import { formatNumber } from "@/lib/format";
import type { TermNode } from "@/app/api/stores/[id]/terms/route";

/**
 * A browser for the site's taxonomy.
 *
 * Answers "what categories does this site actually have", which nothing used to
 * answer — with the result that people typed category names by hand and created
 * duplicates, because the plugin resolves terms by NAME rather than by id.
 *
 * All three taxonomies the plugin allows are here, `product_shipping_class`
 * included — it was in the contract but no control ever touched it.
 */

type Taxonomy = "product_cat" | "product_tag" | "product_shipping_class";

const LABELS: Record<Taxonomy, string> = {
  product_cat: "Categories",
  product_tag: "Tags",
  product_shipping_class: "Shipping classes",
};

export function TaxonomyBrowser({ storeId }: { storeId: string }) {
  const [taxonomy, setTaxonomy] = useState<Taxonomy>("product_cat");
  const [query, setQuery] = useState("");

  // The result carries the taxonomy it belongs to, so "loading" is derivable
  // rather than a second piece of state to keep in sync.
  const [loaded, setLoaded] = useState<{
    taxonomy: Taxonomy;
    terms: TermNode[] | null;
    error: string | null;
  } | null>(null);

  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/stores/${storeId}/terms?taxonomy=${taxonomy}`);
        const payload = (await response.json()) as { tree?: TermNode[]; error?: string };

        if (cancelled) {
          return;
        }

        setLoaded(
          !response.ok || !payload.tree
            ? { taxonomy, terms: null, error: payload.error ?? "Could not read the taxonomy." }
            : { taxonomy, terms: payload.tree, error: null },
        );
      } catch (caught) {
        if (!cancelled) {
          setLoaded({
            taxonomy,
            terms: null,
            error: caught instanceof Error ? caught.message : String(caught),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [storeId, taxonomy, reloadToken]);

  const reload = useCallback(() => {
    setLoaded(null);
    setReloadToken((current) => current + 1);
  }, []);

  const state: "loading" | "ready" | "error" =
    loaded === null || loaded.taxonomy !== taxonomy
      ? "loading"
      : loaded.error
        ? "error"
        : "ready";

  // `useMemo` has to receive the array actually being shown rather than a
  // conditional expression, otherwise its dependency changes without it
  // noticing.
  const terms = useMemo(
    () => (loaded?.taxonomy === taxonomy ? (loaded.terms ?? []) : []),
    [loaded, taxonomy],
  );

  const error = loaded?.taxonomy === taxonomy ? loaded.error : null;

  const filtered = useMemo(() => {
    const needle = foldVietnamese(query.trim());
    if (needle === "") {
      return terms;
    }
    return terms.filter((term) => foldVietnamese(term.path).includes(needle));
  }, [terms, query]);

  const totalProducts = terms.reduce((sum, term) => sum + term.count, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Choose a taxonomy"
          size="sm"
          value={taxonomy}
          onChange={setTaxonomy}
          options={[
            { value: "product_cat", label: LABELS.product_cat, icon: "folder" },
            { value: "product_tag", label: LABELS.product_tag, icon: "tag" },
            { value: "product_shipping_class", label: LABELS.product_shipping_class, icon: "package" },
          ]}
        />

        <div className="flex items-center gap-2">
          <Input
            icon="search"
            placeholder="Search…"
            aria-label={`Search ${LABELS[taxonomy]}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 w-44 text-xs"
          />
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            loading={state === "loading"}
            onClick={reload}
            aria-label="Re-read the taxonomy"
          />
        </div>
      </div>

      {state === "loading" ? (
        <div className="space-y-1.5">
          {Array.from({ length: 8 }, (_value, index) => (
            <Skeleton key={index} className="h-7 w-full" rounded="sm" />
          ))}
        </div>
      ) : null}

      {state === "error" ? (
        <ErrorState
          title={`Could not read ${LABELS[taxonomy].toLowerCase()}`}
          message={error ?? "Unknown error."}
          hint="Usually the connection to the plugin is broken. Run the connection check above first."
          onRetry={reload}
        />
      ) : null}

      {state === "ready" ? (
        terms.length === 0 ? (
          <EmptyState
            icon="tag"
            title={`This site has no ${LABELS[taxonomy].toLowerCase()} yet`}
            description="The first import creates them from the names in your options or in the source file."
            action={
              <Button variant="secondary" icon="refresh" onClick={reload}>
                Read again
              </Button>
            }
          />
        ) : (
          <>
            <div className="max-h-96 overflow-y-auto rounded-md border border-line">
              <ul className="divide-y divide-line">
                {filtered.map((term) => (
                  <li
                    key={term.term_id}
                    className="flex items-center gap-2 px-3 py-1.5"
                    style={{ paddingLeft: `${0.75 + term.depth * 1.25}rem` }}
                  >
                    <Icon
                      name={term.depth === 0 ? "folder" : "chevron-right"}
                      className="size-3.5 shrink-0 text-ink-subtle"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{term.name}</span>
                    <span className="font-mono text-2xs text-ink-subtle">{term.slug}</span>
                    <Badge tone={term.count > 0 ? "neutral" : "warn"}>
                      {formatNumber(term.count)} sp
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>

            <p className="text-xs text-ink-subtle">
              {filtered.length === terms.length
                ? `${formatNumber(terms.length)} entries · ${formatNumber(totalProducts)} product assignments`
                : `${formatNumber(filtered.length)} of ${formatNumber(terms.length)} entries match`}
              {". "}
              An entry with 0 products is usually a category created by mistake on an earlier run.
            </p>
          </>
        )
      ) : null}
    </div>
  );
}
