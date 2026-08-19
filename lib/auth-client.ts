"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth.
 *
 * Only sign-in and sign-out go through this. Registration and licence
 * activation have their own routes, because both need to check a licence key
 * against the database before an account may exist at all — a rule the client
 * cannot be trusted to enforce.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? undefined,
});

export const { signIn, signOut, useSession } = authClient;
