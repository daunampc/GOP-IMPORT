import { getTelegramPublic, saveTelegram } from "@/lib/settings";
import { apiRequireView } from "@/lib/view";

/**
 * One account's Telegram destination for run notifications.
 *
 * Apart from the rest of Settings for the same reason the S3 and webhook routes are:
 * the body carries a credential. The bot token is never returned — the browser only
 * ever learns whether one is stored — and an empty token on save means "keep the
 * stored one", so the form can be re-saved without anybody retyping it.
 *
 * The chat id IS returned, and that is deliberate rather than an oversight: it is not
 * a secret, finding it is the fiddly half of setting Telegram up, and hiding it would
 * make a working configuration impossible to check.
 */

export async function GET() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ telegram: await getTelegramPublic(guard.ownerId) });
}

export async function PUT(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  try {
    return Response.json({
      telegram: await saveTelegram(guard.ownerId, await request.json()),
    });
  } catch (error) {
    // From `saveTelegram`, which names the missing FIELD and never echoes the token.
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
