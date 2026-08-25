import { crawlOptionsSchema } from "@/lib/crawl-options";
import { enqueueCrawl } from "@/lib/jobs";
import { limitsFor } from "@/lib/limits";
import { apiRequireView } from "@/lib/view";

/**
 * Start a crawl.
 *
 * Thin on purpose: it validates, checks the account's ceiling so the refusal is
 * immediate and actionable, and queues. Everything that takes time happens on the
 * worker, which is why this returns a run id rather than products.
 *
 * Not gated by `refusePublishingAsAdmin`, unlike `/api/purge` and `/api/import`.
 * Those exist because an administrator account does not PUBLISH — write to a
 * customer's site — of its own. A crawl never touches a customer's site at all;
 * per `runCrawl` in `worker/index.ts`, it "finishes without having touched
 * anybody's shop". What it stages is only read back once someone carries it into
 * the import wizard, and that step is where the publishing check belongs.
 */
export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "That request was not valid JSON." }, { status: 400 });
  }

  const parsed = crawlOptionsSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const options = parsed.data;

  if (options.transport === "browser") {
    return Response.json(
      { error: "Crawling through your own Chrome is not in this build yet." },
      { status: 400 },
    );
  }

  const limits = await limitsFor(guard.ownerId);
  if (!limits.importEnabled) {
    return Response.json(
      { error: "This account is not allowed to import products." },
      { status: 403 },
    );
  }

  let host: string;
  try {
    host = new URL(options.shopUrl).host;
  } catch {
    return Response.json({ error: "That is not a web address." }, { status: 400 });
  }

  const job = await enqueueCrawl({
    // The shop being READ. It is not a target site, but it is the site this run
    // talked to, which is what the run list's column means.
    storeUrl: options.shopUrl,
    storeLabel: host,
    sourceLabel: host,
    createdBy: guard.ownerId,
    options,
  });

  return Response.json({ jobId: job.id });
}
