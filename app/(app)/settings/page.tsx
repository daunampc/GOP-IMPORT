import { expectedPluginVersion } from "@/lib/plugin-version.server";
import { getS3Public, getSettings, getTelegramPublic, getWebhookPublic } from "@/lib/settings";
import { getAccount, requireView } from "@/lib/view";

import { SettingsView } from "./settings-view";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, ownerId, actingAs } = await requireView();

  const [settings, s3, webhook, telegram, expected, owner] = await Promise.all([
    getSettings(ownerId),
    // The browser-safe projection: whether a secret is stored, never what it
    // is. Reading one back is a separate, recorded, administrator-only action.
    getS3Public(ownerId),
    // Same projection for the notification webhook, and there is no reveal for
    // that one at all — see `app/api/settings/webhook/route.ts`.
    getWebhookPublic(ownerId),
    // Same projection again: whether a token is stored, never the token.
    getTelegramPublic(ownerId),
    expectedPluginVersion(),
    actingAs ? Promise.resolve(actingAs) : getAccount(user.id),
  ]);

  return (
    <SettingsView
      initial={settings}
      s3={s3}
      webhook={webhook}
      telegram={telegram}
      // Every account edits its own S3 — a member who cannot set their own AWS
      // keys cannot use the S3 image mode at all. What is restricted is reading
      // a stored secret BACK, which repairs someone's configuration and is
      // therefore an administrator's action and a recorded one.
      canReveal={user.role === "admin"}
      revealTarget={{ id: ownerId, email: owner?.email ?? user.email }}
      environment={{
        workerConcurrency: process.env.WORKER_CONCURRENCY ?? "4",
        encryptionKeyConfigured: Boolean(process.env.STORE_ENCRYPTION_KEY?.trim()),
        expectedPluginVersion: expected,
        nodeVersion: process.version,
      }}
    />
  );
}
