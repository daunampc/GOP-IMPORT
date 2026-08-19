import { z } from "zod";

import { checkImport } from "@/lib/limits";
import { ownerOf } from "@/lib/ownership";
import { getPreview, getPreviewProducts } from "@/lib/preview";
import { MAX_EVERY_MINUTES, MIN_EVERY_MINUTES, createSchedule, listSchedules } from "@/lib/schedules";
import { getStore, storeLabel } from "@/lib/stores";
import { apiRequireView } from "@/lib/view";

/**
 * Runs that happen again — §6 C2.
 *
 * Built from a staged preview, exactly like `POST /api/import`, because a series is
 * an import that repeats rather than a different kind of thing. The payload is
 * copied out of the preview into the series, so the series outlives the preview's
 * one-hour life: what it publishes tonight is what the operator reviewed today.
 *
 * The account's import permission is checked HERE as well as at every firing, and
 * for the two different reasons the scheduled-run path already has: the route checks
 * so the operator gets an answer they can act on, and the worker checks because a
 * series can fire for months and a permission withdrawn in between must not publish.
 */

const bodySchema = z.object({
  previewId: z.string().min(1, "Missing the preview id"),
  storeId: z.string().min(1, "Pick a site first"),
  everyMinutes: z.coerce.number().int().min(MIN_EVERY_MINUTES).max(MAX_EVERY_MINUTES),
  /** When the first occurrence is due. Defaults to one interval from now. */
  firstRunAt: z.string().datetime().optional(),
});

export async function GET() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ schedules: await listSchedules(guard.ownerId) });
}

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

  const { previewId, storeId, everyMinutes, firstRunAt } = parsed.data;

  // The preview id arrives in the BODY, so it never passes through the `[id]` guard
  // — checked here with the same rule and the same 404 as `POST /api/import`.
  const previewOwner = await ownerOf("preview", previewId);
  if (previewOwner !== null && previewOwner !== guard.ownerId) {
    return Response.json({ error: "No such preview" }, { status: 404 });
  }

  const preview = await getPreview(previewId);
  const products = await getPreviewProducts(previewId);

  if (preview === null || products === null) {
    return Response.json(
      {
        error:
          "This preview has expired (they are kept for an hour). Read the file again and preview it.",
      },
      { status: 409 },
    );
  }

  // Scoped: a site id belonging to another account must answer exactly as one that
  // does not exist.
  const store = await getStore(storeId, guard.ownerId);
  if (store === null) {
    return Response.json({ error: "No such site. Reload the site list." }, { status: 404 });
  }

  const allowed = await checkImport(guard.ownerId, {
    count: products.length,
    threads: preview.options.threads,
  });

  if (!allowed.ok) {
    return allowed.response;
  }

  const first =
    firstRunAt === undefined
      ? new Date(Date.now() + everyMinutes * 60_000)
      : new Date(firstRunAt);

  const { schedule, first: occurrence } = await createSchedule({
    createdBy: guard.ownerId,
    storeId: store.id,
    storeUrl: store.url,
    storeLabel: storeLabel(store),
    sourceLabel: preview.sourceLabel,
    options: { ...preview.options, storeId: store.id },
    items: products,
    everyMinutes,
    firstRunAt: first,
  });

  return Response.json({ schedule, first: occurrence }, { status: 201 });
}
