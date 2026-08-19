import { listJobs } from "@/lib/jobs";
import { listStores, toPublic } from "@/lib/stores";
import { requireView } from "@/lib/view";

import { RemoveView } from "./remove-view";

export const dynamic = "force-dynamic";

export default async function RemovePage() {
  const { ownerId } = await requireView();

  const [stores, jobs] = await Promise.all([
    listStores(ownerId),
    listJobs(ownerId, 200),
  ]);

  return (
    <RemoveView
      stores={stores.map(toPublic)}
      // Only finished IMPORT runs can be the basis of "remove what this run
      // created": a run still going would give a list that is already stale,
      // and a previous removal run created nothing to remove.
      runs={jobs
        .filter((job) => job.kind === "import" && job.succeeded > 0)
        .map((job) => ({
          id: job.id,
          storeId: job.storeId,
          storeLabel: job.storeLabel,
          sourceLabel: job.sourceLabel,
          succeeded: job.succeeded,
          status: job.status,
          createdAt: job.createdAt,
        }))}
    />
  );
}
