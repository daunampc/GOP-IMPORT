import { emailOf, recordReveal } from "@/lib/audit";
import { apiRequireAdmin } from "@/lib/session";
import { getStoreUnscoped, revealApiSecret } from "@/lib/stores";

/**
 * Read one site's stored API secret back.
 *
 * Same shape and the same reasons as the S3 reveal beside it: POST so the
 * secret is never in a URL, one subject per call, `no-store`, the audit row
 * written and awaited before the value is returned, administrators only.
 *
 * The stakes here are if anything higher. A site API secret in plain text is
 * equivalent to full write access to that site's database — which is why
 * `toPublic()` strips it from every ordinary payload in the app, and why this
 * is the single exception.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/reveal/store/[id]">,
) {
  const guard = await apiRequireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;

  const store = await getStoreUnscoped(id);
  if (store === null) {
    return Response.json({ error: "No such site" }, { status: 404 });
  }

  const targetEmail = await emailOf(store.ownerId);

  await recordReveal({
    actor: { id: guard.user.id, email: guard.user.email },
    target: { id: store.ownerId, email: targetEmail ?? "(account deleted)" },
    kind: "store_api_secret",
    subjectId: store.id,
    // The site's URL names WHICH secret. The key id would too; the secret
    // itself never appears in this row.
    subjectLabel: store.url,
    request,
  });

  return Response.json(
    { apiSecret: revealApiSecret(store), apiKey: store.apiKey, url: store.url },
    { headers: { "Cache-Control": "no-store" } },
  );
}
