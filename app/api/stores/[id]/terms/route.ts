import { clientFor, getStoreUnscoped } from "@/lib/stores";
import { GopApiError } from "@/lib/gop-client";
import { apiRequireOwned } from "@/lib/ownership";

const TAXONOMIES = ["product_cat", "product_tag", "product_shipping_class"] as const;
type Taxonomy = (typeof TAXONOMIES)[number];

function isTaxonomy(value: string): value is Taxonomy {
  return (TAXONOMIES as ReadonlyArray<string>).includes(value);
}

/**
 * The categories, tags and shipping classes that actually exist on the site.
 *
 * `client.terms()` existed from the start but no screen ever called it, so
 * category names were typed by hand. The plugin resolves terms by NAME, which
 * makes typing "T-Shirts" on a site that has "T-shirts" quietly create a second
 * term — and nobody notices until they open wp-admin.
 */
export async function GET(request: Request, context: RouteContext<"/api/stores/[id]/terms">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("store", id);
  if (!guard.ok) {
    return guard.response;
  }

  const taxonomy = new URL(request.url).searchParams.get("taxonomy") ?? "product_cat";
  if (!isTaxonomy(taxonomy)) {
    return Response.json(
      { error: `taxonomy must be one of: ${TAXONOMIES.join(", ")}` },
      { status: 400 },
    );
  }

  const store = await getStoreUnscoped(id);
  if (store === null) {
    return Response.json({ error: "No such site" }, { status: 404 });
  }

  try {
    const client = await clientFor(store);
    const response = await client.terms(taxonomy);

    return Response.json({
      taxonomy: response.taxonomy,
      terms: response.terms,
      // The tree is built on the server: screens only draw it, and the ordering
      // is identical everywhere this list is used.
      tree: buildTree(response.terms),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof GopApiError ? error.status : 502;

    return Response.json({ error: message }, { status: status === 200 ? 502 : status });
  }
}

export interface TermNode {
  term_id: number;
  name: string;
  slug: string;
  count: number;
  depth: number;
  /** The full path in the plugin's hierarchy syntax: "Clothing > T-shirts > Men". */
  path: string;
}

/**
 * Flatten the tree into an indented list.
 *
 * A flat list rather than a nested tree because the combobox scrolls and
 * filters in display order; a nested tree would have to be flattened again on
 * every keystroke.
 */
function buildTree(
  terms: ReadonlyArray<{ term_id: number; name: string; slug: string; parent: number; count: number }>,
): TermNode[] {
  const byParent = new Map<number, typeof terms[number][]>();

  for (const term of terms) {
    const bucket = byParent.get(term.parent);
    if (bucket) {
      bucket.push(term);
    } else {
      byParent.set(term.parent, [term]);
    }
  }

  const out: TermNode[] = [];
  const visited = new Set<number>();

  const walk = (parent: number, depth: number, prefix: string) => {
    // Corrupt term data can form a parent-child cycle; `visited` stops the
    // recursion from hanging the whole request.
    for (const term of byParent.get(parent) ?? []) {
      if (visited.has(term.term_id)) {
        continue;
      }
      visited.add(term.term_id);

      const path = prefix === "" ? term.name : `${prefix} > ${term.name}`;
      out.push({
        term_id: term.term_id,
        name: term.name,
        slug: term.slug,
        count: term.count,
        depth,
        path,
      });

      walk(term.term_id, depth + 1, path);
    }
  };

  walk(0, 0, "");

  // A term whose `parent` points at something that does not exist falls outside
  // the tree — it still has to appear, or a category goes missing for no visible
  // reason.
  for (const term of terms) {
    if (!visited.has(term.term_id)) {
      out.push({
        term_id: term.term_id,
        name: term.name,
        slug: term.slug,
        count: term.count,
        depth: 0,
        path: term.name,
      });
    }
  }

  return out;
}
