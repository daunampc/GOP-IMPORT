import { telegramTest } from "@/lib/telegram";
import { apiRequireView } from "@/lib/view";

/**
 * Send one test message, now.
 *
 * Its own route because the alternative is starting a real run to find out whether
 * the chat id is right — and a Telegram setup that is silently wrong looks exactly
 * like a quiet night. Telegram's own refusal is passed through, because "chat not
 * found" and a 401 are the two mistakes people make and they need different fixes.
 *
 * POST rather than GET: it sends something. Nothing about it is idempotent.
 */
export async function POST() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const result = await telegramTest(guard.ownerId);

  return Response.json(result, { status: result.ok ? 200 : 400 });
}
