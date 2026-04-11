import type { SsoDetails } from "@prisma/client";
import { OrganizationRoles, Roles } from "@prisma/client";
import type { AppLoadContext } from "react-router";
import { sbDb } from "~/database/supabase.server";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import { ShelfError } from "./error";
import type {
  PermissionAction,
  PermissionEntity,
} from "./permissions/permission.data";
import { PermissionAction as PA } from "./permissions/permission.data";
import { validatePermission } from "./permissions/permission.validator.server";

export async function requireUserWithPermission(name: Roles, userId: string) {
  try {
    // Find the role ID for the given role name
    const { data: role, error: roleErr } = await sbDb
      .from("Role")
      .select("id")
      .eq("name", name)
      .limit(1)
      .single();

    if (roleErr || !role) {
      throw new ShelfError({
        cause: roleErr,
        message: "You do not have permission to access this resource",
        additionalData: { userId, name },
        label: "Permission",
        status: 403,
      });
    }

    // Check if user has this role via the join table
    const { data: userRole, error: userRoleErr } = await sbDb
      .from("_RoleToUser")
      .select("B")
      .eq("A", role.id)
      .eq("B", userId)
      .limit(1)
      .maybeSingle();

    if (userRoleErr || !userRole) {
      throw new ShelfError({
        cause: userRoleErr,
        message: "You do not have permission to access this resource",
        additionalData: { userId, name },
        label: "Permission",
        status: 403,
      });
    }

    return { id: userId };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "You do not have permission to access this resource",
      additionalData: { userId, name },
      label: "Permission",
      status: 403,
    });
  }
}

export async function requireAdmin(userId: string) {
  return requireUserWithPermission(Roles["ADMIN"], userId);
}

export async function isAdmin(context: Record<string, any>) {
  const authSession = context.getSession();

  // Find the ADMIN role ID
  const { data: role } = await sbDb
    .from("Role")
    .select("id")
    .eq("name", Roles["ADMIN"])
    .limit(1)
    .single();

  if (!role) return false;

  // Check if user has this role via the join table
  const { data: userRole } = await sbDb
    .from("_RoleToUser")
    .select("B")
    .eq("A", role.id)
    .eq("B", authSession.userId)
    .limit(1)
    .maybeSingle();

  return !!userRole;
}

export async function requirePermission({
  userId,
  request,
  entity,
  action,
  context,
}: {
  userId: string;
  request: Request;
  entity: PermissionEntity;
  action: PermissionAction;
  context?: AppLoadContext;
}) {
  // Enforce readonly for portal users on write actions
  if (context && action !== PA.read) {
    try {
      const session = context.getSession();
      if (session.isReadonly) {
        throw new ShelfError({
          cause: null,
          message: "Your account has read-only access",
          label: "Auth",
          status: 403,
        });
      }
    } catch (cause) {
      // Re-throw ShelfErrors (readonly), ignore session-not-found
      if (cause instanceof ShelfError) throw cause;
    }
  }

  const {
    organizationId,
    userOrganizations,
    organizations,
    currentOrganization,
  } = await getSelectedOrganization({ userId, request });

  const roles = userOrganizations.find(
    (o) => o.organization.id === organizationId
  )?.roles;

  await validatePermission({
    roles,
    action,
    entity,
    organizationId,
    userId,
  });

  const role = roles ? roles[0] : OrganizationRoles.BASE;

  const isSelfServiceOrBase =
    role === OrganizationRoles.SELF_SERVICE || role === OrganizationRoles.BASE;

  /**
   * This checks the organization settings permissions overrides for BASE and SELF_SERVICE roles
   * If the user is in a BASE or SELF_SERVICE role, we check if they can see all bookings
   */
  const canSeeAllBookings =
    // Admin/Owner always can see all
    !isSelfServiceOrBase ||
    // SELF_SERVICE can see all if org setting allows
    (role === OrganizationRoles.SELF_SERVICE &&
      currentOrganization.selfServiceCanSeeBookings) ||
    // BASE can see all if org setting allows
    (role === OrganizationRoles.BASE &&
      currentOrganization.baseUserCanSeeBookings);

  // Determine if user can see all custody information
  const canSeeAllCustody =
    // Admin/Owner always can see all
    !isSelfServiceOrBase ||
    // SELF_SERVICE can see all if org setting allows
    (role === OrganizationRoles.SELF_SERVICE &&
      currentOrganization.selfServiceCanSeeCustody) ||
    // BASE can see all if org setting allows
    (role === OrganizationRoles.BASE &&
      currentOrganization.baseUserCanSeeCustody);

  // Determine if user can use barcodes based on organization settings
  const canUseBarcodes = currentOrganization.barcodesEnabled ?? false;

  // Determine if user can use audits based on organization settings
  const canUseAudits = currentOrganization.auditsEnabled ?? false;

  return {
    organizations,
    organizationId,
    currentOrganization,
    role,
    isSelfServiceOrBase,
    userOrganizations,
    canSeeAllBookings,
    canSeeAllCustody,
    canUseBarcodes,
    canUseAudits,
  };
}

/** Gets the role needed for SSO login from the groupID returned by the SSO claims */
export function getRoleFromGroupId(
  ssoDetails: SsoDetails,
  groupIds: string[]
): OrganizationRoles | null {
  // We prioritize the admin group. If for some reason the user is in both groups, they will be an admin
  if (ssoDetails.adminGroupId && groupIds.includes(ssoDetails.adminGroupId)) {
    return OrganizationRoles.ADMIN;
  } else if (
    ssoDetails.selfServiceGroupId &&
    groupIds.includes(ssoDetails.selfServiceGroupId)
  ) {
    return OrganizationRoles.SELF_SERVICE;
  } else if (
    ssoDetails.baseUserGroupId &&
    groupIds.includes(ssoDetails.baseUserGroupId)
  ) {
    return OrganizationRoles.BASE;
  } else {
    return null;
  }
}
