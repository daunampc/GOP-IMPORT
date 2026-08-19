import {
  enqueueEdit,
  enqueueImport,
  enqueuePurge,
  getEditItems,
  getJobProducts,
  getJobState,
  getResults,
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
  const wanted = items.filter((_item, index) => failedIndexes.includes(index));

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
    options: job.options as EditOptions,
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

  const failed = failedIndexes
    .map((index) => products[index])
    .filter((product): product is NonNullable<typeof product> => product !== undefined);

  if (failed.length === 0) {
    return { error: "The failed rows could not be matched to the staged payload." };
  }

  return {
    job: await enqueueImport({
      storeId: store.id,
      storeUrl: store.url,
      storeLabel: storeLabel(store),
      sourceLabel: `Resend ${failed.length} failed row(s) — ${job.sourceLabel}`,
      options: job.options as ImportOptions,
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

  const failed = failedIndexes
    .map((index) => items[index])
    .filter((item): item is NonNullable<typeof item> => item !== undefined);

  if (failed.length === 0) {
    return { error: "The failed rows could not be matched to the staged list." };
  }

  return {
    job: await enqueuePurge({
      storeId: store.id,
      storeUrl: store.url,
      storeLabel: storeLabel(store),
      sourceLabel: `Retry ${failed.length} failed removal(s) — ${job.sourceLabel}`,
      options: job.options as PurgeOptions,
      products: failed,
      createdBy: job.createdBy,
      retryOf: job.id,
    }),
  };
}
