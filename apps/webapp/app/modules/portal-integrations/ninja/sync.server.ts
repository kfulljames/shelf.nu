import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { listAllDevices, normalizeNinjaDevice } from "./client.server";
import {
  mapDeviceToAssetBundle,
  type DeviceAssetBundle,
} from "../devices/mapper.server";

export type NinjaSyncContext = {
  portalToken: string;
  tenantId: string;
  organizationId: string;
  userId: string;
};

export type NinjaSyncResult = {
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

async function upsertDeviceBundle(
  bundle: DeviceAssetBundle,
  ctx: NinjaSyncContext
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

export async function syncNinjaDevices(
  ctx: NinjaSyncContext
): Promise<NinjaSyncResult> {
  const devices = await listAllDevices({
    portalToken: ctx.portalToken,
    tenantId: ctx.tenantId,
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const device of devices) {
    let bundle: DeviceAssetBundle;
    try {
      bundle = mapDeviceToAssetBundle(normalizeNinjaDevice(device));
    } catch (cause) {
      failed += 1;
      Logger.error(
        new ShelfError({
          cause,
          message: "Skipping NinjaRMM device — mapping failed",
          additionalData: {
            organizationId: ctx.organizationId,
            deviceId: device.id,
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
          message: "Skipping NinjaRMM device — upsert failed",
          additionalData: {
            organizationId: ctx.organizationId,
            deviceId: device.id,
            goldenRecordId: bundle.externalLink.goldenRecordId,
          },
          label: "Integration",
        })
      );
    }
  }

  Logger.info(
    `[ninja-sync] org=${ctx.organizationId} fetched=${devices.length} ` +
      `created=${created} updated=${updated} skipped=${skipped} failed=${failed}`
  );

  return {
    fetched: devices.length,
    created,
    updated,
    skipped,
    failed,
  };
}
