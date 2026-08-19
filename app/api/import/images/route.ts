import { z } from "zod";

import {
  IMAGE_CHECK_LIMIT,
  checkImageUrls,
  severityOf,
  type ImageCheckResult,
} from "@/lib/image-check";
import { ownerOf } from "@/lib/ownership";
import { distinctImageUrls, getPreview, getPreviewProducts } from "@/lib/preview";
import { apiRequireView } from "@/lib/view";

/**
 * Do these image links work? — asked BEFORE the run, §6 C4.
 *
 * The gap it closes: a dead image URL is currently found halfway through an import.
 * The products are already being written, the log fills with staging failures, and
 * the operator learns about a broken link at the point where there is nothing left
 * to decide. One request per DISTINCT link at the preview step moves that to where
 * a decision is still possible.
 *
 * It does NOT block the run, and that is deliberate. A broken link is not a reason
 * to refuse to publish a catalogue — the products still import, with the links the
 * file gave. Compare `/api/import/exists`, which the two write modes DO gate on:
 * that number changes what the run writes to existing products, and this one does
 * not change what the run does at all.
 *
 * Answered for the FILE rather than per site, because it is a question about the
 * links: nothing about a WooCommerce site changes whether a CDN serves an image.
 */

const bodySchema = z.object({
  previewId: z.string().min(1, "Missing the preview id"),
  /**
   * Distinct links to check. Bounded because somebody is waiting for this answer,
   * and both numbers are always in the response — see `truncated`.
   */
  limit: z.coerce.number().int().min(1).max(IMAGE_CHECK_LIMIT).default(IMAGE_CHECK_LIMIT),
});

export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const { previewId, limit } = parsed.data;

  // The preview id arrives in the BODY, so it never passes through the `[id]`
  // guard — checked here with the same rule and the same 404 as `/api/import/exists`
  // and `POST /api/import`. A staged preview is somebody's whole catalogue, and a
  // 403 would confirm the id exists.
  const previewOwner = await ownerOf("preview", previewId);
  if (previewOwner !== null && previewOwner !== guard.ownerId) {
    return Response.json({ error: "No such preview" }, { status: 404 });
  }

  const products = await getPreviewProducts(previewId);
  const preview = await getPreview(previewId);

  if (preview === null || products === null) {
    return Response.json(
      {
        error:
          "This preview has expired (they are kept for an hour). Read the file again and preview it.",
      },
      { status: 409 },
    );
  }

  const urls = distinctImageUrls(products);
  const checking = urls.slice(0, limit);
  const results = await checkImageUrls(checking);

  /*
   * How many PRODUCTS each bad link would spoil.
   *
   * The count an operator acts on. "Three dead links" says nothing about whether
   * that is three products or three hundred, and one shared size-chart image can be
   * on every row in the file.
   */
  const productsPerUrl = new Map<string, number>();

  for (const product of products) {
    const own = new Set<string>();

    for (const url of product.images ?? []) {
      own.add(url);
    }
    for (const variation of product.variations ?? []) {
      if (variation.image) {
        own.add(variation.image);
      }
      for (const url of variation.images ?? []) {
        own.add(url);
      }
    }

    for (const url of own) {
      productsPerUrl.set(url, (productsPerUrl.get(url) ?? 0) + 1);
    }
  }

  let ok = 0;
  let warned = 0;
  let failed = 0;
  const badUrls = new Set<string>();

  for (const result of results) {
    const severity = severityOf(result.verdict);

    if (severity === "ok") {
      ok++;
      continue;
    }

    badUrls.add(result.url);

    if (severity === "warned") {
      warned++;
    } else {
      failed++;
    }
  }

  /*
   * Only the links that need attention are listed. A file of 200 working links has
   * nothing to read, and a list of 200 rows with one bad one buried in it is how the
   * bad one gets missed.
   */
  const listed: Array<ImageCheckResult & { products: number }> = results
    .filter((result) => severityOf(result.verdict) !== "ok")
    .map((result) => ({ ...result, products: productsPerUrl.get(result.url) ?? 0 }));

  const productsAffected = products.filter((product) => {
    const own = [
      ...(product.images ?? []),
      ...(product.variations ?? []).flatMap((variation) => [
        ...(variation.image ? [variation.image] : []),
        ...(variation.images ?? []),
      ]),
    ];

    return own.some((url) => badUrls.has(url));
  }).length;

  return Response.json({
    /** Distinct links the FILE carries. */
    distinct: urls.length,
    /** Distinct links this answer actually covers. */
    checked: checking.length,
    /**
     * Said out loud rather than left to be worked out from two numbers. A page
     * presented as everything is the mistake this codebase refuses everywhere else.
     */
    truncated: urls.length > checking.length,
    ok,
    warned,
    failed,
    /** Products carrying at least one link that failed or needs a look. */
    productsAffected,
    results: listed,
    checkedAt: new Date().toISOString(),
  });
}
