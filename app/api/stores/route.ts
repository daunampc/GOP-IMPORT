import { expectedPluginVersion } from "@/lib/plugin-version.server";
import { createStore, listStores, storeInputSchema, toPublic } from "@/lib/stores";
import { checkNewStore } from "@/lib/limits";
import { apiRequireView } from "@/lib/view";

export async function GET() {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const stores = await listStores(guard.ownerId);

  return Response.json({
    stores: stores.map(toPublic),
    // Included so the UI can compare versions without a second round trip.
    expectedPluginVersion: await expectedPluginVersion(),
  });
}

export async function POST(request: Request) {
  const guard = await apiRequireView();
  if (!guard.ok) {
    return guard.response;
  }

  const allowed = await checkNewStore(guard.ownerId);
  if (!allowed.ok) {
    return allowed.response;
  }

  const parsed = storeInputSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((issue) => issue.message).join("; ") },
      { status: 400 },
    );
  }

  // Connected INTO whichever account is on screen, so an administrator adding
  // a site on a customer's behalf adds it to the customer.
  const store = await createStore(guard.ownerId, parsed.data);

  return Response.json({ store: toPublic(store) }, { status: 201 });
}
