import {
  AssetIndexMode,
  OrganizationRoles,
  OrganizationType,
} from "@prisma/client";
import type { Sb } from "@shelf/database";
import { db } from "~/database/db.server";
import { sbDb } from "~/database/supabase.server";
import type { ErrorLabel } from "~/utils/error";
import { ShelfError } from "~/utils/error";
import { id as generateId } from "~/utils/id/id.server";
import { defaultFields } from "../asset-index-settings/helpers";
import { defaultUserCategories } from "../category/default-categories";
import { getDefaultWeeklySchedule } from "../working-hours/service.server";

const label: ErrorLabel = "Organization";

// ─── Tenant List ─────────────────────────────────────────────────────

export type TenantListItem = {
  id: string;
  childOrgId: string;
  childOrgName: string;
  childOrgImageId: string | null;
  deviceCount: number;
  lastSync: Date | null;
  syncStatus: "connected" | "disconnected" | "error";
  syncErrors: number;
  isActive: boolean;
};

/**
 * Get all client orgs managed by an MSP org, with device counts
 * and sync status.
 */
export async function getTenantsForMsp({
  mspOrgId,
  page = 1,
  perPage = 25,
  search,
}: {
  mspOrgId: string;
  page?: number;
  perPage?: number;
  search?: string;
}) {
  const where = {
    parentOrgId: mspOrgId,
    isActive: true,
    ...(search
      ? {
          childOrg: {
            name: { contains: search, mode: "insensitive" as const },
          },
        }
      : {}),
  };

  const [relationships, totalTenants] = await Promise.all([
    db.orgRelationship.findMany({
      where,
      skip: (page - 1) * perPage,
      take: perPage,
      orderBy: { childOrg: { name: "asc" } },
      include: {
        childOrg: {
          select: {
            id: true,
            name: true,
            imageId: true,
            _count: { select: { assets: true } },
          },
        },
      },
    }),
    db.orgRelationship.count({ where }),
  ]);

  // Gather child org IDs for batch sync status query
  const childOrgIds = relationships.map((r) => r.childOrgId);

  // Get latest sync log per child org
  const latestSyncLogs = childOrgIds.length
    ? await db.syncLog.findMany({
        where: { organizationId: { in: childOrgIds } },
        orderBy: { startedAt: "desc" },
        distinct: ["organizationId"],
        select: {
          organizationId: true,
          status: true,
          startedAt: true,
          completedAt: true,
        },
      })
    : [];

  // Get count of failed sync logs in last 24h per child org
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const failedSyncCounts = childOrgIds.length
    ? await db.syncLog.groupBy({
        by: ["organizationId"],
        where: {
          organizationId: { in: childOrgIds },
          status: "failed",
          startedAt: { gte: oneDayAgo },
        },
        _count: true,
      })
    : [];

  const syncLogMap = new Map(latestSyncLogs.map((l) => [l.organizationId, l]));
  const failedMap = new Map(
    failedSyncCounts.map((f) => [f.organizationId, f._count])
  );

  const tenants: TenantListItem[] = relationships.map((rel) => {
    const latestSync = syncLogMap.get(rel.childOrgId);
    const failedCount = failedMap.get(rel.childOrgId) ?? 0;

    let syncStatus: TenantListItem["syncStatus"] = "disconnected";
    if (latestSync) {
      syncStatus = latestSync.status === "failed" ? "error" : "connected";
    }

    return {
      id: rel.id,
      childOrgId: rel.childOrgId,
      childOrgName: rel.childOrg.name,
      childOrgImageId: rel.childOrg.imageId,
      deviceCount: rel.childOrg._count.assets,
      lastSync: latestSync?.completedAt ?? latestSync?.startedAt ?? null,
      syncStatus,
      syncErrors: failedCount,
      isActive: rel.isActive,
    };
  });

  return { tenants, totalTenants };
}

// ─── Lazy Provisioning ──────────────────────────────────────────────

/**
 * Create a new client org under an MSP parent and add the MSP admin
 * as ADMIN in the child org. Returns the new org ID.
 */
export async function provisionClientOrg({
  mspOrgId,
  clientName,
  userId,
}: {
  mspOrgId: string;
  clientName: string;
  userId: string;
}) {
  try {
    // Verify the calling org is actually an MSP
    const mspOrg = await db.organization.findUnique({
      where: { id: mspOrgId },
      select: { orgTier: true },
    });

    if (!mspOrg || mspOrg.orgTier !== "MSP") {
      throw new ShelfError({
        cause: null,
        message: "Only MSP organizations can provision client orgs",
        label,
        status: 403,
      });
    }

    // Get user info for TeamMember creation
    const { data: owner, error: ownerError } = await sbDb
      .from("User")
      .select("id, firstName, lastName")
      .eq("id", userId)
      .single();

    if (ownerError || !owner) {
      throw new ShelfError({
        cause: ownerError,
        message: "User not found",
        label,
        additionalData: { userId },
      });
    }

    // Create the client organization
    const orgId = generateId();
    const { data: org, error: orgError } = await sbDb
      .from("Organization")
      .insert({
        id: orgId,
        name: clientName,
        currency: "USD",
        type: OrganizationType.TEAM as Sb.OrganizationType,
        orgTier: "CLIENT" as Sb.OrgTier,
        hasSequentialIdsMigrated: true,
        userId, // owner FK
      })
      .select()
      .single();

    if (orgError || !org) {
      throw orgError || new Error("Failed to create client organization");
    }

    // Insert default categories
    const categoryInserts = defaultUserCategories.map((c) => ({
      ...c,
      userId,
      organizationId: orgId,
    }));
    const { error: catError } = await sbDb
      .from("Category")
      .insert(categoryInserts);
    if (catError) throw catError;

    // Insert UserOrganization — MSP admin gets ADMIN role
    const { error: userOrgError } = await sbDb.from("UserOrganization").insert({
      userId,
      organizationId: orgId,
      roles: [OrganizationRoles.ADMIN] as Sb.OrganizationRoles[],
    });
    if (userOrgError) throw userOrgError;

    // Insert TeamMember for the MSP admin
    const { error: memberError } = await sbDb.from("TeamMember").insert({
      name: `${owner.firstName} ${owner.lastName}`,
      userId: owner.id,
      organizationId: orgId,
    });
    if (memberError) throw memberError;

    // Insert AssetIndexSettings
    const { error: aisError } = await sbDb.from("AssetIndexSettings").insert({
      mode: AssetIndexMode.ADVANCED as Sb.AssetIndexMode,
      columns: defaultFields as unknown,
      userId,
      organizationId: orgId,
    });
    if (aisError) throw aisError;

    // Insert WorkingHours
    const { error: whError } = await sbDb.from("WorkingHours").insert({
      enabled: false,
      weeklySchedule: getDefaultWeeklySchedule() as unknown,
      organizationId: orgId,
    });
    if (whError) throw whError;

    // Insert BookingSettings
    const { error: bsError } = await sbDb.from("BookingSettings").insert({
      bufferStartTime: 0,
      organizationId: orgId,
    });
    if (bsError) throw bsError;

    // Create OrgRelationship: MSP → Client
    await db.orgRelationship.create({
      data: {
        parentOrgId: mspOrgId,
        childOrgId: orgId,
      },
    });

    return { organizationId: orgId, name: clientName };
  } catch (cause) {
    if (cause instanceof ShelfError) throw cause;
    throw new ShelfError({
      cause,
      message: "Failed to provision client organization",
      label,
    });
  }
}

// ─── MSP Guard ──────────────────────────────────────────────────────

/**
 * Verify the current org is an MSP. Throws 403 if not.
 */
export async function requireMspOrg(organizationId: string) {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { orgTier: true, name: true },
  });

  if (!org || org.orgTier !== "MSP") {
    throw new ShelfError({
      cause: null,
      message: "This feature is only available for MSP organizations",
      label,
      status: 403,
    });
  }

  return org;
}

// ─── Sync Status Dashboard ──────────────────────────────────────────

export type SyncDashboardStats = {
  totalTenants: number;
  totalDevices: number;
  tenantsWithErrors: number;
  lastSyncAt: Date | null;
  syncLogsLast24h: number;
  failedSyncsLast24h: number;
};

/**
 * Get aggregate sync dashboard stats for an MSP org.
 */
export async function getSyncDashboardStats(
  mspOrgId: string
): Promise<SyncDashboardStats> {
  const childOrgIds = (
    await db.orgRelationship.findMany({
      where: { parentOrgId: mspOrgId, isActive: true },
      select: { childOrgId: true },
    })
  ).map((r) => r.childOrgId);

  if (childOrgIds.length === 0) {
    return {
      totalTenants: 0,
      totalDevices: 0,
      tenantsWithErrors: 0,
      lastSyncAt: null,
      syncLogsLast24h: 0,
      failedSyncsLast24h: 0,
    };
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    totalDevices,
    syncLogsLast24h,
    failedSyncsLast24h,
    latestSync,
    tenantsWithErrors,
  ] = await Promise.all([
    // Total device count across all tenants
    db.asset.count({
      where: { organizationId: { in: childOrgIds } },
    }),
    // Sync logs in last 24h
    db.syncLog.count({
      where: {
        organizationId: { in: childOrgIds },
        startedAt: { gte: oneDayAgo },
      },
    }),
    // Failed syncs in last 24h
    db.syncLog.count({
      where: {
        organizationId: { in: childOrgIds },
        status: "failed",
        startedAt: { gte: oneDayAgo },
      },
    }),
    // Most recent sync across all tenants
    db.syncLog.findFirst({
      where: { organizationId: { in: childOrgIds } },
      orderBy: { startedAt: "desc" },
      select: { completedAt: true, startedAt: true },
    }),
    // Count tenants with failed syncs in last 24h
    db.syncLog
      .groupBy({
        by: ["organizationId"],
        where: {
          organizationId: { in: childOrgIds },
          status: "failed",
          startedAt: { gte: oneDayAgo },
        },
      })
      .then((groups) => groups.length),
  ]);

  return {
    totalTenants: childOrgIds.length,
    totalDevices,
    tenantsWithErrors,
    lastSyncAt: latestSync?.completedAt ?? latestSync?.startedAt ?? null,
    syncLogsLast24h,
    failedSyncsLast24h,
  };
}

// ─── Navigate to Client Org ─────────────────────────────────────────

/**
 * Verify the MSP admin has access to a specific client org, and
 * ensure they have a UserOrganization membership (lazy add).
 */
export async function ensureMspAdminAccessToClient({
  mspOrgId,
  clientOrgId,
  userId,
}: {
  mspOrgId: string;
  clientOrgId: string;
  userId: string;
}) {
  // Verify OrgRelationship exists
  const rel = await db.orgRelationship.findUnique({
    where: {
      parentOrgId_childOrgId: {
        parentOrgId: mspOrgId,
        childOrgId: clientOrgId,
      },
    },
  });

  if (!rel || !rel.isActive) {
    throw new ShelfError({
      cause: null,
      message: "This client org is not managed by your MSP",
      label,
      status: 403,
    });
  }

  // Ensure user has membership in the client org (lazy add if missing)
  const { data: existing } = await sbDb
    .from("UserOrganization")
    .select("id")
    .eq("userId", userId)
    .eq("organizationId", clientOrgId)
    .single();

  if (!existing) {
    // Get user info for TeamMember
    const { data: user } = await sbDb
      .from("User")
      .select("id, firstName, lastName")
      .eq("id", userId)
      .single();

    // Add MSP admin as ADMIN in the client org
    await sbDb.from("UserOrganization").insert({
      userId,
      organizationId: clientOrgId,
      roles: [OrganizationRoles.ADMIN] as Sb.OrganizationRoles[],
    });

    // Add as TeamMember if not already present
    const { data: existingMember } = await sbDb
      .from("TeamMember")
      .select("id")
      .eq("userId", userId)
      .eq("organizationId", clientOrgId)
      .single();

    if (!existingMember && user) {
      await sbDb.from("TeamMember").insert({
        name: `${user.firstName} ${user.lastName}`,
        userId: user.id,
        organizationId: clientOrgId,
      });
    }
  }

  return rel;
}
