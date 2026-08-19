import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/session";
import { userCount } from "@/lib/licenses";

import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const [user, count, params] = await Promise.all([
    getSessionUser(),
    userCount(),
    searchParams,
  ]);

  // Already signed in: send them where they were going instead of showing a
  // login form they do not need.
  if (user !== null && !user.disabled) {
    redirect(user.activated ? "/" : "/activate");
  }

  return (
    <SignInForm
      // A database with no accounts at all means this is a fresh install, and
      // the first thing anyone needs is to create the administrator.
      needsSetup={count === 0}
      reason={typeof params.reason === "string" ? params.reason : null}
    />
  );
}
