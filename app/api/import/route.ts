import { randomUUID } from "node:crypto";
import { z } from "zod";

import { enqueueImport, type JobState } from "@/lib/jobs";
import { checkImport } from "@/lib/limits";
import { ownerOf } from "@/lib/ownership";
import { applyRowChanges, getPreview, getPreviewProducts } from "@/lib/preview";
import { IMAGE_UPLOAD_VERSION, imageUploadSupport } from "@/lib/plugin-version";
import { getStore, storeLabel } from "@/lib/stores";
import { apiRequireView, refusePublishingAsAdmin } from "@/lib/view";

/**
 * "Start" — queue the job and answer immediately. A separate worker does the
 * rest.
 *
 * Takes a preview id rather than the file again: the data was built exactly
 * once at the preview step and is already stored. That is what makes pushing
 * one batch to five sites five jobs from ONE file read, and leaves no gap for
 * what gets published to differ from what was reviewed.
 */

const bodySchema = z.object({
  previewId: z.string().min(1, "Missing the preview id"),
  storeIds: z.array(z.string().min(1)).min(1, "No site selected"),
  changes: z
    .object({
      dropped: z.array(z.number().int().min(0)).default([]),
      edits: z
        .record(
          z.string(),
          z.object({
            name: z.string().optional(),
            sku: z.string().optional(),
            slug: z.string().optional(),
            price: z.string().optional(),
            regularPrice: z.string().optional(),
            categories: z.array(z.string()).optional(),
            tags: z.array(z.string()).optional(),
          }),
        )
        .default({}),
    })
    .default({ dropped: [], edits: {} }),

  /**
   * Fire at this time instead of now. ISO 8601, absent for an immediate run.
   *
   * The payload is staged either way — `enqueueJob` writes `job_item` in the same
   * transaction as the run row — so a run scheduled for tomorrow does NOT depend
   * on this preview, which expires in an hour. That is what makes scheduling a
   * one-line change rather than a second staging mechanism.
   */
  scheduledFor: z
    .string()
    .datetime({ offset: true })
    .optional()
    .refine(
      (value) => value === undefined || new Date(value).getTime() - Date.now() <= MAX_AHEAD_MS,
      "A run cannot be scheduled more than 90 days ahead.",
    ),
});

/** How far ahead a run may be scheduled. A year is a mistake, not a plan. */
const MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const refusal = refusePublishingAsAdmin(guard);
  if (refusal !== null) {
    return refusal;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const { previewId, storeIds, changes, scheduledFor } = parsed.data;
  const when = scheduledFor === undefined ? null : new Date(scheduledFor);

  // The preview id arrives in the body rather than the path, so it does not
  // pass through the `[id]` guard — check it here, with the same rule and the
  // same 404. A staged preview is someone's whole catalogue.
  const previewOwner = await ownerOf("preview", previewId);
  if (previewOwner !== null && previewOwner !== guard.ownerId) {
    return Response.json({ error: "No such preview" }, { status: 404 });
  }

  const preview = await getPreview(previewId);
  const products = await getPreviewProducts(previewId);

  if (preview === null || products === null) {
    return Response.json(
      { error: "This preview has expired (they are kept for an hour). Read the file again and preview it." },
      { status: 409 },
    );
  }

  const finalProducts = applyRowChanges(products, changes);

  if (finalProducts.length === 0) {
    return Response.json(
      { error: "Nothing left to import — every row was dropped." },
      { status: 400 },
    );
  }

  // Check EVERY site before creating any job: creating three and then finding
  // the fourth does not exist leaves a half-finished mess.
  const stores = [];
  for (const storeId of storeIds) {
    // Scoped: a site id belonging to another account must not become a target,
    // and answers exactly as an id that does not exist does.
    const store = await getStore(storeId, guard.ownerId);
    if (store === null) {
      return Response.json(
        { error: `No site with id ${storeId}. Reload the site list.` },
        { status: 404 },
      );
    }
    stores.push(store);
  }

  /*
   * "Copy into the site's media library" needs plugin 3.9.0 on EVERY target.
   *
   * Checked here for the same reason the sites are: refusing before any job exists
   * beats creating four runs and having the worker fail each one. The worker checks
   * again when the run fires, because a scheduled run can be days old and a site can
   * be downgraded or replaced in between.
   *
   * All the offending sites are named at once. Reporting only the first would make
   * updating four sites take four attempts.
   */
  if (preview.options.imageMode === "upload_site") {
    const tooOld = stores.filter((store) => !imageUploadSupport(store.pluginVersion).ok);

    if (tooOld.length > 0) {
      return Response.json(
        {
          error:
            `Copying images into the media library needs plugin ${IMAGE_UPLOAD_VERSION}, and ` +
            `${tooOld.length} of the selected site(s) run an older build: ` +
            tooOld
              .map(
                (store) =>
                  `${storeLabel(store)} (${store.pluginVersion === null || store.pluginVersion.trim() === "" ? "version unknown" : store.pluginVersion})`,
              )
              .join(", ") +
            `. Update the plugin on those sites, or start this run with a different image mode.`,
          code: "plugin_too_old",
          required: IMAGE_UPLOAD_VERSION,
          sites: tooOld.map((store) => ({
            id: store.id,
            label: storeLabel(store),
            installed: store.pluginVersion,
          })),
        },
        { status: 409 },
      );
    }
  }

  /*
   * What the administrator has allowed this account, checked once the real size
   * of the run is known. Refused rather than silently clamped: quietly cutting
   * 5000 products down to a 1000 ceiling would publish part of a catalogue and
   * report success.
   *
   * A SCHEDULED import is still an import, so it is checked here exactly like an
   * immediate one — the operator finds out now, when they can do something about
   * it, rather than at 3am. And the worker checks AGAIN when the run fires,
   * because these two moments can be days apart and the answer can change in
   * between; see the re-check in `worker/index.ts`.
   */
  const allowed = await checkImport(guard.ownerId, {
    count: finalProducts.length,
    threads: preview.options.threads,
  });
  if (!allowed.ok) {
    return allowed.response;
  }

  // Several sites share a group id so the activity screen can present them as
  // one press of Start rather than five unrelated jobs.
  const groupId = stores.length > 1 ? randomUUID() : null;

  const jobs: JobState[] = [];
  for (const store of stores) {
    jobs.push(
      await enqueueImport({
        storeId: store.id,
        storeUrl: store.url,
        storeLabel: storeLabel(store),
        sourceLabel: preview.sourceLabel,
        options: { ...preview.options, storeId: store.id },
        products: finalProducts,
        // The ACCOUNT ON SCREEN, not the signed-in user: an administrator who
        // started this from inside a member's account has created the member's
        // run, and the worker will use the member's S3 bucket for it.
        createdBy: guard.ownerId,
        groupId,
        scheduledFor: when,
      }),
    );
  }

  return Response.json({ jobs, groupId, scheduledFor: when?.toISOString() ?? null }, { status: 202 });
}
