import type { OrganizationRoles } from "@prisma/client";
import { AssetIndexMode } from "@prisma/client";
import type { Sb } from "@shelf/database";
import { sbDb } from "~/database/supabase.server";
import { ShelfError } from "~/utils/error";
import { id as generateId } from "~/utils/id/id.server";
import type { PortalClaims } from "~/utils/portal-auth.server";
import {
  mapPortalRoleToShelfRole,
  fetchTenantInfo,
} from "~/utils/portal-auth.server";
import { randomUsernameFromEmail } from "~/utils/user";
import { defaultFields } from "../asset-index-settings/helpers";
import { defaultUserCategories } from "../category/default-categories";
import { getDefaultWeeklySchedule } from "../working-hours/service.server";

/**
 * Portal columns (portalUserId, portalTenantId, portalRole, etc.) exist in
 * the Prisma schema but the Supabase generated types are not updated until
 * the migration is deployed. We work around this by typing portal-specific
 * data as a plain record so the Supabase client accepts it.
 */
type PortalUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  onboarded: boolean;
  portalUserId: string | null;
  portalTenantId: string | null;
  portalRole: string | null;
};

type PortalOrg = {
  id: string;
  name: string;
  type: string;
};

export async function provisionUserFromPortal(
  claims: PortalClaims,
  portalToken: string
): Promise<{ user: PortalUser; organization: PortalOrg }> {
  // 1. Find user by portalUserId
  let user = await findUserByPortalId(claims.sub);

  if (!user) {
    // Check if user exists by email (migration case)
    user = await findUserByEmail(claims.email);

    if (user) {
      // Link existing user to portal
      await (sbDb.from("User") as any)
        .update({
          portalUserId: claims.sub,
          portalTenantId: claims.tenantId,
          portalRole: claims.role,
          sso: true,
          onboarded: true,
        })
        .eq("id", user.id);

      user.portalUserId = claims.sub;
      user.portalTenantId = claims.tenantId;
      user.portalRole = claims.role;
    }
  }

  if (!user) {
    // Create new user
    const [firstName, ...lastParts] = claims.name.split(" ");
    const lastName = lastParts.join(" ") || null;

    user = await createUserFromPortal({
      portalUserId: claims.sub,
      email: claims.email,
      firstName,
      lastName,
      portalTenantId: claims.tenantId,
      portalRole: claims.role,
    });
  } else {
    // Update existing user's portal metadata
    await (sbDb.from("User") as any)
      .update({
        portalRole: claims.role,
        portalTenantId: claims.tenantId,
      })
      .eq("id", user.id);
  }

  // 2. Find or create organization for this tenant
  const organization = await resolveOrganization(
    claims,
    user.id,
    user.firstName,
    user.lastName,
    portalToken
  );

  // 3. Ensure user is linked to org with correct role
  const shelfRole = mapPortalRoleToShelfRole(claims.role, claims.permissions);
  await ensureUserOrgMembership(user.id, organization.id, shelfRole);

  return { user, organization };
}

// --- Internal Helpers ---

async function findUserByPortalId(
  portalUserId: string
): Promise<PortalUser | null> {
  // Portal columns may not be in Supabase types yet — use `as any`
  const { data } = await (sbDb.from("User") as any)
    .select(
      "id, email, firstName, lastName, portalUserId, portalTenantId, portalRole, onboarded"
    )
    .eq("portalUserId", portalUserId)
    .maybeSingle();

  return data as PortalUser | null;
}

async function findUserByEmail(email: string): Promise<PortalUser | null> {
  const { data } = await sbDb
    .from("User")
    .select("id, email, firstName, lastName, onboarded")
    .eq("email", email.toLowerCase())
    .maybeSingle();

  if (!data) return null;

  return {
    ...data,
    portalUserId: null,
    portalTenantId: null,
    portalRole: null,
  };
}

async function createUserFromPortal(payload: {
  portalUserId: string;
  email: string;
  firstName: string;
  lastName: string | null;
  portalTenantId: string | null;
  portalRole: string;
}): Promise<PortalUser> {
  const userId = generateId();
  const username = randomUsernameFromEmail(payload.email);

  try {
    // Create user record — portal columns use `as any` until Supabase types are regenerated
    const { data: user, error: userError } = await (sbDb.from("User") as any)
      .insert({
        id: userId,
        email: payload.email.toLowerCase(),
        username,
        firstName: payload.firstName,
        lastName: payload.lastName,
        portalUserId: payload.portalUserId,
        portalTenantId: payload.portalTenantId,
        portalRole: payload.portalRole,
        onboarded: true,
        sso: true,
      })
      .select(
        "id, email, firstName, lastName, portalUserId, portalTenantId, portalRole, onboarded"
      )
      .single();

    if (userError) throw userError;

    // Link user to the USER role
    const { data: roleRecord, error: roleError } = await sbDb
      .from("Role")
      .select("id")
      .eq("name", "USER")
      .single();

    if (roleError) throw roleError;

    const { error: roleJoinError } = await sbDb
      .from("_RoleToUser")
      .insert({ A: roleRecord.id, B: userId });

    if (roleJoinError) throw roleJoinError;

    return user as PortalUser;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to create user from portal",
      additionalData: { email: payload.email },
      label: "User",
    });
  }
}

async function resolveOrganization(
  claims: PortalClaims,
  userId: string,
  firstName: string | null,
  lastName: string | null,
  portalToken: string
): Promise<PortalOrg> {
  if (!claims.tenantId) {
    // Superadmin — use or create a personal org
    return getOrCreatePersonalOrg(userId, firstName, lastName);
  }

  // Find org by portal tenant ID — portal columns use `as any`
  const { data: existingOrg } = await (sbDb.from("Organization") as any)
    .select("id, name, type")
    .eq("portalTenantId", claims.tenantId)
    .maybeSingle();

  if (existingOrg) {
    return existingOrg as PortalOrg;
  }

  // Create org for this tenant
  return createOrgForTenant(claims, userId, firstName, lastName, portalToken);
}

async function getOrCreatePersonalOrg(
  userId: string,
  firstName: string | null,
  lastName: string | null
): Promise<PortalOrg> {
  // Check if user already has a personal org
  const { data: existing } = await sbDb
    .from("Organization")
    .select("id, name, type")
    .eq("userId", userId)
    .eq("type", "PERSONAL")
    .maybeSingle();

  if (existing) {
    return existing;
  }

  // Check for any TEAM org
  const { data: teamOrg } = await sbDb
    .from("Organization")
    .select("id, name, type")
    .eq("userId", userId)
    .eq("type", "TEAM")
    .limit(1)
    .maybeSingle();

  if (teamOrg) {
    return teamOrg;
  }

  // Create a personal org
  const orgId = generateId();
  const { data: org, error: orgError } = await sbDb
    .from("Organization")
    .insert({
      id: orgId,
      name: "Personal",
      userId,
      hasSequentialIdsMigrated: true,
    })
    .select("id, name, type")
    .single();

  if (orgError) throw orgError;

  await setupOrgDefaults(orgId, userId, firstName, lastName);

  return org;
}

async function createOrgForTenant(
  claims: PortalClaims,
  userId: string,
  firstName: string | null,
  lastName: string | null,
  portalToken: string
): Promise<PortalOrg> {
  const orgId = generateId();

  // Determine parent tenant ID for client orgs
  let parentPortalTenantId: string | null = null;
  if (claims.role === "client_admin" || claims.role === "client_user") {
    const tenantInfo = await fetchTenantInfo(portalToken);
    parentPortalTenantId = tenantInfo.parentTenantId;
  }

  const orgName = claims.tenantSlug || "Workspace";

  // Portal columns use `as any` until Supabase types are regenerated
  const { data: org, error: orgError } = await (
    sbDb.from("Organization") as any
  )
    .insert({
      id: orgId,
      name: orgName,
      type: "TEAM",
      userId,
      portalTenantId: claims.tenantId,
      portalTenantSlug: claims.tenantSlug,
      parentPortalTenantId,
      hasSequentialIdsMigrated: true,
    })
    .select("id, name, type")
    .single();

  if (orgError) throw orgError;

  await setupOrgDefaults(orgId, userId, firstName, lastName);

  return org as PortalOrg;
}

async function setupOrgDefaults(
  orgId: string,
  userId: string,
  firstName: string | null,
  lastName: string | null
) {
  // Create default categories
  const categoryInserts = defaultUserCategories.map((c) => ({
    ...c,
    userId,
    organizationId: orgId,
  }));

  if (categoryInserts.length > 0) {
    await sbDb.from("Category").insert(categoryInserts);
  }

  // Create team member for the owner
  const memberName = [...[firstName, lastName].filter(Boolean), "(Owner)"].join(
    " "
  );

  await sbDb.from("TeamMember").insert({
    name: memberName,
    organizationId: orgId,
    userId,
  });

  // Create asset index settings
  await sbDb.from("AssetIndexSettings").insert({
    mode: AssetIndexMode.ADVANCED as Sb.AssetIndexMode,
    columns: defaultFields as unknown,
    userId,
    organizationId: orgId,
  });

  // Create working hours
  await sbDb.from("WorkingHours").insert({
    enabled: false,
    weeklySchedule: getDefaultWeeklySchedule() as unknown,
    organizationId: orgId,
  });

  // Create booking settings
  await sbDb.from("BookingSettings").insert({
    bufferStartTime: 0,
    organizationId: orgId,
  });
}

async function ensureUserOrgMembership(
  userId: string,
  organizationId: string,
  shelfRole: string
) {
  const role = shelfRole as OrganizationRoles;

  // Check if association already exists
  const { data: existing } = await sbDb
    .from("UserOrganization")
    .select("id, roles")
    .eq("userId", userId)
    .eq("organizationId", organizationId)
    .maybeSingle();

  if (!existing) {
    // Create new association
    await sbDb.from("UserOrganization").insert({
      userId,
      organizationId,
      roles: [role] as Sb.OrganizationRoles[],
    });

    // Create team member
    const { data: user } = await sbDb
      .from("User")
      .select("firstName, lastName")
      .eq("id", userId)
      .single();

    if (user) {
      const memberName = [user.firstName, user.lastName]
        .filter(Boolean)
        .join(" ");

      // Check if team member already exists
      const { data: existingMember } = await sbDb
        .from("TeamMember")
        .select("id")
        .eq("userId", userId)
        .eq("organizationId", organizationId)
        .maybeSingle();

      if (!existingMember) {
        await sbDb.from("TeamMember").insert({
          name: memberName || "Team Member",
          organizationId,
          userId,
        });
      }
    }
  } else {
    // Update role if changed
    const currentRoles = existing.roles as string[];
    if (!currentRoles.includes(role)) {
      await sbDb
        .from("UserOrganization")
        .update({ roles: [role] as Sb.OrganizationRoles[] })
        .eq("id", existing.id);
    }
  }
}
