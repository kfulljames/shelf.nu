import type { Prisma } from "@prisma/client";
import { data } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
// KEEP AS PRISMA: db.asset.findFirst and db.qr.findUniqueOrThrow use dynamic
// Prisma include objects (assetExtraInclude / kitExtraInclude) that cannot be
// expressed with Supabase's select string syntax.
import { db } from "~/database/db.server";
import { sbDb } from "~/database/supabase.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import {
  payload,
  error,
  getCurrentSearchParams,
  getParams,
  parseData,
} from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import type {
  AssetFromScanner,
  KitFromScanner,
} from "~/utils/scanner-includes.server";
import {
  ASSET_INCLUDE,
  KIT_INCLUDE,
  QR_INCLUDE,
} from "~/utils/scanner-includes.server";
import { parseSequentialId } from "~/utils/sequential-id";

// Re-export types for backward compatibility
export type AssetFromQr = AssetFromScanner;
export type KitFromQr = KitFromScanner;

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const searchParams = getCurrentSearchParams(request);

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.qr,
      action: PermissionAction.read,
    });

    const { qrId } = getParams(params, z.object({ qrId: z.string() }), {
      additionalData: {
        userId,
      },
    });

    const { assetExtraInclude, kitExtraInclude, auditSessionId } = parseData(
      searchParams,
      z.object({
        assetExtraInclude: z
          .string()
          .optional()
          .transform((val) => {
            if (!val) return undefined;
            try {
              return JSON.parse(val);
            } catch (_error) {
              throw new Error("Invalid JSON input for assetExtraInclude");
            }
          }),
        kitExtraInclude: z
          .string()
          .optional()
          .transform((val) => {
            if (!val) return undefined;
            try {
              return JSON.parse(val);
            } catch (_error) {
              throw new Error("Invalid JSON input for kitExtraInclude");
            }
          }),
        auditSessionId: z.string().optional(),
      })
    ) as {
      assetExtraInclude: Prisma.AssetInclude | undefined;
      kitExtraInclude: Prisma.KitInclude | undefined;
      auditSessionId?: string;
    };

    const assetInclude: Prisma.AssetInclude = {
      ...ASSET_INCLUDE,
      ...(assetExtraInclude ?? {}),
    };

    const kitInclude: Prisma.KitInclude = {
      ...KIT_INCLUDE,
      ...(kitExtraInclude ?? {}),
    };

    const sequentialId = parseSequentialId(qrId);

    if (sequentialId) {
      const asset = await db.asset.findFirst({
        where: {
          organizationId,
          sequentialId,
        },
        include: assetInclude,
      });

      if (!asset) {
        throw new ShelfError({
          cause: null,
          message:
            "This SAM ID doesn't exist or it doesn't belong to your current organization.",
          title: "SAM ID not found",
          additionalData: { sequentialId, shouldSendNotification: false },
          label: "Scan",
          shouldBeCaptured: false,
        });
      }

      // If audit session ID provided, fetch the auditAssetId and counts
      let auditAssetId: string | undefined;
      let auditNotesCount = 0;
      let auditImagesCount = 0;
      if (auditSessionId && asset.id) {
        const { data: auditAsset, error: auditAssetError } = await sbDb
          .from("AuditAsset")
          .select("id")
          .eq("auditSessionId", auditSessionId)
          .eq("assetId", asset.id)
          .maybeSingle();

        if (auditAssetError) {
          throw new ShelfError({
            cause: auditAssetError,
            message: "Failed to fetch audit asset",
            label: "Scan",
          });
        }

        auditAssetId = auditAsset?.id;
        if (auditAssetId) {
          const [notesResult, imagesResult] = await Promise.all([
            sbDb
              .from("AuditNote")
              .select("*", { count: "exact", head: true })
              .eq("auditSessionId", auditSessionId)
              .eq("auditAssetId", auditAssetId),
            sbDb
              .from("AuditImage")
              .select("*", { count: "exact", head: true })
              .eq("auditSessionId", auditSessionId)
              .eq("auditAssetId", auditAssetId),
          ]);

          if (notesResult.error) {
            throw new ShelfError({
              cause: notesResult.error,
              message: "Failed to count audit notes",
              label: "Scan",
            });
          }
          if (imagesResult.error) {
            throw new ShelfError({
              cause: imagesResult.error,
              message: "Failed to count audit images",
              label: "Scan",
            });
          }

          auditNotesCount = notesResult.count ?? 0;
          auditImagesCount = imagesResult.count ?? 0;
        }
      }

      return data(
        payload({
          qr: {
            type: "asset" as const,
            asset: {
              ...asset,
              auditAssetId,
              auditNotesCount,
              auditImagesCount,
            },
          },
        })
      );
    }

    const include = {
      ...QR_INCLUDE,
      asset: { include: assetInclude },
      kit: { include: kitInclude },
    };

    const qr = await db.qr.findUniqueOrThrow({
      where: { id: qrId },
      include,
    });

    if (qr.organizationId !== organizationId) {
      throw new ShelfError({
        cause: null,
        message:
          "This code doesn't exist or it doesn't belong to your current organization.",
        additionalData: { qrId, shouldSendNotification: false },
        label: "QR",
        shouldBeCaptured: false,
      });
    }

    if (!qr.assetId && !qr.kitId) {
      throw new ShelfError({
        cause: null,
        message: "QR code is not linked to any asset or kit",
        additionalData: { qrId, shouldSendNotification: false },
        shouldBeCaptured: false,
        label: "QR",
      });
    }

    // If audit session ID provided, fetch the auditAssetId and counts
    let auditAssetId: string | undefined;
    let auditNotesCount = 0;
    let auditImagesCount = 0;
    if (auditSessionId && qr.asset?.id) {
      const { data: auditAsset, error: auditAssetError } = await sbDb
        .from("AuditAsset")
        .select("id")
        .eq("auditSessionId", auditSessionId)
        .eq("assetId", qr.asset.id)
        .maybeSingle();

      if (auditAssetError) {
        throw new ShelfError({
          cause: auditAssetError,
          message: "Failed to fetch audit asset",
          label: "QR",
        });
      }

      auditAssetId = auditAsset?.id;
      if (auditAssetId) {
        const [notesResult, imagesResult] = await Promise.all([
          sbDb
            .from("AuditNote")
            .select("*", { count: "exact", head: true })
            .eq("auditSessionId", auditSessionId)
            .eq("auditAssetId", auditAssetId),
          sbDb
            .from("AuditImage")
            .select("*", { count: "exact", head: true })
            .eq("auditSessionId", auditSessionId)
            .eq("auditAssetId", auditAssetId),
        ]);

        if (notesResult.error) {
          throw new ShelfError({
            cause: notesResult.error,
            message: "Failed to count audit notes",
            label: "QR",
          });
        }
        if (imagesResult.error) {
          throw new ShelfError({
            cause: imagesResult.error,
            message: "Failed to count audit images",
            label: "QR",
          });
        }

        auditNotesCount = notesResult.count ?? 0;
        auditImagesCount = imagesResult.count ?? 0;
      }
    }

    return data(
      payload({
        qr: {
          ...qr,
          type: qr.asset ? "asset" : qr.kit ? "kit" : undefined,
          asset: qr.asset
            ? {
                ...qr.asset,
                auditAssetId,
                auditNotesCount,
                auditImagesCount,
              }
            : undefined,
        },
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    const sendNotification = reason.additionalData?.shouldSendNotification;
    const shouldSendNotification =
      typeof sendNotification === "boolean" && sendNotification;

    return data(error(reason, shouldSendNotification), {
      status: reason.status,
    });
  }
}
