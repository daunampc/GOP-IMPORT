import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";

/**
 * Everything better-auth serves: sign in, sign out, session, and the rest.
 *
 * Registration is NOT here — see /api/register. Creating an account has to
 * check a licence key first, and that decision cannot live in the client.
 */
export const { GET, POST } = toNextJsHandler(auth);
