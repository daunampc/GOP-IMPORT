import { redirect } from "next/navigation";

import { requireUser } from "@/lib/session";

import { ActivateForm } from "./activate-form";

export const dynamic = "force-dynamic";

export default async function ActivatePage({ searchParams }: PageProps<"/activate">) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);

  // Already licensed — nothing to do here.
  if (user.activated) {
    redirect("/");
  }

  return (
    <ActivateForm
      email={user.email}
      // Set when a key was rejected during registration, or when a previously
      // working key has since been revoked.
      reason={typeof params.reason === "string" && params.reason !== "" ? params.reason : null}
      hadKey={user.licenseKeyId !== null}
    />
  );
}
