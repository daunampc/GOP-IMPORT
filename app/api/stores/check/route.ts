import { checkAllStores } from "@/lib/stores";
import { apiRequireView } from "@/lib/view";

/** Runs the connection check for this account's sites, in parallel. */
export async function POST() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const results = await checkAllStores(guard.ownerId);

  return Response.json({
    results,
    ok: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
  });
}
