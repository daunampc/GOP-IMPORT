import { activateLicense } from "@/lib/licenses";
import { getSessionUser } from "@/lib/session";

/**
 * Bind a licence key to the signed-in account.
 *
 * Used both by someone who registered without a key and by someone whose key
 * was revoked and has been given a replacement.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();

  if (user === null) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { key?: unknown } | null;

  if (body === null || typeof body.key !== "string") {
    return Response.json({ error: "`key` is required." }, { status: 400 });
  }

  const result = await activateLicense(user.id, body.key);

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  // `expiresAt` is resolved at activation, so this is the first moment anyone can
  // be told when the licence runs out. The screen says it while they are looking.
  return Response.json({ activated: true, expiresAt: result.expiresAt ?? null });
}
