import { z } from "zod";

import { emailOf, recordReveal } from "@/lib/audit";
import { apiRequireAdmin } from "@/lib/session";
import { getS3Public, revealS3Secret } from "@/lib/settings";

/**
 * Read one account's stored AWS secret access key back.
 *
 * The ONLY way an S3 secret leaves the database, and everything about the shape
 * of this route is that sentence:
 *
 *  - POST, not GET. A secret must never be in a query string, and therefore
 *    never in a browser history entry, a proxy access log or a Referer header.
 *  - One account per call, named in the body, asked for on purpose. No ordinary
 *    settings payload carries a secret, because a secret that arrives with every
 *    page load ends up in caches, screenshots and bug reports.
 *  - `no-store`, so nothing between here and the browser keeps a copy.
 *  - The audit row is written and AWAITED BEFORE the secret is put in the
 *    response. A reveal that happened without a record is exactly what the
 *    record exists to prevent, so if the write fails the reveal fails with it.
 *  - Administrators only. A member configures their own AWS keys — that is the
 *    point of per-account settings — but cannot reveal a stored one, their own
 *    included. They overwrite it instead.
 *
 * Nothing here logs, and no error message echoes a value.
 */

const bodySchema = z.object({
  userId: z.string().min(1, "Which account?"),
});

export async function POST(request: Request) {
  const guard = await apiRequireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const { userId } = parsed.data;

  const targetEmail = await emailOf(userId);
  if (targetEmail === null) {
    return Response.json({ error: "No such account." }, { status: 404 });
  }

  const secret = await revealS3Secret(userId);
  if (secret === null) {
    return Response.json(
      { error: "That account has no S3 secret access key stored." },
      { status: 404 },
    );
  }

  const s3 = await getS3Public(userId);

  await recordReveal({
    actor: { id: guard.user.id, email: guard.user.email },
    target: { id: userId, email: targetEmail },
    kind: "s3_secret_key",
    subjectId: null,
    // The bucket names WHICH secret without being one.
    subjectLabel: s3.bucket === "" ? "(no bucket set)" : s3.bucket,
    request,
  });

  return Response.json(
    { secretAccessKey: secret, account: targetEmail, bucket: s3.bucket },
    { headers: { "Cache-Control": "no-store" } },
  );
}
