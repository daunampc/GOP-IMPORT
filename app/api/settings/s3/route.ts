import { checkS3 } from "@/lib/limits";
import { getS3Public, saveS3 } from "@/lib/settings";
import { apiRequireView } from "@/lib/view";

/**
 * One account's Amazon S3 upload target.
 *
 * This used to be administrators-only, because there was ONE bucket for the
 * whole installation and handing every member the keys to it would have been
 * handing them each other's images. Now every account has its own bucket, so
 * every account edits its own — that is the entire point of per-account
 * settings, and a member who cannot set their own AWS keys cannot use the S3
 * image mode at all. The administrator-only part is editing SOMEONE ELSE's,
 * which is what `apiRequireView()` already expresses: the cookie behind
 * `ownerId` is only ever honoured for an administrator.
 *
 * Kept apart from the rest of Settings for one reason that has not changed:
 * this body carries a secret access key. The GET never returns it — the browser
 * only ever learns whether one is stored — and an empty `secretAccessKey` on
 * save means "leave the stored one alone", so the form can be re-saved without
 * anyone retyping the secret. Reading a stored secret back is a separate,
 * recorded, administrator-only action: see `app/api/admin/reveal/s3`.
 */

export async function GET() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({ s3: await getS3Public(guard.ownerId) });
}

export async function PUT(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  // An account S3 is not enabled for cannot store AWS keys either. Hiding the
  // panel would be enough for an honest user and nothing else.
  const allowed = await checkS3(guard.ownerId);
  if (!allowed.ok) {
    return allowed.response;
  }

  try {
    return Response.json({ s3: await saveS3(guard.ownerId, await request.json()) });
  } catch (error) {
    // The message comes from `saveS3`, which names missing FIELDS ("bucket",
    // "region") and never echoes a value — an error message is one of the three
    // places §2 says a secret must never reach.
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
