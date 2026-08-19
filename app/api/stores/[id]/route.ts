import { z } from "zod";

import { encrypt } from "@/lib/crypto";
import { listJobs } from "@/lib/jobs";
import { expectedPluginVersion } from "@/lib/plugin-version.server";
import { apiRequireOwned } from "@/lib/ownership";
import {
  deleteStore,
  getStoreUnscoped,
  listChecks,
  storeInputSchema,
  toPublic,
  updateStore,
  type Store,
} from "@/lib/stores";

/** One site in detail: settings, check history, import history. */
export async function GET(_request: Request, context: RouteContext<"/api/stores/[id]">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("store", id);
  if (!guard.ok) {
    return guard.response;
  }

  const store = await getStoreUnscoped(id);
  if (store === null) {
    return Response.json({ error: "No such site" }, { status: 404 });
  }

  const [checks, jobs, expected] = await Promise.all([
    listChecks(id),
    // The site's runs belong to the site's OWNER, which is not the caller when
    // an administrator is looking at a member's site.
    listJobs(guard.ownerId, 200),
    expectedPluginVersion(),
  ]);

  return Response.json({
    store: toPublic(store),
    checks,
    jobs: jobs.filter((job) => job.storeId === id).slice(0, 50),
    expectedPluginVersion: expected,
  });
}

/**
 * Editing a site.
 *
 * The previous build accepted only `urlRewrite` and `label`, so changing a URL,
 * a pin or rotating a key meant deleting and recreating — and deleting takes
 * every queued run aimed at that site down with it.
 *
 * `apiSecret` is write-only: empty means keep the stored key, because the
 * browser never receives the current one to send back.
 */
const patchSchema = storeInputSchema
  .partial()
  .extend({ apiSecret: z.string().trim().optional() });

export async function PATCH(request: Request, context: RouteContext<"/api/stores/[id]">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("store", id);
  if (!guard.ok) {
    return guard.response;
  }

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  const { apiSecret, ...rest } = parsed.data;
  const patch: Partial<Omit<Store, "id">> = { ...rest };

  if (apiSecret !== undefined && apiSecret !== "") {
    patch.apiSecretEncrypted = encrypt(apiSecret);
  }

  // Once the connection settings change, the previous check result says nothing
  // about the current configuration. Keeping it would show a green light earned
  // by a setup that no longer exists.
  const touchesConnection =
    rest.url !== undefined ||
    rest.pin !== undefined ||
    rest.apiKey !== undefined ||
    rest.baseUrlOverride !== undefined ||
    rest.urlRewrite !== undefined ||
    apiSecret !== undefined;

  if (touchesConnection) {
    patch.lastCheckOk = null;
    patch.lastCheckMessage = "The settings changed — run the connection check again.";
  }

  const updated = await updateStore(id, patch);
  if (updated === null) {
    return Response.json({ error: "No such site" }, { status: 404 });
  }

  return Response.json({ store: toPublic(updated) });
}

export async function DELETE(_request: Request, context: RouteContext<"/api/stores/[id]">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("store", id);
  if (!guard.ok) {
    return guard.response;
  }

  if (!(await deleteStore(id))) {
    return Response.json({ error: "No such site" }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
