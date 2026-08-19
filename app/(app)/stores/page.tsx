import { expectedPluginVersion } from "@/lib/plugin-version.server";
import { listStores, toPublic } from "@/lib/stores";
import { requireView } from "@/lib/view";

import { StoresView } from "./stores-view";

export const dynamic = "force-dynamic";

export default async function StoresPage({ searchParams }: PageProps<"/stores">) {
  const { ownerId } = await requireView();

  const [stores, expected, params] = await Promise.all([
    listStores(ownerId),
    expectedPluginVersion(),
    searchParams,
  ]);

  return (
    <StoresView
      initial={stores.map(toPublic)}
      expectedPluginVersion={expected}
      // The command palette opens this screen with `?check=all` to run the checks straight away.
      autoCheck={params.check === "all"}
    />
  );
}
