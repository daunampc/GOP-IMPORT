import { getS3Public, getSettings, saveSettings } from "@/lib/settings";
import { expectedPluginVersion } from "@/lib/plugin-version.server";
import { apiRequireView } from "@/lib/view";

/**
 * One account's configuration.
 *
 * `s3` here is the BROWSER-SAFE projection: it says whether a secret access key
 * is stored, never what it is. The real value has one way out of the database,
 * and it is `POST /api/admin/reveal/s3`, which an administrator has to call on
 * purpose and which writes an audit row. A secret that came back with this
 * payload would be in every browser cache, screenshot and bug report the
 * Settings screen ever appeared in.
 *
 * Returns the READ-ONLY part of the environment alongside it — worker lanes,
 * the expected plugin version. Those live in `.env` and the web process cannot
 * write there; they are shown for diagnosis, and said to be read-only rather
 * than dressed up as an input with a Save button that does nothing.
 */
export async function GET() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  return Response.json({
    settings: await getSettings(guard.ownerId),
    s3: await getS3Public(guard.ownerId),
    environment: {
      workerConcurrency: process.env.WORKER_CONCURRENCY ?? "4",
      redisUrl: maskRedisUrl(process.env.REDIS_URL ?? "redis://127.0.0.1:6379"),
      encryptionKeyConfigured: Boolean(process.env.STORE_ENCRYPTION_KEY?.trim()),
      expectedPluginVersion: await expectedPluginVersion(),
      nodeVersion: process.version,
    },
  });
}

export async function PUT(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const settings = await saveSettings(guard.ownerId, await request.json());
    return Response.json({ settings });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

/** Mask the password in REDIS_URL — it is a secret even on an internal screen. */
function maskRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
