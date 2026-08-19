import { getWebhookPublic, saveWebhook } from "@/lib/settings";
import { apiRequireView } from "@/lib/view";

/**
 * Where this account is told a run has finished — §6 C3.
 *
 * Kept apart from the rest of Settings for the same reason the S3 route is: this
 * body carries a secret. The GET never returns it — the browser only ever learns
 * whether one is stored — and an empty `secret` on save means "leave the stored one
 * alone", so the form can be re-saved without anyone retyping it.
 *
 * Unlike the S3 secret there is no reveal action for this one, not even an
 * administrator's. It is a value the account chose and gave to its own receiver;
 * this app has no reason to hand it back, and every stored secret that cannot be
 * read is one fewer thing an administrator's password is the key to.
 *
 * No per-account switch gates it. There is nothing here an operator would want to
 * withhold: it starts nothing, writes to no site, and costs one POST per run.
 */

export async function GET() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ webhook: await getWebhookPublic(guard.ownerId) });
}

export async function PUT(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  try {
    return Response.json({
      webhook: await saveWebhook(guard.ownerId, await request.json()),
    });
  } catch (error) {
    // The message comes from `saveWebhook`, which names the reason a URL was
    // refused and never echoes the secret.
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
