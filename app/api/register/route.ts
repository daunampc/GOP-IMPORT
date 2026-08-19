import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { users } from "@/db/schema";
import { auth } from "@/lib/auth";
import { activateLicense, createLicense, userCount } from "@/lib/licenses";

/**
 * Registration.
 *
 * Deliberately not better-auth's own sign-up endpoint, because the first-account
 * rule cannot be enforced client-side: the FIRST account ever created becomes the
 * administrator and is issued a licence automatically. Somebody has to be able to
 * mint the first key, and requiring a key to create the account that mints keys is
 * a locked door with the key inside.
 *
 * ANYONE ELSE MAY REGISTER WITHOUT A KEY, and the account they get is inert.
 *
 * That is a deliberate change. Registration used to demand an unused licence key,
 * which meant the operator had to hand out a key before a customer could even see
 * the sign-in screen. Now the gate sits one step later: the account exists, it can
 * sign in, and every screen redirects to `/activate` until a key is bound — see
 * `lib/session.ts`, which re-derives that on every single request rather than
 * trusting the session.
 *
 * What this widens, stated plainly: anybody can now create an account. It grants
 * nothing — an unactivated account cannot read, write or run anything — but the
 * `user` table can now collect junk rows, and there is no rate limit or email
 * verification in front of it. That is a known and accepted consequence, not an
 * oversight.
 *
 * A key may still be supplied here as a convenience, and is bound on the spot when
 * it is. A key that turns out to be bad no longer fails the registration: the
 * account is created anyway and the reason is carried to the activation screen,
 * because throwing away a password somebody just chose over a mistyped key is a
 * worse outcome than letting them try the key again.
 */

const bodySchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120),
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(10, "Password must be at least 10 characters").max(128),
  licenseKey: z.string().trim().default(""),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const { name, email, password, licenseKey } = parsed.data;

  const existing = await userCount();
  const isFirstUser = existing === 0;

  // No licence check before the account is created. An account with no key is a
  // valid, expected state now — it simply cannot do anything until one is bound.

  let created: { user: { id: string } } | null = null;

  try {
    created = await auth.api.signUpEmail({
      body: { name, email, password },
      // Pass the request headers so better-auth can set the session cookie.
      headers: request.headers,
      asResponse: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The most common cause by far, and the one worth naming explicitly.
    const duplicate = /exists|unique|duplicate/i.test(message);

    return Response.json(
      {
        error: duplicate
          ? "An account with that email address already exists."
          : `Could not create the account: ${message}`,
      },
      { status: duplicate ? 409 : 400 },
    );
  }

  if (!created?.user?.id) {
    return Response.json({ error: "Could not create the account." }, { status: 400 });
  }

  const userId = created.user.id;

  if (isFirstUser) {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, userId));

    // The administrator gets a real licence, auto-issued and bound on the spot.
    //
    // The alternative — teaching the guard that admins skip the licence check —
    // would put a second, invisible rule next to the visible one, and the two
    // would drift. This way "every account holds a licence" stays literally
    // true, and the admin's key shows up in the list like any other.
    const [issued] = await createLicense({
      note: "Administrator (issued automatically at first run)",
      createdBy: userId,
    });

    const activation = await activateLicense(userId, issued.key);

    if (!activation.ok) {
      return Response.json(
        {
          user: { id: userId, email, role: "admin" },
          firstUser: true,
          activated: false,
          error: activation.error,
        },
        { status: 202 },
      );
    }

    return Response.json(
      {
        user: { id: userId, email, role: "admin" },
        firstUser: true,
        activated: true,
        message: "Administrator account created.",
      },
      { status: 201 },
    );
  }

  // No key offered: the ordinary path now. The account is real and inert, and the
  // sign-up screen sends them straight to `/activate`.
  if (licenseKey === "") {
    return Response.json(
      {
        user: { id: userId, email, role: "member" },
        activated: false,
        needsKey: true,
      },
      { status: 201 },
    );
  }

  const activation = await activateLicense(userId, licenseKey);

  if (!activation.ok) {
    // The account exists but holds no licence. Rather than delete it — which
    // would throw away a password the person just chose — leave it and send
    // them to the activation screen with the reason.
    return Response.json(
      {
        user: { id: userId, email, role: "member" },
        activated: false,
        needsKey: true,
        error: activation.error,
      },
      { status: 201 },
    );
  }

  return Response.json(
    {
      user: { id: userId, email, role: "member" },
      activated: true,
      expiresAt: activation.expiresAt ?? null,
    },
    { status: 201 },
  );
}

/**
 * Whether this is the very first account.
 *
 * The sign-up screen uses it only to change its heading and to say that this
 * account will be the administrator — it no longer decides whether a key field is
 * shown, because a key is never required to register.
 */
export async function GET() {
  return Response.json({ firstUser: (await userCount()) === 0 });
}
