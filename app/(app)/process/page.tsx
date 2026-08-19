import { listSchedules } from "@/lib/schedules";
import { requireView } from "@/lib/view";

import { ProcessListView } from "./process-list-view";
import { SchedulesPanel } from "./schedules-panel";

// Run state changes constantly — this page is never cached. The runs themselves are
// loaded by the root layout and shared through JobsProvider, so this page does not
// read them a second time; the repeating SERIES are read here, on the server, so the
// panel needs no fetch on mount and no clock during render.
export const dynamic = "force-dynamic";

export default async function ProcessPage() {
  const { ownerId } = await requireView();
  const schedules = await listSchedules(ownerId);

  return (
    <>
      <SchedulesPanel schedules={schedules} />
      <ProcessListView />
    </>
  );
}
