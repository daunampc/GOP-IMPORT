import { notFound } from "next/navigation";

import { listJobs } from "@/lib/jobs";
import { pageOwnerOf } from "@/lib/ownership";
import { expectedPluginVersion } from "@/lib/plugin-version.server";
import { getStoreUnscoped, listChecks, toPublic } from "@/lib/stores";
import { requireView } from "@/lib/view";

import { StoreDetailView } from "./store-detail-view";

export const dynamic = "force-dynamic";

export default async function StoreDetailPage({ params }: PageProps<"/stores/[id]">) {
  const { id } = await params;
  const { user } = await requireView();

  // Same rule as the API: a member gets the ordinary 404 page for a site
  // belonging to another account, which is what they would get for an id that
  // never existed. An administrator gets through.
  const ownerId = await pageOwnerOf("store", id, user);
  if (ownerId === null) {
    notFound();
  }

  const store = await getStoreUnscoped(id);
  if (store === null) {
    notFound();
  }

  const [checks, jobs, expected] = await Promise.all([
    listChecks(id),
    // The site's runs belong to the SITE's owner — an administrator opening a
    // member's site is reading the member's history, not their own.
    listJobs(ownerId, 200),
    expectedPluginVersion(),
  ]);

  return (
    <StoreDetailView
      initialStore={toPublic(store)}
      initialChecks={checks}
      // Reading a site's stored API secret back is an administrator's repair
      // tool and a recorded one. A member replaces a lost secret rather than
      // retrieving it — which is what makes the record complete.
      canReveal={user.role === "admin"}
      jobs={jobs.filter((job) => job.storeId === id).slice(0, 50)}
      expectedPluginVersion={expected}
    />
  );
}
