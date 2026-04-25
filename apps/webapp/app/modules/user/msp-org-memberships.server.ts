import type { OrganizationRoles } from "@prisma/client";
import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";

/**
 * MSP-side portal roles. Users in any of these need access to every
 * client organization their MSP manages, not just their MSP's own
 * organization. Client-side roles see only their own client tenant.
 */
const MSP_PORTAL_ROLES = new Set([
  "msp_admin",
  "msp_user",
  // Standard groups (when role is not directly carried via the JWT
  // role claim) that imply MSP membership.
  "super_admin",
  "admin",
  "technician",
]);

export function isMspSidePortalRole(portalRole: string): boolean {
  return MSP_PORTAL_ROLES.has(portalRole);
}

export type EnsureMspMembershipsResult = {
  /** Number of client organizations the MSP manages. */
  managedOrgs: number;
  /** UserOrganization rows newly created in this run. */
  added: number;
  /** UserOrganization rows already in place (no-op). */
  existing: number;
  /** UserOrganization rows whose role array was widened. */
  updated: number;
};

/**
 * Ensure the given user is a member of every Shelf organization that
 * sits under their MSP's portal tenant. Idempotent: runs as part of
 * provisionUserFromPortal so MSP techs land with one UserOrganization
 * per client they manage and the existing org switcher just works.
 *
 * - Looks up Organizations whose `parentPortalTenantId` matches the
 *   MSP tenant from the JWT.
 * - Upserts UserOrganization with the supplied shelfRole; if the row
 *   already exists but lacks the role, the role is appended (existing
 *   roles are preserved so manual admin changes aren't clobbered).
 *
 * Skipped (no-op) for client-side roles — they only need access to
 * their own tenant's org, which provisionUserFromPortal handles
 * separately.
 */
export async function ensureMspClientOrgMemberships(params: {
  userId: string;
  mspTenantId: string | null;
  portalRole: string;
  shelfRole: string;
}): Promise<EnsureMspMembershipsResult> {
  const { userId, mspTenantId, portalRole, shelfRole } = params;

  if (!mspTenantId || !isMspSidePortalRole(portalRole)) {
    return { managedOrgs: 0, added: 0, existing: 0, updated: 0 };
  }

  const role = shelfRole as OrganizationRoles;

  let clientOrgs: Array<{ id: string }>;
  try {
    clientOrgs = await db.organization.findMany({
      where: { parentPortalTenantId: mspTenantId },
      select: { id: true },
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to look up MSP client organizations",
      additionalData: { userId, mspTenantId },
      label: "User",
    });
  }

  if (clientOrgs.length === 0) {
    return { managedOrgs: 0, added: 0, existing: 0, updated: 0 };
  }

  const existingMemberships = await db.userOrganization.findMany({
    where: {
      userId,
      organizationId: { in: clientOrgs.map((o) => o.id) },
    },
    select: { id: true, organizationId: true, roles: true },
  });
  const existingByOrg = new Map(
    existingMemberships.map((m) => [m.organizationId, m])
  );

  let added = 0;
  let existing = 0;
  let updated = 0;

  for (const org of clientOrgs) {
    const found = existingByOrg.get(org.id);
    try {
      if (!found) {
        await db.userOrganization.create({
          data: {
            userId,
            organizationId: org.id,
            roles: [role],
          },
        });
        added += 1;
        continue;
      }

      if (!found.roles.includes(role)) {
        await db.userOrganization.update({
          where: { id: found.id },
          data: { roles: { set: [...found.roles, role] } },
        });
        updated += 1;
        continue;
      }

      existing += 1;
    } catch (cause) {
      // Don't abort the whole sync if a single org write fails. The
      // user can still launch into orgs they're already linked to.
      Logger.error(
        new ShelfError({
          cause,
          message: "Skipping UserOrganization upsert — partial MSP membership",
          additionalData: { userId, organizationId: org.id, mspTenantId },
          label: "User",
        })
      );
    }
  }

  Logger.info(
    `[msp-memberships] user=${userId} mspTenant=${mspTenantId} ` +
      `managed=${clientOrgs.length} added=${added} ` +
      `existing=${existing} updated=${updated}`
  );

  return {
    managedOrgs: clientOrgs.length,
    added,
    existing,
    updated,
  };
}
