import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { sbDb } from "~/database/supabase.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export type AuditTeamMember = {
  id: string;
  name: string;
  userId: string | null;
  organizationId: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    profilePicture: string | null;
  } | null;
};

/**
 * API endpoint to fetch team members for audit assignment.
 * Only returns team members with users (excludes NRMs).
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const userId = authSession.userId;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.teamMember,
      action: PermissionAction.read,
    });

    // Fetch team members who have user accounts (exclude NRMs)
    // Using !inner join filters out rows where user is null (equivalent to Prisma's `isNot: null`)
    const { data: teamMembers, error: tmError } = await sbDb
      .from("TeamMember")
      .select(
        "*, user:User!inner(id, email, firstName, lastName, profilePicture)"
      )
      .eq("organizationId", organizationId)
      .is("deletedAt", null)
      .order("name", { ascending: true });

    if (tmError) {
      throw new ShelfError({
        cause: tmError,
        message: "Failed to fetch team members for audit assignment",
        label: "Audit",
      });
    }

    return data(payload({ teamMembers: teamMembers ?? [] }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
