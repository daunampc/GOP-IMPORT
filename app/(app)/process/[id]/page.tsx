import { notFound } from "next/navigation";

import { getBatchRecords, getJobState } from "@/lib/jobs";
import { pageOwnerOf } from "@/lib/ownership";
import { getStoreUnscoped, toPublic } from "@/lib/stores";
import { requireView } from "@/lib/view";

import { JobDetailView } from "./job-detail-view";

export const dynamic = "force-dynamic";

export default async function JobDetailPage({ params }: PageProps<"/process/[id]">) {
  const { id } = await params;
  const { user } = await requireView();

  // Runs age out after 7 days, so "not found" is ordinary rather than a
  // failure — and a run belonging to another account answers identically, so a
  // member cannot tell the two apart.
  if ((await pageOwnerOf("job", id, user)) === null) {
    notFound();
  }

  const job = await getJobState(id);
  if (job === null) {
    notFound();
  }

  const [batches, store] = await Promise.all([
    getBatchRecords(id),
    // The site belongs to the run's owner, not to whoever is reading the run.
    getStoreUnscoped(job.storeId),
  ]);

  return (
    <JobDetailView
      initialJob={job}
      initialBatches={batches}
      store={store ? toPublic(store) : null}
    />
  );
}
