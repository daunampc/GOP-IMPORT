import { checkRedis } from "@/lib/redis";
import { apiRequireActive } from "@/lib/session";

/**
 * A Redis health check.
 *
 * Redis backs the run queue and the cancel flag. Losing it produces exactly one
 * visible symptom — everything stops moving — so there has to be somewhere that
 * answers the question directly.
 */
export async function GET() {
  const guard = await apiRequireActive();
  if (!guard.ok) {
    return guard.response;
  }

  const health = await checkRedis();
  return Response.json({ redis: health }, { status: health.ok ? 200 : 503 });
}
