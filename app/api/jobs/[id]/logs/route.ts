import { formatLogLine, getJobLogs } from "@/lib/job-log";
import { apiRequireOwned } from "@/lib/ownership";

/**
 * One run's log, a page at a time.
 *
 * `after` is a LINE ID, not a timestamp: two lines written in the same millisecond
 * are ordinary, and a timestamp cursor would either repeat them or skip them. The
 * SSE stream beside this uses the same cursor and the same reader, so the two
 * cannot disagree about what "next" means.
 *
 * `format=text` returns the log as a plain file for the download button. Same
 * ownership guard either way — a member reaching for another account's run gets 404
 * and never 403, exactly like every other `[id]` route.
 */
export async function GET(request: Request, context: RouteContext<"/api/jobs/[id]/logs">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("job", id);
  if (!guard.ok) {
    return guard.response;
  }

  const url = new URL(request.url);
  const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "500", 10);

  const lines = await getJobLogs(id, {
    after: Number.isFinite(after) && after > 0 ? after : 0,
    limit: Number.isFinite(limit) ? limit : 500,
  });

  if (url.searchParams.get("format") === "text") {
    /*
     * Downloaded as a file rather than shown, so it can be attached to a support
     * message. Only the lines this request asked for — the caller pages through if
     * it wants the whole thing, rather than the server building an unbounded
     * response for a run with a hundred thousand lines.
     */
    return new Response(lines.map(formatLogLine).join("\n") + "\n", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="run-${id}.log"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return Response.json({
    lines,
    /** The cursor to pass next time. Null when there was nothing at all. */
    cursor: lines.length > 0 ? lines[lines.length - 1].id : null,
  });
}
