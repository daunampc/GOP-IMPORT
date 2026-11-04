import {
  enqueueEdit,
  enqueueImport,
  enqueuePurge,
  getEditItems,
  getJobProducts,
  getJobState,
  getResults,
  listJobsRetryingFrom,
  withRetryIndexes,
  type JobState,
} from "@/lib/jobs";
import { getPurgeItems } from "@/lib/purge";
import type { ImportOptions } from "@/lib/import-options";
import type { PurgeOptions } from "@/lib/purge-options";
import type { EditOptions } from "@/lib/edit-options";
import { getStoreUnscoped, storeLabel } from "@/lib/stores";
import { apiRequireOwned } from "@/lib/ownership";

/**
 * Create a new run containing only the rows that failed.
 *
 * Before this existed, importing 5000 products with 47 failures meant editing
 * the CSV by hand to retry those 47.
 *
 * Rows come from the payload stored with the original run, and an import keeps
 * the ORIGINAL `idempotency_key`: a row that did in fact reach the site comes
 * back as `deduplicated: true` rather than becoming a second product.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/jobs/[id]/retry-failed">,
) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  const job = await getJobState(id);
  if (job === null) {
    return Response.json({ error: "No such run." }, { status: 404 });
  }

  if (job.status === "running" || job.status === "queued") {
    return Response.json(
      { error: "This run has not finished. Wait for it before resending its failures." },
      { status: 409 },
    );
  }

  // Resolved without a scope because the site belongs to the RUN's owner: an
  // administrator resending a member's failures is not the site's owner.
  const store = await getStoreUnscoped(job.storeId);
  if (store === null) {
    return Response.json(
      { error: "This run's site has been removed. Add the site again and start a new run." },
      { status: 409 },
    );
  }

  /*
   * ONE resend at a time, and never one from a run that has already been resent.
   *
   * A resend that is still going has not yet said which of these rows it fixed, so a
   * second one would send the same rows again alongside it. And an older resend that
   * was never folded back (from before resends were merged into their original) means
   * these failures were ALREADY resent — in that run, which is where to look.
   */
  const resends = await listJobsRetryingFrom(id);
  const going = resends.find((resend) => resend.status === "queued" || resend.status === "running");

  if (going !== undefined) {
    return Response.json(
      {
        error:
          "A resend of this run is already in progress. Wait for it to finish — its results are " +
          "folded back into this run, and only what is still failing can be resent after that.",
        resendId: going.id,
      },
      { status: 409 },
    );
  }

  if (resends.length > 0) {
    return Response.json(
      {
        error:
          "These failures were already resent, in another run. Open that run to resend what is " +
          "still failing there.",
        resendId: resends[0].id,
      },
      { status: 409 },
    );
  }

  const results = await getResults(id, 0, 100_000);
  const failedIndexes = results.filter((result) => !result.ok).map((result) => result.index);

  if (failedIndexes.length === 0) {
    return Response.json({ error: "This run had no failures." }, { status: 409 });
  }

  const next =
    job.kind === "purge"
      ? await retryPurge(job, failedIndexes, store)
      : job.kind === "update"
        ? await retryEdit(job, failedIndexes, store)
        : await retryImport(job, failedIndexes, store);

  if ("error" in next) {
    return Response.json({ error: next.error }, { status: 409 });
  }

  return Response.json({ job: next.job }, { status: 202 });
}

type Store = NonNullable<Awaited<ReturnType<typeof getStoreUnscoped>>>;
type Outcome = { job: JobState } | { error: string };

/**
 * Resend the rows of a bulk edit that failed.
 *
 * Safe to repeat for a reason the import path has to work harder for: the staged
 * row carries the ABSOLUTE value to write, so sending it twice writes the same
 * number twice. There is no arithmetic to re-apply, which is exactly why the
 * selection was resolved at preview time rather than kept as a rule — a stored
 * "−10%" resent would take another 10% off.
 *
 * The new run inherits the ORIGINAL run's owner, not the caller's, so an
 * administrator resending a member's failures leaves the run in the member's account.
 */
async function retryEdit(
  job: JobState,
  failedIndexes: number[],
  store: Store,
): Promise<Outcome> {
  const items = await getEditItems(job.id);
  const keep = failedIndexes.filter((index) => index >= 0 && index < items.length).sort((a, b) => a - b);
  const wanted = keep.map((index) => items[index]);

  if (wanted.length === 0) {
    return { error: "The staged list of changes for this run is no longer available." };
  }

  const next = await enqueueEdit({
    storeId: store.id,
    storeUrl: store.url,
    storeLabel: storeLabel(store),
    sourceLabel: `Resent — ${job.sourceLabel}`,
    createdBy: job.createdBy,
    retryOf: job.id,
    options: withRetryIndexes(job.options as EditOptions, keep),
    products: wanted,
  });

  return { job: next };
}

async function retryImport(
  job: JobState,
  failedIndexes: number[],
  store: Store,
): Promise<Outcome> {
  const products = await getJobProducts(job.id);

  if (products.length === 0) {
    return { error: "This run's staged products are gone. Start again from the source file." };
  }

  const keep = failedIndexes.filter((index) => products[index] !== undefined);
  const failed = keep.map((index) => products[index]);

  if (failed.length === 0) {
    return { error: "The failed rows could not be matched to the staged payload." };
  }

  return {
    job: await enqueueImport({
      storeId: store.id,
      storeUrl: store.url,
      storeLabel: storeLabel(store),
      sourceLabel: `Resend ${failed.length} failed row(s) — ${job.sourceLabel}`,
      options: withRetryIndexes(job.options as ImportOptions, keep),
      products: failed,
      // The retry belongs to the account that owns the ORIGINAL run, not to
      // whoever pressed the button: an administrator resending a member's
      // failures must not move the run — or its S3 bucket — into their own
      // account.
      createdBy: job.createdBy,
      retryOf: job.id,
    }),
  };
}

/**
 * Retrying a removal is the same idea and safer than the import case: a product
 * that was in fact deleted comes back as `not_found` rather than doing damage.
 */
async function retryPurge(job: JobState, failedIndexes: number[], store: Store): Promise<Outcome> {
  const items = await getPurgeItems(job.id);

  if (items.length === 0) {
    return { error: "This run's staged list of products is gone." };
  }

  const keep = failedIndexes.filter((index) => items[index] !== undefined);
  const failed = keep.map((index) => items[index]);

  if (failed.length === 0) {
    return { error: "The failed rows could not be matched to the staged list." };
  }

  return {
    job: await enqueuePurge({
      storeId: store.id,
      storeUrl: store.url,
      storeLabel: storeLabel(store),
      sourceLabel: `Retry ${failed.length} failed removal(s) — ${job.sourceLabel}`,
      options: withRetryIndexes(job.options as PurgeOptions, keep),
      products: failed,
      createdBy: job.createdBy,
      retryOf: job.id,
    }),
  };
}
