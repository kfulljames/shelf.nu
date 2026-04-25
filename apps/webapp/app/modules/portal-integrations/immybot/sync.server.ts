import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { listAllComputers, normalizeImmyBotComputer } from "./client.server";
import {
  mapDeviceToAssetBundle,
  type DeviceAssetBundle,
} from "../devices/mapper.server";

export type ImmyBotSyncContext = {
  portalToken: string;
  tenantId: string;
  /** Shelf organization to upsert assets into. */
  organizationId: string;
  /** Shelf user that new assets will be owned by. Typically the user
   * who triggered the sync, or the system user for cron runs. */
  userId: string;
};

export type ImmyBotSyncResult = {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
};

type ExistingLink = {
  id: string;
  assetId: string;
  lockedFields: string[];
  asset: { id: string; title: string; description: string | null };
};

function now(): Date {
  return new Date();
}

/**
 * Apply a single device bundle to the DB. Creates both the Asset and
 * the ExternalAssetLink on first sight, or updates just the fields
 * that aren't locked on subsequent runs.
 *
 * Returns a tag describing what happened so the caller can aggregate.
 */
async function upsertDeviceBundle(
  bundle: DeviceAssetBundle,
  ctx: ImmyBotSyncContext
): Promise<"created" | "updated" | "skipped"> {
  const existing = (await db.externalAssetLink.findUnique({
    where: {
      organizationId_goldenRecordId: {
        organizationId: ctx.organizationId,
        goldenRecordId: bundle.externalLink.goldenRecordId,
      },
    },
    select: {
      id: true,
      assetId: true,
      lockedFields: true,
      asset: { select: { id: true, title: true, description: true } },
    },
  })) as ExistingLink | null;

  if (!existing) {
    await db.$transaction(async (tx) => {
      const asset = await tx.asset.create({
        data: {
          title: bundle.asset.title,
          description: bundle.asset.description,
          userId: ctx.userId,
          organizationId: ctx.organizationId,
        },
        select: { id: true },
      });
      await tx.externalAssetLink.create({
        data: {
          assetId: asset.id,
          organizationId: ctx.organizationId,
          goldenRecordId: bundle.externalLink.goldenRecordId,
          sourceName: bundle.externalLink.sourceName,
          sourceRecordId: bundle.externalLink.sourceRecordId,
          metadata: bundle.externalLink.metadata,
          lastSyncedAt: now(),
          syncStatus: "synced",
        },
      });
    });
    return "created";
  }

  const locked = new Set(existing.lockedFields);
  const assetPatch: { title?: string; description?: string | null } = {};

  if (!locked.has("title") && existing.asset.title !== bundle.asset.title) {
    assetPatch.title = bundle.asset.title;
  }
  if (
    !locked.has("description") &&
    existing.asset.description !== bundle.asset.description
  ) {
    assetPatch.description = bundle.asset.description;
  }

  const hasAssetPatch = Object.keys(assetPatch).length > 0;

  // Metadata refresh is always written. It never surfaces directly to
  // the user and is how we keep sync state in the DB.
  await db.$transaction(async (tx) => {
    if (hasAssetPatch) {
      await tx.asset.update({
        where: { id: existing.asset.id },
        data: assetPatch,
      });
    }
    await tx.externalAssetLink.update({
      where: { id: existing.id },
      data: {
        metadata: bundle.externalLink.metadata,
        lastSyncedAt: now(),
        syncStatus: "synced",
      },
    });
  });

  return hasAssetPatch ? "updated" : "skipped";
}

export async function syncImmyBotDevices(
  ctx: ImmyBotSyncContext
): Promise<ImmyBotSyncResult> {
  const computers = await listAllComputers({
    portalToken: ctx.portalToken,
    tenantId: ctx.tenantId,
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const computer of computers) {
    let bundle: DeviceAssetBundle;
    try {
      bundle = mapDeviceToAssetBundle(normalizeImmyBotComputer(computer));
    } catch (cause) {
      failed += 1;
      Logger.error(
        new ShelfError({
          cause,
          message: "Skipping ImmyBot computer — mapping failed",
          additionalData: {
            organizationId: ctx.organizationId,
            computerId: computer.computerId,
          },
          label: "Integration",
        })
      );
      continue;
    }

    try {
      const outcome = await upsertDeviceBundle(bundle, ctx);
      if (outcome === "created") created += 1;
      else if (outcome === "updated") updated += 1;
      else skipped += 1;
    } catch (cause) {
      failed += 1;
      Logger.error(
        new ShelfError({
          cause,
          message: "Skipping ImmyBot computer — upsert failed",
          additionalData: {
            organizationId: ctx.organizationId,
            computerId: computer.computerId,
            goldenRecordId: bundle.externalLink.goldenRecordId,
          },
          label: "Integration",
        })
      );
    }
  }

  Logger.info(
    `[immybot-sync] org=${ctx.organizationId} fetched=${computers.length} ` +
      `created=${created} updated=${updated} skipped=${skipped} failed=${failed}`
  );

  return {
    fetched: computers.length,
    created,
    updated,
    skipped,
    failed,
  };
}
