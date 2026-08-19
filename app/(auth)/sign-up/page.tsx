import { redirect } from "next/navigation";

import { userCount } from "@/lib/licenses";
import { getSessionUser } from "@/lib/session";

import { SignUpForm } from "./sign-up-form";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  const [user, count] = await Promise.all([getSessionUser(), userCount()]);

  if (user !== null && !user.disabled) {
    redirect(user.activated ? "/" : "/activate");
  }

  // The first account is the administrator and is exempt from needing a key —
  // otherwise nobody could ever mint the first one.
  return <SignUpForm firstUser={count === 0} />;
}
