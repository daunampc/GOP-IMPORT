import { checkStore, getStoreUnscoped } from "@/lib/stores";
import { apiRequireOwned } from "@/lib/ownership";

/** The connection check for ONE site — calls the plugin's `/health`. */
export async function POST(_request: Request, context: RouteContext<"/api/stores/[id]/check">) {
  const { id } = await context.params;

  const guard = await apiRequireOwned("store", id);
  if (!guard.ok) {
    return guard.response;
  }

  const store = await getStoreUnscoped(id);
  if (store === null) {
    return Response.json({ error: "No such site" }, { status: 404 });
  }

  return Response.json({ result: await checkStore(store) });
}
