import { countResults, getJobState, getResults } from "@/lib/jobs";
import { apiRequireOwned } from "@/lib/ownership";

/**
 * Per-row results for a run.
 *
 * Returns `total` alongside the page so the table knows how many rows exist
 * without pulling them all — a batch of 5000 products is 5000 result rows, and
 * a removal that covers a whole catalogue is a good deal more.
 */
export async function GET(request: Request, context: RouteContext<"/api/jobs/[id]/results">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  if ((await getJobState(id)) === null) {
    return Response.json({ error: "No such run" }, { status: 404 });
  }

  const url = new URL(request.url);
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "500", 10) || 500),
    5000,
  );

  const [results, total] = await Promise.all([
    getResults(id, offset, limit),
    countResults(id),
  ]);

  return Response.json({ results, total, offset, limit });
}
