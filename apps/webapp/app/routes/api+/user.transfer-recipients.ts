import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { makeShelfError } from "~/utils/error";
import { error, getParams } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.teamMember,
      action: PermissionAction.changeRole,
    });

    const url = new URL(request.url);
    const { excludeUserId } = getParams(
      Object.fromEntries(url.searchParams),
      z.object({ excludeUserId: z.string() }),
      { additionalData: { userId, organizationId } }
    );

    /** Fetch OWNER and ADMIN users in this org, excluding the target user */
    const { data: userOrgs } = await sbDb
      .from("UserOrganization")
      .select("roles, User(id, firstName, lastName, email)")
      .eq("organizationId", organizationId)
      .neq("userId", excludeUserId)
      .overlaps("roles", ["OWNER", "ADMIN"]);

    return data(
      (userOrgs || []).map((uo: any) => ({
        id: uo.User.id,
        name: `${uo.User.firstName ?? ""} ${uo.User.lastName ?? ""}`.trim(),
        email: uo.User.email,
        isOwner: (uo.roles as string[]).includes("OWNER"),
      }))
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
