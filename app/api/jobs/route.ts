import { jobsSnapshot } from "@/lib/jobs";
import { apiRequireView } from "@/lib/view";

/** The runs of whichever account is on screen — never every account's. */
export async function GET() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json(await jobsSnapshot(guard.ownerId));
}
