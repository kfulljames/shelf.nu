import { db } from "~/database/db.server";
import type { ErrorLabel } from "~/utils/error";
import { ShelfError } from "~/utils/error";

const label: ErrorLabel = "Integration";

// ─── Location Sync Types ────────────────────────────────────────────

export type ExternalLocation = {
  externalId: string;
  name: string;
  address?: string;
  sourceName: string;
};

// ─── Bidirectional Location Sync ────────────────────────────────────

/**
 * Sync locations from an external source into Shelf.nu.
 * Uses fuzzy name+address matching to detect duplicates.
 * New locations are created; duplicates generate merge proposals.
 */
export async function syncLocationsFromSource({
  organizationId,
  userId,
  locations,
  sourceName,
}: {
  organizationId: string;
  userId: string;
  locations: ExternalLocation[];
  sourceName: string;
}) {
  let created = 0;
  let matched = 0;
  const mergeProposals: string[] = [];

  for (const extLoc of locations) {
    // Try exact name match first
    const existing = await db.location.findFirst({
      where: {
        organizationId,
        name: { equals: extLoc.name, mode: "insensitive" },
      },
      select: { id: true, name: true, address: true },
    });

    if (existing) {
      matched++;
      continue;
    }

    // Fuzzy match: check for similar names (simple containment check)
    const similar = await db.location.findFirst({
      where: {
        organizationId,
        OR: [
          {
            name: {
              contains: extLoc.name.split(" ")[0],
              mode: "insensitive",
            },
          },
          ...(extLoc.address
            ? [
                {
                  address: {
                    contains: extLoc.address.split(",")[0],
                    mode: "insensitive" as const,
                  },
                },
              ]
            : []),
        ],
      },
      select: { id: true, name: true },
    });

    if (similar) {
      // Create a merge proposal instead of duplicating
      const newLoc = await db.location.create({
        data: {
          name: extLoc.name,
          address: extLoc.address,
          userId,
          organizationId,
        },
      });

      await db.locationMergeProposal.create({
        data: {
          organizationId,
          sourceLocationId: newLoc.id,
          targetLocationId: similar.id,
          sourceName,
          similarityScore: 0.7,
          status: "pending",
        },
      });

      mergeProposals.push(newLoc.id);
      created++;
      continue;
    }

    // No match at all — create new location
    await db.location.create({
      data: {
        name: extLoc.name,
        address: extLoc.address,
        userId,
        organizationId,
      },
    });
    created++;
  }

  return { created, matched, mergeProposals: mergeProposals.length };
}

// ─── Location Merge Proposals ───────────────────────────────────────

/**
 * Get pending merge proposals for an organization.
 */
export async function getLocationMergeProposals({
  organizationId,
  status = "pending",
  page = 1,
  perPage = 20,
}: {
  organizationId: string;
  status?: string;
  page?: number;
  perPage?: number;
}) {
  const where = {
    organizationId,
    ...(status !== "ALL" ? { status } : {}),
  };

  const [proposals, total] = await Promise.all([
    db.locationMergeProposal.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.locationMergeProposal.count({ where }),
  ]);

  // Enrich with location names
  const locationIds = [
    ...new Set(
      proposals.flatMap((p) => [p.sourceLocationId, p.targetLocationId])
    ),
  ];

  const locationNames = locationIds.length
    ? await db.location
        .findMany({
          where: { id: { in: locationIds } },
          select: { id: true, name: true, address: true },
        })
        .then((locs) => new Map(locs.map((l) => [l.id, l])))
    : new Map();

  const enriched = proposals.map((p) => ({
    ...p,
    sourceLocation: locationNames.get(p.sourceLocationId) ?? null,
    targetLocation: locationNames.get(p.targetLocationId) ?? null,
  }));

  return { proposals: enriched, total };
}

/**
 * Approve a merge: move all assets from source location to target,
 * then delete the source location.
 */
export async function approveLocationMerge({
  proposalId,
  userId,
}: {
  proposalId: string;
  userId: string;
}) {
  const proposal = await db.locationMergeProposal.findUnique({
    where: { id: proposalId },
  });

  if (!proposal || proposal.status !== "pending") {
    throw new ShelfError({
      cause: null,
      message: "Merge proposal not found or already resolved",
      label,
      status: 404,
    });
  }

  // Move all assets from source to target
  await db.asset.updateMany({
    where: { locationId: proposal.sourceLocationId },
    data: { locationId: proposal.targetLocationId },
  });

  // Move all kits from source to target
  await db.kit.updateMany({
    where: { locationId: proposal.sourceLocationId },
    data: { locationId: proposal.targetLocationId },
  });

  // Delete the source location
  await db.location.delete({
    where: { id: proposal.sourceLocationId },
  });

  // Mark proposal as merged
  await db.locationMergeProposal.update({
    where: { id: proposalId },
    data: {
      status: "merged",
      resolvedBy: userId,
      resolvedAt: new Date(),
    },
  });

  return proposal;
}

/**
 * Reject a merge proposal — keep both locations.
 */
export async function rejectLocationMerge({
  proposalId,
  userId,
}: {
  proposalId: string;
  userId: string;
}) {
  return db.locationMergeProposal.update({
    where: { id: proposalId },
    data: {
      status: "rejected",
      resolvedBy: userId,
      resolvedAt: new Date(),
    },
  });
}

// ─── Location Write-Back ────────────────────────────────────────────

/**
 * Get location data formatted for write-back to external source.
 */
export async function getLocationForWriteBack(locationId: string) {
  const location = await db.location.findUnique({
    where: { id: locationId },
    select: {
      id: true,
      name: true,
      address: true,
      latitude: true,
      longitude: true,
    },
  });

  if (!location) {
    throw new ShelfError({
      cause: null,
      message: "Location not found",
      label,
      status: 404,
    });
  }

  return location;
}
