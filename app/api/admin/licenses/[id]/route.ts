import { revokeLicense } from "@/lib/licenses";
import { apiRequireAdmin } from "@/lib/session";

/**
 * Revoke a key.
 *
 * The row is kept, not deleted: the record of who activated what is worth more
 * than the tidiness, and the account holding it loses access at its next
 * request either way.
 */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/admin/licenses/[id]">,
) {
  const guard = await apiRequireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;

  if (!(await revokeLicense(id))) {
    return Response.json(
      { error: "No such licence key, or it was already revoked." },
      { status: 404 },
    );
  }

  return new Response(null, { status: 204 });
}
