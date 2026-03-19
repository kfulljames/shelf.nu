import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";

/**
 * Get locked fields for an asset via its ExternalAssetLink.
 * Returns null if the asset has no external link (not synced).
 */
export async function getLockedFieldsForAsset(assetId: string) {
  const link = await db.externalAssetLink.findFirst({
    where: { assetId },
    select: {
      lockedFields: true,
      sourceName: true,
      goldenRecordId: true,
      syncStatus: true,
      lastSyncedAt: true,
    },
  });

  return link;
}

/**
 * Enforce field locking on an asset update.
 *
 * Call this before applying changes to a synced asset.
 * Throws if any of the fields being updated are locked.
 *
 * @param assetId - The asset being updated
 * @param fieldsBeingUpdated - Array of field names the user is trying to change
 * @returns The external link if found, or null
 */
export async function enforceFieldLocking(
  assetId: string,
  fieldsBeingUpdated: string[]
) {
  const link = await getLockedFieldsForAsset(assetId);

  if (!link) return null;

  const violatedFields = fieldsBeingUpdated.filter((f) =>
    link.lockedFields.includes(f)
  );

  if (violatedFields.length > 0) {
    throw new ShelfError({
      cause: null,
      message:
        `The following fields are managed by ${link.sourceName} ` +
        `and cannot be edited: ${violatedFields.join(", ")}`,
      label: "Integration",
      status: 403,
      shouldBeCaptured: false,
      additionalData: {
        assetId,
        lockedFields: violatedFields,
        sourceName: link.sourceName,
      },
    });
  }

  return link;
}
