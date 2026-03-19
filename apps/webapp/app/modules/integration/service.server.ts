import type { Organization } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "~/database/db.server";
import type { ErrorLabel } from "~/utils/error";
import { ShelfError } from "~/utils/error";
import type {
  GoldenRecord,
  IngestionRecordResult,
  IngestionResponse,
} from "./types";

const label: ErrorLabel = "Integration";

// ─── API Key Auth ────────────────────────────────────────────────────

/**
 * Validate an inbound API key against hashed keys stored in
 * IntegrationSource. Returns the matching source + org if valid.
 */
export async function authenticateApiKey(apiKey: string) {
  try {
    // We store a SHA-256 hex hash of the API key.
    // Hash the incoming key and look it up.
    const hash = await hashApiKey(apiKey);

    const source = await db.integrationSource.findFirst({
      where: { apiKeyHash: hash, isActive: true },
      include: { organization: { select: { id: true, name: true } } },
    });

    if (!source) {
      throw new ShelfError({
        cause: null,
        message: "Invalid or inactive API key",
        label,
        status: 401,
        shouldBeCaptured: false,
      });
    }

    return source;
  } catch (cause) {
    if (cause instanceof ShelfError) throw cause;
    throw new ShelfError({
      cause,
      message: "Failed to authenticate API key",
      label,
      status: 401,
    });
  }
}

/**
 * Hash an API key with SHA-256 (hex). Used for storage and lookup.
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Sync Log ────────────────────────────────────────────────────────

async function createSyncLog(
  integrationSourceId: string,
  organizationId: string
) {
  return db.syncLog.create({
    data: {
      integrationSourceId,
      organizationId,
      status: "running",
    },
  });
}

async function completeSyncLog(
  syncLogId: string,
  summary: IngestionResponse["summary"],
  startTime: Date
) {
  const status = summary.failed > 0 ? "partial" : "success";
  await db.syncLog.update({
    where: { id: syncLogId },
    data: {
      status,
      recordsCreated: summary.created,
      recordsUpdated: summary.updated,
      recordsFailed: summary.failed,
      duration: Date.now() - startTime.getTime(),
      completedAt: new Date(),
    },
  });
}

export async function failSyncLog(syncLogId: string, error: string) {
  await db.syncLog.update({
    where: { id: syncLogId },
    data: {
      status: "failed",
      errors: [{ message: error }],
      completedAt: new Date(),
    },
  });
}

// ─── Golden Record Ingestion ─────────────────────────────────────────

/**
 * Process a batch of golden records for an organization.
 *
 * For each record:
 * 1. Match by goldenRecordId (ExternalAssetLink)
 * 2. If no match → create asset + link
 * 3. If match → update changed fields
 * 4. Log to IntegrationAuditLog
 */
export async function ingestGoldenRecords({
  organizationId,
  integrationSourceId,
  userId,
  records,
}: {
  organizationId: string;
  integrationSourceId: string;
  userId: string;
  records: GoldenRecord[];
}): Promise<IngestionResponse> {
  const startTime = new Date();
  const syncLog = await createSyncLog(integrationSourceId, organizationId);

  const results: IngestionRecordResult[] = [];
  const summary = { created: 0, updated: 0, failed: 0 };

  for (const record of records) {
    try {
      const result = await processGoldenRecord({
        organizationId,
        userId,
        record,
      });
      results.push(result);
      if (result.status === "created") summary.created++;
      if (result.status === "updated") summary.updated++;
    } catch (cause) {
      summary.failed++;
      results.push({
        goldenRecordId: record.goldenRecordId,
        assetId: null,
        status: "failed",
        error: cause instanceof Error ? cause.message : "Unknown error",
      });
    }
  }

  // Update the sync log and integration source timestamp
  await Promise.all([
    completeSyncLog(syncLog.id, summary, startTime),
    db.integrationSource.update({
      where: { id: integrationSourceId },
      data: { lastSyncAt: new Date() },
    }),
  ]);

  return { syncLogId: syncLog.id, results, summary };
}

/**
 * Process a single golden record: create or update.
 */
async function processGoldenRecord({
  organizationId,
  userId,
  record,
}: {
  organizationId: string;
  userId: string;
  record: GoldenRecord;
}): Promise<IngestionRecordResult> {
  // Check if we already have a link for this golden record
  const existingLink = await db.externalAssetLink.findUnique({
    where: {
      organizationId_goldenRecordId: {
        organizationId,
        goldenRecordId: record.goldenRecordId,
      },
    },
    include: { asset: true },
  });

  if (existingLink) {
    return updateExistingAsset({
      organizationId,
      existingLink,
      record,
    });
  }

  return createNewAsset({ organizationId, userId, record });
}

/**
 * Create a new asset from a golden record.
 */
async function createNewAsset({
  organizationId,
  userId,
  record,
}: {
  organizationId: string;
  userId: string;
  record: GoldenRecord;
}): Promise<IngestionRecordResult> {
  // Resolve category if provided
  let categoryId: string | undefined;
  if (record.categoryName) {
    categoryId = await resolveCategory(
      organizationId,
      userId,
      record.categoryName
    );
  }

  // Resolve location if provided
  let locationId: string | undefined;
  if (record.locationName) {
    locationId = await resolveLocation(
      organizationId,
      userId,
      record.locationName
    );
  }

  const result = await db.$transaction(async (tx) => {
    // Create the asset
    const asset = await tx.asset.create({
      data: {
        title: record.title,
        description: record.description,
        organizationId,
        userId,
        categoryId,
        locationId,
      },
    });

    // Create the external link
    await tx.externalAssetLink.create({
      data: {
        assetId: asset.id,
        organizationId,
        goldenRecordId: record.goldenRecordId,
        sourceName: record.sourceName,
        sourceRecordId: record.sourceRecordId,
        lockedFields: record.lockedFields ?? ["title", "description"],
        metadata: record.metadata
          ? (record.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        lastSyncedAt: new Date(),
        syncStatus: "synced",
      },
    });

    // Audit log
    await tx.integrationAuditLog.create({
      data: {
        organizationId,
        assetId: asset.id,
        action: "sync_create",
        source: "assetmesh",
        metadata: {
          goldenRecordId: record.goldenRecordId,
          sourceName: record.sourceName,
        } as Prisma.InputJsonValue,
      },
    });

    return asset;
  });

  return {
    goldenRecordId: record.goldenRecordId,
    assetId: result.id,
    status: "created",
  };
}

/**
 * Update an existing asset from a golden record.
 */
async function updateExistingAsset({
  organizationId,
  existingLink,
  record,
}: {
  organizationId: string;
  existingLink: {
    id: string;
    assetId: string;
    lockedFields: string[];
    asset: { id: string; title: string; description: string | null };
  };
  record: GoldenRecord;
}): Promise<IngestionRecordResult> {
  const fieldChanges: Record<
    string,
    { old: string | null; new: string | null }
  > = {};

  // Detect changes
  if (record.title !== existingLink.asset.title) {
    fieldChanges["title"] = {
      old: existingLink.asset.title,
      new: record.title,
    };
  }
  if (
    record.description !== undefined &&
    record.description !== existingLink.asset.description
  ) {
    fieldChanges["description"] = {
      old: existingLink.asset.description,
      new: record.description ?? null,
    };
  }

  const hasChanges = Object.keys(fieldChanges).length > 0;

  if (!hasChanges) {
    // Still update the sync timestamp
    await db.externalAssetLink.update({
      where: { id: existingLink.id },
      data: { lastSyncedAt: new Date(), syncStatus: "synced" },
    });

    return {
      goldenRecordId: record.goldenRecordId,
      assetId: existingLink.assetId,
      status: "updated",
    };
  }

  await db.$transaction(async (tx) => {
    // Update the asset
    const updateData: Prisma.AssetUpdateInput = {};
    if (fieldChanges["title"]) updateData.title = record.title;
    if (fieldChanges["description"])
      updateData.description = record.description;

    await tx.asset.update({
      where: { id: existingLink.assetId },
      data: updateData,
    });

    // Update the external link
    await tx.externalAssetLink.update({
      where: { id: existingLink.id },
      data: {
        lockedFields: record.lockedFields ??
          existingLink.lockedFields ?? ["title", "description"],
        metadata: record.metadata
          ? (record.metadata as Prisma.InputJsonValue)
          : undefined,
        lastSyncedAt: new Date(),
        syncStatus: "synced",
      },
    });

    // Audit log
    await tx.integrationAuditLog.create({
      data: {
        organizationId,
        assetId: existingLink.assetId,
        action: "sync_update",
        source: "assetmesh",
        fieldChanges: fieldChanges as unknown as Prisma.InputJsonValue,
        metadata: {
          goldenRecordId: record.goldenRecordId,
          sourceName: record.sourceName,
        } as Prisma.InputJsonValue,
      },
    });
  });

  return {
    goldenRecordId: record.goldenRecordId,
    assetId: existingLink.assetId,
    status: "updated",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Find or create a category by name within an organization.
 */
async function resolveCategory(
  organizationId: string,
  userId: string,
  categoryName: string
): Promise<string> {
  const existing = await db.category.findFirst({
    where: {
      organizationId,
      name: { equals: categoryName, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (existing) return existing.id;

  const created = await db.category.create({
    data: {
      name: categoryName,
      color: "#808080", // default gray
      organizationId,
      userId,
    },
  });

  return created.id;
}

/**
 * Find or create a location by name within an organization.
 */
async function resolveLocation(
  organizationId: string,
  userId: string,
  locationName: string
): Promise<string> {
  const existing = await db.location.findFirst({
    where: {
      organizationId,
      name: { equals: locationName, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (existing) return existing.id;

  const created = await db.location.create({
    data: {
      name: locationName,
      organizationId,
      userId,
    },
  });

  return created.id;
}

// ─── External Asset Link Queries ─────────────────────────────────────

/**
 * Get the external link for an asset (if any).
 * Used by the UI to show lock icons and source badges.
 */
export async function getExternalAssetLink(assetId: string) {
  return db.externalAssetLink.findFirst({
    where: { assetId },
  });
}

/**
 * Check if a specific field is locked on an asset.
 */
export async function isFieldLocked(
  assetId: string,
  fieldName: string
): Promise<boolean> {
  const link = await db.externalAssetLink.findFirst({
    where: { assetId },
    select: { lockedFields: true },
  });

  if (!link) return false;
  return link.lockedFields.includes(fieldName);
}

// ─── Write-Back Queue ────────────────────────────────────────────────

/**
 * Enqueue a write-back job when a user edits a synced asset field.
 */
export async function enqueueWriteBack({
  organizationId,
  assetId,
  goldenRecordId,
  fieldChanges,
  userId,
}: {
  organizationId: string;
  assetId: string;
  goldenRecordId: string;
  fieldChanges: Record<string, { old: string | null; new: string | null }>;
  userId: string;
}) {
  return db.writeBackQueue.create({
    data: {
      organizationId,
      assetId,
      goldenRecordId,
      fieldChanges: fieldChanges as unknown as Prisma.InputJsonValue,
      createdBy: userId,
    },
  });
}

// ─── Sync Log Queries ────────────────────────────────────────────────

/**
 * Get recent sync logs for an organization (for MSP dashboard).
 */
export async function getSyncLogs({
  organizationId,
  take = 20,
}: {
  organizationId: Organization["id"];
  take?: number;
}) {
  return db.syncLog.findMany({
    where: { organizationId },
    orderBy: { startedAt: "desc" },
    take,
    include: {
      integrationSource: {
        select: { name: true, displayName: true },
      },
    },
  });
}
