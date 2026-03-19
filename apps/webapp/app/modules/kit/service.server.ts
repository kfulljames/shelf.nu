import type {
  Asset,
  Barcode,
  Booking,
  Kit,
  Organization,
  Prisma,
  Qr,
  TeamMember,
  User,
  UserOrganization,
} from "@prisma/client";
import {
  AssetStatus,
  BookingStatus,
  ErrorCorrection,
  KitStatus,
  NoteType,
} from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import invariant from "tiny-invariant";
import { db } from "~/database/db.server";
import { sbDb } from "~/database/supabase.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import type { AssetIndexSettingsRow } from "~/modules/asset-index-settings/service.server";
import {
  updateBarcodes,
  validateBarcodeUniqueness,
} from "~/modules/barcode/service.server";
import { ASSET_MAX_IMAGE_UPLOAD_SIZE } from "~/utils/constants";
import { updateCookieWithPerPage } from "~/utils/cookies.server";
import { dateTimeInUnix } from "~/utils/date-time-in-unix";
import type { ErrorLabel } from "~/utils/error";
import {
  isLikeShelfError,
  isNotFoundError,
  maybeUniqueConstraintViolation,
  ShelfError,
  VALIDATION_ERROR,
} from "~/utils/error";
import { extractImageNameFromSupabaseUrl } from "~/utils/extract-image-name-from-supabase-url";
import { getRedirectUrlFromRequest } from "~/utils/http";
import { getCurrentSearchParams } from "~/utils/http.server";
import { id } from "~/utils/id/id.server";
import { ALL_SELECTED_KEY, getParamsValues } from "~/utils/list";
import { Logger } from "~/utils/logger";
import {
  wrapCustodianForNote,
  wrapKitsWithDataForNote,
  wrapLinkForNote,
  wrapUserLinkForNote,
} from "~/utils/markdoc-wrappers";
import { oneDayFromNow } from "~/utils/one-week-from-now";
import { createSignedUrl, parseFileFormData } from "~/utils/storage.server";
import type { MergeInclude } from "~/utils/utils";
import type { UpdateKitPayload } from "./types";
import {
  GET_KIT_STATIC_INCLUDES,
  KIT_SELECT_FIELDS_FOR_LIST_ITEMS,
  KITS_INCLUDE_FIELDS,
} from "./types";
import { resolveAssetIdsForBulkOperation } from "../asset/bulk-operations-helper.server";
import type { CreateAssetFromContentImportPayload } from "../asset/types";
import {
  getFilteredAssetIds,
  getKitLocationUpdateNoteContent,
} from "../asset/utils.server";
import { createSystemLocationNote } from "../location-note/service.server";
import {
  createBulkKitChangeNotes,
  createNote,
  createNotes,
} from "../note/service.server";
import { getQr } from "../qr/service.server";
import { getUserByID } from "../user/service.server";

const label: ErrorLabel = "Kit";

/**
 * Applies kit filters to a Supabase query builder, mirroring what
 * getKitsWhereInput does for Prisma.  Works for both the "select all"
 * path (search-param-based filters) and the "specific IDs" path.
 */
async function resolveKitIdsForBulk({
  kitIds,
  organizationId,
  currentSearchParams,
  selectColumns = "id",
}: {
  kitIds: Kit["id"][];
  organizationId: Kit["organizationId"];
  currentSearchParams?: string | null;
  selectColumns?: string;
}): Promise<Array<Record<string, any>>> {
  const isSelectAll = kitIds.includes(ALL_SELECTED_KEY);

  if (!isSelectAll) {
    const { data, error } = await sbDb
      .from("Kit")
      .select(selectColumns)
      .in("id", kitIds)
      .eq("organizationId", organizationId);
    if (error) throw error;
    return data ?? [];
  }

  // Build Supabase query from search params (mirrors getKitsWhereInput)
  let query = sbDb
    .from("Kit")
    .select(selectColumns)
    .eq("organizationId", organizationId);

  if (currentSearchParams) {
    const searchParams = new URLSearchParams(currentSearchParams);
    const search = searchParams.get("s");
    const status =
      searchParams.get("status") === "ALL" ? null : searchParams.get("status");
    const teamMember = searchParams.get("teamMember");

    if (search) {
      query = query.ilike("name", `%${search.toLowerCase().trim()}%`);
    }
    if (status) {
      query = query.eq("status", status as KitStatus);
    }
    if (teamMember) {
      // custody.custodianId filter requires a subquery:
      // find kit IDs that have a KitCustody row with this custodianId
      const { data: custodyRows } = await sbDb
        .from("KitCustody")
        .select("kitId")
        .eq("custodianId", teamMember);
      const custodyKitIds = (custodyRows ?? []).map((r) => r.kitId);
      if (custodyKitIds.length === 0) return [];
      query = query.in("id", custodyKitIds);
    }
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function createKit({
  name,
  description,
  createdById,
  organizationId,
  qrId,
  categoryId,
  locationId,
  barcodes,
}: Pick<
  Kit,
  | "name"
  | "description"
  | "createdById"
  | "organizationId"
  | "categoryId"
  | "locationId"
> & {
  qrId?: Qr["id"];
  barcodes?: Pick<Barcode, "type" | "value">[];
}) {
  try {
    /**
     * If a qr code is passed, link to that QR
     * Otherwise, create a new one
     * Here we also need to double check:
     * 1. If the qr code exists
     * 2. If the qr code belongs to the current organization
     * 3. If the qr code is not linked to an asset
     */
    const qr = qrId ? await getQr({ id: qrId }) : null;
    const shouldConnectExistingQr =
      qr &&
      qr.organizationId === organizationId &&
      qr.assetId === null &&
      qr.kitId === null;

    const kitId = id();

    /** Insert the kit with flat FKs */
    const { data: newKit, error: kitError } = await sbDb
      .from("Kit")
      .insert({
        id: kitId,
        name,
        description: description ?? null,
        createdById,
        organizationId: organizationId as string,
        categoryId: categoryId ?? null,
        locationId: locationId ?? null,
      })
      .select("*")
      .single();

    if (kitError) throw kitError;

    /** Handle QR code: connect existing or create new */
    if (shouldConnectExistingQr) {
      const { error: qrConnectError } = await sbDb
        .from("Qr")
        .update({ kitId })
        .eq("id", qrId!);
      if (qrConnectError) throw qrConnectError;
    } else {
      const { error: qrCreateError } = await sbDb.from("Qr").insert({
        id: id(),
        version: 0,
        errorCorrection: ErrorCorrection["L"],
        userId: createdById,
        organizationId: organizationId as string,
        kitId,
      });
      if (qrCreateError) throw qrCreateError;
    }

    /** If barcodes are passed, create them */
    if (barcodes && barcodes.length > 0) {
      const barcodesToAdd = barcodes.filter(
        (barcode) => !!barcode.value && !!barcode.type
      );

      if (barcodesToAdd.length > 0) {
        const { error: barcodeError } = await sbDb.from("Barcode").insert(
          barcodesToAdd.map(({ type, value }) => ({
            id: id(),
            type,
            value: value.toUpperCase(),
            organizationId,
            kitId,
          }))
        );
        if (barcodeError) throw barcodeError;
      }
    }

    return {
      ...newKit,
      createdAt: new Date(newKit.createdAt),
      updatedAt: new Date(newKit.updatedAt),
      imageExpiration: newKit.imageExpiration
        ? new Date(newKit.imageExpiration)
        : null,
    } as Kit;
  } catch (cause) {
    // If it's a unique constraint violation on barcode values,
    // use our detailed validation to provide specific field errors
    const isUniqueViolation =
      cause instanceof Error &&
      (("code" in cause && cause.code === "P2002") ||
        ("code" in cause && cause.code === "23505"));
    if (isUniqueViolation) {
      if (barcodes && barcodes.length > 0) {
        const barcodesToAdd = barcodes.filter(
          (barcode) => !!barcode.value && !!barcode.type
        );
        if (barcodesToAdd.length > 0) {
          // Use existing validation function for detailed error messages
          await validateBarcodeUniqueness(barcodesToAdd, organizationId);
        }
      }
    }

    throw maybeUniqueConstraintViolation(cause, "Kit", {
      additionalData: { userId: createdById, organizationId },
    });
  }
}

export async function updateKit({
  id,
  name,
  description,
  image,
  imageExpiration,
  status,
  createdById,
  organizationId,
  categoryId,
  barcodes,
  locationId,
}: UpdateKitPayload) {
  try {
    const updateData: Record<string, unknown> = {
      name,
      description,
      image,
      status,
    };

    if (imageExpiration !== undefined) {
      updateData.imageExpiration = imageExpiration
        ? imageExpiration instanceof Date
          ? imageExpiration.toISOString()
          : imageExpiration
        : null;
    }

    /** If uncategorized is passed, disconnect the category */
    if (categoryId === "uncategorized") {
      updateData.categoryId = null;
    }

    // If category id is passed and is different than uncategorized, connect the category
    if (categoryId && categoryId !== "uncategorized") {
      updateData.categoryId = categoryId;
    }

    if (locationId) {
      updateData.locationId = locationId;
    }

    // Remove undefined values so we don't overwrite with null
    for (const key of Object.keys(updateData)) {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    }

    const { data: kit, error: kitError } = await sbDb
      .from("Kit")
      .update(updateData)
      .eq("id", id)
      .eq("organizationId", organizationId)
      .select("*")
      .single();

    if (kitError) throw kitError;

    /** If barcodes are passed, update existing barcodes efficiently */
    if (barcodes !== undefined) {
      await updateBarcodes({
        barcodes,
        kitId: id,
        organizationId,
        userId: createdById,
      });
    }

    return {
      ...kit,
      createdAt: new Date(kit.createdAt),
      updatedAt: new Date(kit.updatedAt),
      imageExpiration: kit.imageExpiration
        ? new Date(kit.imageExpiration)
        : null,
    } as Kit;
  } catch (cause) {
    // If it's already a ShelfError with validation errors, re-throw as is
    if (
      cause instanceof ShelfError &&
      cause.additionalData?.[VALIDATION_ERROR]
    ) {
      throw cause;
    }

    throw maybeUniqueConstraintViolation(cause, "Kit", {
      additionalData: { userId: createdById, id },
    });
  }
}

export async function updateKitImage({
  request,
  kitId,
  userId,
  organizationId,
}: {
  request: Request;
  kitId: string;
  userId: string;
  organizationId: Kit["organizationId"];
}) {
  try {
    const fileData = await parseFileFormData({
      request,
      bucketName: "kits",
      newFileName: `${userId}/${kitId}/image-${dateTimeInUnix(Date.now())}`,
      resizeOptions: {
        width: 800,
        withoutEnlargement: true,
      },
      maxFileSize: ASSET_MAX_IMAGE_UPLOAD_SIZE,
    });

    const image = fileData.get("image") as string;
    if (!image) return;

    const signedUrl = await createSignedUrl({
      filename: image,
      bucketName: "kits",
    });

    await updateKit({
      id: kitId,
      image: signedUrl,
      imageExpiration: oneDayFromNow(),
      createdById: userId,
      organizationId,
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: isLikeShelfError(cause)
        ? cause.message
        : "Something went wrong while updating image for kit.",
      additionalData: { kitId, userId, field: "image" },
      label,
    });
  }
}

export async function getPaginatedAndFilterableKits<
  T extends Prisma.KitInclude,
>({
  request,
  organizationId,
  extraInclude,
  currentBookingId,
}: {
  request: LoaderFunctionArgs["request"];
  organizationId: Organization["id"];
  extraInclude?: T;
  currentBookingId?: Booking["id"];
}) {
  function hasAssetsIncluded(
    extraInclude?: Prisma.KitInclude
  ): extraInclude is Prisma.KitInclude & { assets: boolean } {
    return !!extraInclude?.assets;
  }

  const searchParams = getCurrentSearchParams(request);
  const paramsValues = getParamsValues(searchParams);

  const status =
    searchParams.get("status") === "ALL"
      ? null
      : (searchParams.get("status") as KitStatus | null);
  const teamMember = searchParams.get("teamMember"); // custodian

  const {
    page,
    perPageParam,
    search,
    hideUnavailable,
    bookingFrom,
    bookingTo,
  } = paramsValues;

  const cookie = await updateCookieWithPerPage(request, perPageParam);
  const { perPage } = cookie;

  try {
    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = perPage >= 1 && perPage <= 100 ? perPage : 200;

    const where: Prisma.KitWhereInput = { organizationId };

    if (search) {
      const searchTerm = search.toLowerCase().trim();
      where.OR = [
        // Search in kit name
        { name: { contains: searchTerm, mode: "insensitive" } },
        // Search in barcode values
        {
          barcodes: {
            some: { value: { contains: searchTerm, mode: "insensitive" } },
          },
        },
      ];
    }

    if (status) {
      where.status = status;
    }

    if (teamMember) {
      Object.assign(where, {
        custody: { custodianId: teamMember },
      });
    }

    if (currentBookingId && hideUnavailable) {
      // Basic filters that apply to all kits
      where.assets = {
        every: {
          organizationId,
          custody: null,
        },
      };

      if (bookingFrom && bookingTo) {
        // Apply booking conflict logic similar to assets, but through kit assets
        const kitWhere: Prisma.KitWhereInput[] = [
          // Rule 1: RESERVED bookings always exclude kits (if any asset is in a RESERVED booking)
          {
            assets: {
              none: {
                bookings: {
                  some: {
                    id: { not: currentBookingId },
                    status: BookingStatus.RESERVED,
                    OR: [
                      { from: { lte: bookingTo }, to: { gte: bookingFrom } },
                      { from: { gte: bookingFrom }, to: { lte: bookingTo } },
                    ],
                  },
                },
              },
            },
          },
          // Rule 2: For ONGOING/OVERDUE bookings, allow kits that are AVAILABLE or have no conflicting assets
          {
            OR: [
              // Either kit is AVAILABLE (checked in from partial check-in)
              { status: KitStatus.AVAILABLE },
              // Or kit has no assets in conflicting ONGOING/OVERDUE bookings
              {
                assets: {
                  none: {
                    bookings: {
                      some: {
                        id: { not: currentBookingId },
                        status: {
                          in: [BookingStatus.ONGOING, BookingStatus.OVERDUE],
                        },
                        OR: [
                          {
                            from: { lte: bookingTo },
                            to: { gte: bookingFrom },
                          },
                          {
                            from: { gte: bookingFrom },
                            to: { lte: bookingTo },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            ],
          },
        ];

        // Combine the basic filters with booking conflict filters
        where.AND = kitWhere;
      }
    }

    if (
      currentBookingId &&
      hideUnavailable === true &&
      (!bookingFrom || !bookingTo)
    ) {
      throw new ShelfError({
        cause: null,
        message: "Booking dates are needed to hide unavailable kit.",
        additionalData: { hideUnavailable, bookingFrom, bookingTo },
        label,
      });
    }

    const include = {
      ...extraInclude,
      ...KITS_INCLUDE_FIELDS,
    } as MergeInclude<typeof KITS_INCLUDE_FIELDS, T>;

    // KEPT AS PRISMA: Dynamic generic include + complex where with
    // nested booking/custody relations + `assets: { none: {} }` filter
    let [kits, totalKits, totalKitsWithoutAssets] = await Promise.all([
      db.kit.findMany({
        skip,
        take,
        where,
        include,
        orderBy: { createdAt: "desc" },
      }),
      db.kit.count({ where }),
      db.kit.count({ where: { organizationId, assets: { none: {} } } }),
    ]);

    if (hideUnavailable && hasAssetsIncluded(extraInclude)) {
      kits = kits.filter(
        // @ts-ignore
        (kit) => Array.isArray(kit.assets) && kit?.assets?.length > 0
      );
    }

    const totalPages = Math.ceil(totalKits / perPage);

    return {
      page,
      perPage,
      kits,
      totalKits: hideUnavailable
        ? totalKits - totalKitsWithoutAssets
        : totalKits,
      totalPages,
      search,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while fetching kits",
      additionalData: { page, perPage, organizationId },
      label,
    });
  }
}

type KitWithInclude<T extends Prisma.KitInclude | undefined> =
  T extends Prisma.KitInclude
    ? Prisma.KitGetPayload<{
        include: MergeInclude<typeof GET_KIT_STATIC_INCLUDES, T>;
      }>
    : Prisma.KitGetPayload<{ include: typeof GET_KIT_STATIC_INCLUDES }>;

export async function getKit<T extends Prisma.KitInclude | undefined>({
  id,
  organizationId,
  extraInclude,
  userOrganizations,
  request,
}: Pick<Kit, "id" | "organizationId"> & {
  extraInclude?: T;
  userOrganizations?: Pick<UserOrganization, "organizationId">[];
  request?: Request;
}) {
  try {
    const otherOrganizationIds = userOrganizations?.map(
      (org) => org.organizationId
    );

    // Merge static includes with dynamic includes
    const includes = {
      ...GET_KIT_STATIC_INCLUDES,
      ...extraInclude,
    } as MergeInclude<typeof GET_KIT_STATIC_INCLUDES, T>;

    // KEPT AS PRISMA: Dynamic generic include varies per caller
    const kit = await db.kit.findFirstOrThrow({
      where: {
        OR: [
          { id, organizationId },
          ...(userOrganizations?.length
            ? [{ id, organizationId: { in: otherOrganizationIds } }]
            : []),
        ],
      },
      include: includes,
    });

    /* User is accessing the asset in the wrong organizations. In that case we need special 404 handlng. */
    if (
      userOrganizations?.length &&
      kit.organizationId !== organizationId &&
      otherOrganizationIds?.includes(kit.organizationId)
    ) {
      const redirectTo =
        typeof request !== "undefined"
          ? getRedirectUrlFromRequest(request)
          : undefined;

      throw new ShelfError({
        cause: null,
        title: "Kit not found",
        message: "",
        additionalData: {
          model: "kit",
          organization: userOrganizations.find(
            (org) => org.organizationId === kit.organizationId
          ),
          redirectTo,
        },
        label,
        status: 404,
        shouldBeCaptured: false, // In this case we shouldnt be capturing the error
      });
    }

    return kit as KitWithInclude<T>;
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);

    throw new ShelfError({
      cause,
      title: "Kit not found",
      message:
        "The kit you are trying to access does not exist or you do not have permission to access it.",
      additionalData: {
        id,
        ...(isShelfError ? cause.additionalData : {}),
      },
      label,
      shouldBeCaptured: isShelfError
        ? cause.shouldBeCaptured
        : !isNotFoundError(cause),
    });
  }
}

export async function getAssetsForKits({
  request,
  organizationId,
  extraWhere,
  kitId,
  ignoreFilters,
}: {
  request: LoaderFunctionArgs["request"];
  organizationId: Organization["id"];
  kitId: Kit["id"];
  extraWhere?: Prisma.AssetWhereInput;
  /** Set this to true if you don't want the search filters to be applied */
  ignoreFilters?: boolean;
}) {
  const searchParams = getCurrentSearchParams(request);
  const paramsValues = getParamsValues(searchParams);
  const { page, perPageParam, search, orderBy, orderDirection } = paramsValues;

  const cookie = await updateCookieWithPerPage(request, perPageParam);
  const { perPage } = cookie;

  try {
    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = perPage >= 1 && perPage <= 100 ? perPage : 20; // min 1 and max 100 per page

    const where: Prisma.AssetWhereInput = { organizationId, kitId };

    if (search && !ignoreFilters) {
      const searchTerm = search.toLowerCase().trim();
      where.OR = [
        // Search in asset title
        { title: { contains: searchTerm, mode: "insensitive" } },
        // Search in asset barcodes
        {
          barcodes: {
            some: { value: { contains: searchTerm, mode: "insensitive" } },
          },
        },
      ];
    }

    const finalQuery = {
      ...where,
      ...extraWhere,
    };

    // KEPT AS PRISMA: Dynamic where from extraWhere parameter +
    // KIT_SELECT_FIELDS_FOR_LIST_ITEMS with nested relations
    const [items, totalItems] = await Promise.all([
      db.asset.findMany({
        skip,
        take,
        where: finalQuery,
        select: KIT_SELECT_FIELDS_FOR_LIST_ITEMS,
        orderBy: { [orderBy]: orderDirection },
      }),
      db.asset.count({ where: finalQuery }),
    ]);

    const totalPages = Math.ceil(totalItems / perPage);

    return { page, perPage, search, items, totalItems, totalPages };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Fail to fetch paginated and filterable assets",
      additionalData: {
        organizationId,
        paramsValues,
      },
      label,
    });
  }
}

export async function deleteKit({
  id,
  organizationId,
}: {
  id: Kit["id"];
  organizationId: Kit["organizationId"];
}) {
  const { error } = await sbDb
    .from("Kit")
    .delete()
    .eq("id", id)
    .eq("organizationId", organizationId);

  if (error) {
    throw new ShelfError({
      cause: error,
      message: "Something went wrong while deleting kit",
      additionalData: { id, organizationId },
      label,
    });
  }
}

export async function deleteKitImage({
  url,
  bucketName = "kits",
}: {
  url: string;
  bucketName?: string;
}) {
  try {
    const path = extractImageNameFromSupabaseUrl({ url, bucketName });
    if (!path) {
      throw new ShelfError({
        cause: null,
        message: "Cannot extract the image path from the URL",
        additionalData: { url, bucketName },
        label,
      });
    }

    const { error } = await getSupabaseAdmin()
      .storage.from(bucketName)
      .remove([path]);

    if (error) {
      throw error;
    }

    return true;
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        message: "Failed to delete kit image",
        additionalData: { url, bucketName },
        label,
      })
    );
  }
}

export async function releaseCustody({
  kitId,
  userId,
  organizationId,
}: {
  kitId: Kit["id"];
  userId: string;
  organizationId: Kit["organizationId"];
}) {
  try {
    // Split the deep nested query into separate sequential queries
    const { data: kitRow, error: kitError } = await sbDb
      .from("Kit")
      .select("id, name, createdById")
      .eq("id", kitId)
      .eq("organizationId", organizationId)
      .single();
    if (kitError) throw kitError;

    const [
      { data: kitAssets, error: assetsError },
      { data: kitCustodyRow, error: custodyError },
      actor,
    ] = await Promise.all([
      sbDb.from("Asset").select("id, title").eq("kitId", kitId),
      sbDb
        .from("KitCustody")
        .select("id, custodianId")
        .eq("kitId", kitId)
        .maybeSingle(),
      getUserByID(userId, {
        select: {
          firstName: true,
          lastName: true,
        } satisfies Prisma.UserSelect,
      }),
    ]);
    if (assetsError) throw assetsError;
    if (custodyError) throw custodyError;

    // Fetch custodian with user if custody exists
    let custodianWithUser: {
      id: string;
      name: string;
      user: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        profilePicture: string | null;
        email: string;
      } | null;
    } | null = null;
    if (kitCustodyRow?.custodianId) {
      const { data: tmRow } = await sbDb
        .from("TeamMember")
        .select("id, name, userId")
        .eq("id", kitCustodyRow.custodianId)
        .single();
      if (tmRow) {
        let tmUser = null;
        if (tmRow.userId) {
          const { data: userData } = await sbDb
            .from("User")
            .select("id, firstName, lastName, profilePicture, email")
            .eq("id", tmRow.userId)
            .single();
          tmUser = userData;
        }
        custodianWithUser = { id: tmRow.id, name: tmRow.name, user: tmUser };
      }
    }

    const { data: createdByRow } = await sbDb
      .from("User")
      .select("id, firstName, lastName")
      .eq("id", kitRow.createdById)
      .single();

    const kit = {
      ...kitRow,
      assets: kitAssets ?? [],
      createdBy: createdByRow,
      custody: kitCustodyRow ? { custodian: custodianWithUser } : null,
    };

    const actorLink = wrapUserLinkForNote({
      id: userId,
      firstName: actor?.firstName,
      lastName: actor?.lastName,
    });
    const custodianDisplay = kit.custody?.custodian
      ? wrapCustodianForNote({ teamMember: kit.custody.custodian })
      : "**Unknown Custodian**";
    const kitLink = wrapLinkForNote(`/kits/${kit.id}`, kit.name.trim());

    // Use RPC for atomicity - prevents orphaned custody records on partial failure
    const assetIds = kit.assets.map((a) => a.id);
    const { error: rpcError } = await sbDb.rpc("shelf_kit_release_custody", {
      p_kit_id: kitId,
      p_org_id: organizationId,
      p_asset_ids: assetIds,
    });
    if (rpcError) throw rpcError;

    // Notes can be created outside transaction (not critical for consistency)
    await createNotes({
      content: `${actorLink} released ${custodianDisplay}'s custody via kit: ${kitLink}.`,
      type: "UPDATE",
      userId,
      assetIds: kit.assets.map((asset) => asset.id),
    });

    return kit;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while releasing the custody. Please try again or contact support.",
      additionalData: { kitId },
      label: "Custody",
    });
  }
}

export async function updateKitsWithBookingCustodians<T extends Kit>(
  kits: T[]
): Promise<T[]> {
  try {
    /** When kits are checked out, we have to display the custodian from that booking */
    const checkedOutKits = kits
      .filter((kit) => kit.status === "CHECKED_OUT")
      .map((k) => k.id);

    if (checkedOutKits.length === 0) {
      return kits;
    }

    const resolvedKits: T[] = [];

    for (const kit of kits) {
      if (!checkedOutKits.includes(kit.id)) {
        resolvedKits.push(kit);
        continue;
      }

      /** A kit is not directly associated with booking so have to make an extra query to get the booking for kit.
       * We filter for assets that have an active booking to avoid picking
       * an asset in the kit that is AVAILABLE and has no relevant booking. */
      // 1. Find asset IDs in this kit that have ONGOING/OVERDUE bookings via junction table
      const { data: kitAssetsForKit } = await sbDb
        .from("Asset")
        .select("id")
        .eq("kitId", kit.id);
      const kitAssetIds = (kitAssetsForKit ?? []).map((a) => a.id);

      let booking: {
        id: string;
        custodianTeamMember: TeamMember | null;
        custodianUser: Pick<
          User,
          "firstName" | "lastName" | "profilePicture"
        > | null;
      } | null = null;

      if (kitAssetIds.length > 0) {
        // 2. Find bookings with ONGOING/OVERDUE status linked to these assets
        const { data: junctionRows } = await sbDb
          .from("_AssetToBooking")
          .select("A, B")
          .in("A", kitAssetIds);

        const bookingIds = [...new Set((junctionRows ?? []).map((r) => r.B))];

        if (bookingIds.length > 0) {
          const { data: bookings } = await sbDb
            .from("Booking")
            .select("id, status, custodianUserId, custodianTeamMemberId")
            .in("id", bookingIds)
            .in("status", ["ONGOING", "OVERDUE"])
            .limit(1);

          if (bookings && bookings.length > 0) {
            const b = bookings[0];
            let custUser = null;
            let custTm = null;
            if (b.custodianUserId) {
              const { data: u } = await sbDb
                .from("User")
                .select("firstName, lastName, profilePicture")
                .eq("id", b.custodianUserId)
                .single();
              custUser = u;
            }
            if (b.custodianTeamMemberId) {
              const { data: tm } = await sbDb
                .from("TeamMember")
                .select("*")
                .eq("id", b.custodianTeamMemberId)
                .single();
              custTm = tm
                ? ({
                    ...tm,
                    createdAt: new Date(tm.createdAt),
                    updatedAt: new Date(tm.updatedAt),
                    deletedAt: tm.deletedAt ? new Date(tm.deletedAt) : null,
                  } as TeamMember)
                : null;
            }
            booking = {
              id: b.id,
              custodianTeamMember: custTm,
              custodianUser: custUser,
            };
          }
        }
      }

      const custodianUser = booking?.custodianUser;
      const custodianTeamMember = booking?.custodianTeamMember;

      if (custodianUser) {
        resolvedKits.push({
          ...kit,
          custody: {
            custodian: {
              name: `${custodianUser?.firstName || ""} ${
                custodianUser?.lastName || ""
              }`, // Concatenate firstName and lastName to form the name property with default values
              user: {
                firstName: custodianUser?.firstName || "",
                lastName: custodianUser?.lastName || "",
                profilePicture: custodianUser?.profilePicture || null,
              },
            },
          },
        });
      } else if (custodianTeamMember) {
        resolvedKits.push({
          ...kit,
          custody: {
            custodian: { name: custodianTeamMember.name },
          },
        });
      } else {
        resolvedKits.push(kit);
        /** This case should never happen because there must be a custodianUser or custodianTeamMember assigned to a booking */
        Logger.error(
          new ShelfError({
            cause: null,
            message: "Could not find custodian for kit",
            additionalData: { kit },
            label,
          })
        );
      }
    }

    return resolvedKits;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to update kits with booking custodian",
      additionalData: { kits },
      label,
    });
  }
}

type CurrentBookingType = {
  id: string;
  name: string;
  custodianUser: Pick<
    User,
    "firstName" | "lastName" | "profilePicture" | "email"
  > | null;
  custodianTeamMember: TeamMember | null;
  status: BookingStatus;
  from: Booking["from"];
};

/**
 * Determines if a kit has a current booking by checking its assets.
 * A kit is considered to have a current booking when at least one of its assets is:
 * 1. Currently checked out (status === CHECKED_OUT)
 * 2. Has an ongoing or overdue booking
 *
 * This ensures the custody card only shows when assets are actually in custody,
 * not just when they have ongoing bookings but have been checked back in.
 *
 * @returns The first ongoing/overdue booking found, or undefined if none exist
 */
export function getKitCurrentBooking(kit: {
  id: string;
  assets: {
    status: AssetStatus;
    bookings: CurrentBookingType[];
  }[];
}) {
  const ongoingBookingAsset = kit.assets
    // Filter each asset's bookings to only ongoing or overdue ones
    .map((a) => ({
      ...a,
      bookings: a.bookings.filter(
        (b) =>
          b.status === BookingStatus.ONGOING ||
          b.status === BookingStatus.OVERDUE
      ),
    }))
    // Only consider assets that are actually checked out
    .filter((a) => a.status === AssetStatus.CHECKED_OUT)
    // Find the first asset that has any ongoing/overdue bookings
    .find((a) => a.bookings.length > 0);

  const ongoingBooking = ongoingBookingAsset
    ? ongoingBookingAsset.bookings[0]
    : undefined;

  return ongoingBooking;
}

export async function bulkDeleteKits({
  kitIds,
  organizationId,
  userId,
  currentSearchParams,
}: {
  kitIds: Kit["id"][];
  organizationId: Kit["organizationId"];
  userId: User["id"];
  currentSearchParams?: string | null;
}) {
  try {
    /** We have to remove the images of the kits so we have to make this query */
    const kits = (await resolveKitIdsForBulk({
      kitIds,
      organizationId,
      currentSearchParams,
      selectColumns: "id, image",
    })) as Array<{ id: string; image: string | null }>;

    const kitIdList = kits.map((kit) => kit.id);

    /** Deleting all kits */
    const { error: deleteError } = await sbDb
      .from("Kit")
      .delete()
      .in("id", kitIdList);
    if (deleteError) throw deleteError;

    /** Deleting images of the kits (if any) */
    const kitWithImages = kits.filter((kit) => !!kit.image);
    await Promise.all(
      kitWithImages.map((kit) => deleteKitImage({ url: kit.image! }))
    );
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while bulk deleting kits.",
      additionalData: { kitIds, organizationId, userId },
      label,
    });
  }
}

export async function bulkAssignKitCustody({
  kitIds,
  organizationId,
  custodianId,
  custodianName,
  userId,
  currentSearchParams,
}: {
  kitIds: Kit["id"][];
  organizationId: Kit["organizationId"];
  custodianId: TeamMember["id"];
  custodianName: TeamMember["name"];
  userId: User["id"];
  currentSearchParams?: string | null;
}) {
  try {
    /**
     * We have to make notes and assign custody to all assets of a kit so we have to make this query.
     * Step 1: Resolve kit rows, then fetch their assets separately.
     */
    const kitRows = (await resolveKitIdsForBulk({
      kitIds,
      organizationId,
      currentSearchParams,
      selectColumns: "id, name, status",
    })) as Array<{ id: string; name: string; status: string }>;

    const kitIdList = kitRows.map((k) => k.id);
    const { data: kitAssetsRaw, error: kitAssetsErr } =
      kitIdList.length > 0
        ? await sbDb
            .from("Asset")
            .select("id, title, status, kitId")
            .in("kitId", kitIdList)
        : { data: [] as any[], error: null };
    if (kitAssetsErr) throw kitAssetsErr;

    // Assemble kits with their assets (+ each asset gets a `kit` ref back)
    const kitsWithAssetsList = kitRows.map((k) => ({
      ...k,
      assets: (kitAssetsRaw ?? [])
        .filter((a: any) => a.kitId === k.id)
        .map((a: any) => ({
          id: a.id,
          title: a.title,
          status: a.status,
          kit: { id: k.id, name: k.name },
        })),
    }));
    const kits = kitsWithAssetsList;

    const [user, custodianTeamMember] = await Promise.all([
      getUserByID(userId, {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        } satisfies Prisma.UserSelect,
      }),
      sbDb
        .from("TeamMember")
        .select("id, name, userId")
        .eq("id", custodianId)
        .single()
        .then(async ({ data, error }) => {
          if (error) throw error;
          if (!data) return null;
          let user = null;
          if (data.userId) {
            const { data: userData } = await sbDb
              .from("User")
              .select("id, firstName, lastName")
              .eq("id", data.userId)
              .single();
            user = userData;
          }
          return { id: data.id, name: data.name, user };
        }),
    ]);

    const someKitsNotAvailable = kits.some((kit) => kit.status !== "AVAILABLE");
    if (someKitsNotAvailable) {
      throw new ShelfError({
        cause: null,
        message:
          "There are some unavailable kits. Please make sure you are selecting only available kits.",
        label,
      });
    }

    const allAssetsOfAllKits = kits.flatMap((kit) => kit.assets);

    const someAssetsUnavailable = allAssetsOfAllKits.some(
      (asset) => asset.status !== "AVAILABLE"
    );
    if (someAssetsUnavailable) {
      throw new ShelfError({
        cause: null,
        message:
          "There are some unavailable assets in some kits. Please make sure you have all available assets in kits.",
        label,
      });
    }

    /**
     * updateMany does not allow to create nested relationship rows so we have
     * to make two queries to assign custody over
     * 1. Create custodies for kit
     * 2. Update status of all kits to IN_CUSTODY
     */
    /** Pre-compute note contents for each asset */
    const actor = wrapUserLinkForNote({
      id: userId,
      firstName: user?.firstName,
      lastName: user?.lastName,
    });
    const custodianDisplay = custodianTeamMember
      ? wrapCustodianForNote({ teamMember: custodianTeamMember })
      : `**${custodianName.trim()}**`;

    const noteAssetIds: string[] = [];
    const noteContents: string[] = [];
    for (const asset of allAssetsOfAllKits) {
      const kitLink = asset.kit
        ? wrapLinkForNote(`/kits/${asset.kit.id}`, asset.kit.name.trim())
        : "**Unknown Kit**";
      noteAssetIds.push(asset.id);
      noteContents.push(
        `${actor} granted ${custodianDisplay} custody via kit assignment ${kitLink}.`
      );
    }

    const { error: rpcError } = await sbDb.rpc(
      "shelf_kit_bulk_assign_custody",
      {
        p_kit_ids: kits.map((kit) => kit.id),
        p_custodian_id: custodianId,
        p_asset_ids: allAssetsOfAllKits.map((asset) => asset.id),
        p_user_id: userId,
        p_note_asset_ids: noteAssetIds,
        p_note_contents: noteContents,
      }
    );

    if (rpcError) {
      throw new ShelfError({
        cause: rpcError,
        message: rpcError.message,
        label,
      });
    }
  } catch (cause) {
    const message =
      cause instanceof ShelfError
        ? cause.message
        : "Something went wrong while bulk checking out kits.";

    throw new ShelfError({
      cause,
      message,
      additionalData: {
        kitIds,
        organizationId,
        userId,
        custodianId,
        custodianName,
      },
      label,
    });
  }
}

export async function bulkReleaseKitCustody({
  kitIds,
  organizationId,
  userId,
  currentSearchParams,
}: {
  kitIds: Kit["id"][];
  organizationId: Kit["organizationId"];
  userId: User["id"];
  currentSearchParams?: string | null;
}) {
  try {
    /**
     * To make notes and release assets of kits we have to make this query.
     * Split into: kit rows -> kit custodies (with custodian+user) -> assets (with custody + kit ref)
     */
    const kitRows = (await resolveKitIdsForBulk({
      kitIds,
      organizationId,
      currentSearchParams,
      selectColumns: "id, name, status",
    })) as Array<{ id: string; name: string; status: string }>;

    const resolvedKitIds = kitRows.map((k) => k.id);

    // Fetch custody, assets, and user in parallel
    const [custodyResult, assetsResult, assetCustodyResult, user] =
      await Promise.all([
        resolvedKitIds.length > 0
          ? sbDb
              .from("KitCustody")
              .select("id, kitId, custodianId")
              .in("kitId", resolvedKitIds)
          : { data: [] as any[], error: null },
        resolvedKitIds.length > 0
          ? sbDb
              .from("Asset")
              .select("id, status, title, kitId")
              .in("kitId", resolvedKitIds)
          : { data: [] as any[], error: null },
        resolvedKitIds.length > 0
          ? sbDb
              .from("Custody")
              .select("id, assetId")
              .in(
                "assetId",
                // We need asset IDs first - fetch inline
                (
                  await sbDb
                    .from("Asset")
                    .select("id")
                    .in("kitId", resolvedKitIds)
                ).data?.map((a) => a.id) ?? []
              )
          : { data: [] as any[], error: null },
        getUserByID(userId, {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          } satisfies Prisma.UserSelect,
        }),
      ]);

    if (custodyResult.error) throw custodyResult.error;
    if (assetsResult.error) throw assetsResult.error;
    if (assetCustodyResult.error) throw assetCustodyResult.error;

    // Resolve custodian + user for each kit custody
    const custodianIds = [
      ...new Set(
        (custodyResult.data ?? []).map((c: any) => c.custodianId as string)
      ),
    ];
    let custodianMap = new Map<
      string,
      { id: string; name: string; user: any }
    >();
    if (custodianIds.length > 0) {
      const { data: tmRows } = await sbDb
        .from("TeamMember")
        .select("id, name, userId")
        .in("id", custodianIds);
      const userIds = (tmRows ?? [])
        .map((t) => t.userId)
        .filter(Boolean) as string[];
      let userMap = new Map<string, any>();
      if (userIds.length > 0) {
        const { data: users } = await sbDb
          .from("User")
          .select("id, firstName, lastName, profilePicture, email")
          .in("id", userIds);
        (users ?? []).forEach((u) => userMap.set(u.id, u));
      }
      (tmRows ?? []).forEach((tm) => {
        custodianMap.set(tm.id, {
          id: tm.id,
          name: tm.name,
          user: tm.userId ? (userMap.get(tm.userId) ?? null) : null,
        });
      });
    }

    // Build asset custody map (assetId -> { id })
    const assetCustodyMap = new Map<string, { id: string }>();
    (assetCustodyResult.data ?? []).forEach((c: any) => {
      assetCustodyMap.set(c.assetId, { id: c.id });
    });

    // Assemble kits
    const kits = kitRows.map((k) => {
      const custodyRow = (custodyResult.data ?? []).find(
        (c: any) => c.kitId === k.id
      );
      return {
        ...k,
        custody: custodyRow
          ? {
              id: custodyRow.id,
              custodian: custodianMap.get(custodyRow.custodianId) ?? null,
            }
          : null,
        assets: (assetsResult.data ?? [])
          .filter((a: any) => a.kitId === k.id)
          .map((a: any) => ({
            id: a.id,
            status: a.status,
            title: a.title,
            custody: assetCustodyMap.get(a.id) ?? null,
            kit: { id: k.id, name: k.name },
          })),
      };
    });

    const custodian = kits[0].custody?.custodian;

    /** Kits will be released only if all the selected kits are IN_CUSTODY */
    const allKitsInCustody = kits.every((kit) => kit.status === "IN_CUSTODY");
    if (!allKitsInCustody) {
      throw new ShelfError({
        cause: null,
        message:
          "There are some kits which are not in custody. Please make sure you are only selecting kits in custody to release them.",
        label,
      });
    }

    const allAssetsOfAllKits = kits.flatMap((kit) => kit.assets);

    /** Pre-compute note contents for each asset */
    const actor = wrapUserLinkForNote({
      id: userId,
      firstName: user?.firstName,
      lastName: user?.lastName,
    });
    const custodianDisplay = custodian
      ? wrapCustodianForNote({ teamMember: custodian })
      : "**Unknown Custodian**";

    const noteAssetIds: string[] = [];
    const noteContents: string[] = [];
    for (const asset of allAssetsOfAllKits) {
      const kitLink = asset.kit
        ? wrapLinkForNote(`/kits/${asset.kit.id}`, asset.kit.name.trim())
        : "**Unknown Kit**";
      noteAssetIds.push(asset.id);
      noteContents.push(
        `${actor} released ${custodianDisplay}'s custody via kit assignment ${kitLink}.`
      );
    }

    const { error: rpcError } = await sbDb.rpc(
      "shelf_kit_bulk_release_custody",
      {
        p_kit_ids: kits.map((kit) => kit.id),
        p_asset_ids: allAssetsOfAllKits.map((asset) => asset.id),
        p_user_id: userId,
        p_note_asset_ids: noteAssetIds,
        p_note_contents: noteContents,
      }
    );

    if (rpcError) {
      throw new ShelfError({
        cause: rpcError,
        message: rpcError.message,
        label,
      });
    }
  } catch (cause) {
    const message =
      cause instanceof ShelfError
        ? cause.message
        : "Something went wrong while bulk releasing kits.";

    throw new ShelfError({
      cause,
      message,
      additionalData: { kitIds, organizationId, userId },
      label,
    });
  }
}

export async function createKitsIfNotExists({
  data,
  userId,
  organizationId,
}: {
  data: CreateAssetFromContentImportPayload[];
  userId: User["id"];
  organizationId: Organization["id"];
}): Promise<Record<string, Kit>> {
  try {
    // first we get all the kits from the assets and make then into an object where the category is the key and the value is an empty string
    // Normalize kit names so whitespace-only or padded values don't create phantom keys.
    const kitNames = Array.from(
      new Set(
        data
          .map((asset) => asset.kit?.trim())
          .filter((kit): kit is string => !!kit)
      )
    );

    // Handle the case where there are no kits
    if (kitNames.length === 0) {
      return {};
    }

    // now we loop through the kits and check if they exist
    const kits = new Map<string, Kit>();
    for (const kit of kitNames) {
      const { data: existingKit, error: findKitError } = await sbDb
        .from("Kit")
        .select("*")
        .ilike("name", kit)
        .eq("organizationId", organizationId)
        .maybeSingle();

      if (findKitError) {
        throw new ShelfError({
          cause: findKitError,
          message: "Failed to check for existing kit",
          additionalData: { kit, organizationId },
          label,
        });
      }

      if (!existingKit) {
        // if the kit doesn't exist, we create a new one
        const { data: newKit, error: createKitError } = await sbDb
          .from("Kit")
          .insert({
            id: id(),
            name: kit.trim(),
            createdById: userId,
            organizationId,
          })
          .select("*")
          .single();

        if (createKitError) throw createKitError;

        kits.set(kit, {
          ...newKit,
          createdAt: new Date(newKit.createdAt),
          updatedAt: new Date(newKit.updatedAt),
          imageExpiration: newKit.imageExpiration
            ? new Date(newKit.imageExpiration)
            : null,
        } as Kit);
      } else {
        // if the location exists, we just update the id
        kits.set(kit, {
          ...existingKit,
          createdAt: new Date(existingKit.createdAt),
          updatedAt: new Date(existingKit.updatedAt),
          imageExpiration: existingKit.imageExpiration
            ? new Date(existingKit.imageExpiration)
            : null,
        } as any);
      }
    }

    return Object.fromEntries(Array.from(kits));
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while creating kits. Seems like some of the location data in your import file is invalid. Please check and try again.",
      additionalData: { userId, organizationId },
      label,
      /** No need to capture those. They are mostly related to malformed CSV data */
      shouldBeCaptured: false,
    });
  }
}

export async function updateKitQrCode({
  kitId,
  newQrId,
  organizationId,
}: {
  organizationId: string;
  kitId: string;
  newQrId: string;
}) {
  try {
    // Disconnect all existing QR codes from this kit
    const { error: disconnectError } = await sbDb
      .from("Qr")
      .update({ kitId: null })
      .eq("kitId", kitId);

    if (disconnectError) {
      throw new ShelfError({
        cause: disconnectError,
        message: "Couldn't disconnect existing codes",
        label,
        additionalData: { kitId, organizationId, newQrId },
      });
    }

    // Connect the new QR code to this kit
    const { error: connectError } = await sbDb
      .from("Qr")
      .update({ kitId })
      .eq("id", newQrId);

    if (connectError) {
      throw new ShelfError({
        cause: connectError,
        message: "Couldn't connect the new QR code",
        label,
        additionalData: { kitId, organizationId, newQrId },
      });
    }

    // Return the updated kit
    const { data: updatedKit, error: kitError } = await sbDb
      .from("Kit")
      .select("*")
      .eq("id", kitId)
      .eq("organizationId", organizationId)
      .single();

    if (kitError) throw kitError;

    return {
      ...updatedKit,
      createdAt: new Date(updatedKit.createdAt),
      updatedAt: new Date(updatedKit.updatedAt),
      imageExpiration: updatedKit.imageExpiration
        ? new Date(updatedKit.imageExpiration)
        : null,
    } as Kit;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while updating kit QR code",
      label,
      additionalData: { kitId, organizationId, newQrId },
    });
  }
}

/**
 * Relinks a kit to a different QR code, unlinking any previous code.
 * Throws when the QR belongs to another org or is already linked to an asset/kit.
 */
export async function relinkKitQrCode({
  qrId,
  kitId,
  organizationId,
  userId,
}: {
  qrId: Qr["id"];
  kitId: Kit["id"];
  organizationId: Organization["id"];
  userId: User["id"];
}) {
  const [qr, kitRow, kitQrCodes] = await Promise.all([
    getQr({ id: qrId }),
    sbDb
      .from("Kit")
      .select("id")
      .eq("id", kitId)
      .eq("organizationId", organizationId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) throw error;
        return data;
      }),
    sbDb
      .from("Qr")
      .select("id")
      .eq("kitId", kitId)
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      }),
  ]);
  const kit = kitRow ? { qrCodes: kitQrCodes } : null;

  if (!kit) {
    throw new ShelfError({
      cause: null,
      message: "Kit not found.",
      label,
      additionalData: { kitId, organizationId, qrId },
    });
  }

  if (qr.organizationId && qr.organizationId !== organizationId) {
    throw new ShelfError({
      cause: null,
      title: "QR not valid.",
      message: "This QR code does not belong to your organization",
      label,
    });
  }

  if (qr.assetId) {
    throw new ShelfError({
      cause: null,
      title: "QR already linked.",
      message:
        "You cannot link to this code because its already linked to another asset. Delete the other asset to free up the code and try again.",
      label,
      shouldBeCaptured: false,
    });
  }

  if (qr.kitId && qr.kitId !== kitId) {
    throw new ShelfError({
      cause: null,
      title: "QR already linked.",
      message:
        "You cannot link to this code because its already linked to another kit. Delete the other kit to free up the code and try again.",
      label,
      shouldBeCaptured: false,
    });
  }

  const oldQrCode = kit.qrCodes[0];

  const [qrUpdateResult] = await Promise.all([
    sbDb.from("Qr").update({ organizationId, userId }).eq("id", qr.id),
    updateKitQrCode({
      kitId,
      newQrId: qr.id,
      organizationId,
    }),
  ]);

  if (qrUpdateResult.error) {
    throw new ShelfError({
      cause: qrUpdateResult.error,
      message: "Failed to update QR code",
      additionalData: { qrId: qr.id, organizationId, userId },
      label,
    });
  }

  return {
    oldQrCodeId: oldQrCode?.id,
    newQrId: qr.id,
  };
}

export async function getAvailableKitAssetForBooking(
  kitIds: Kit["id"][]
): Promise<string[]> {
  try {
    const { data: allAssets, error: assetsError } = await sbDb
      .from("Asset")
      .select("id, status")
      .in("kitId", kitIds);

    if (assetsError) throw assetsError;

    return (allAssets ?? []).map((asset) => asset.id);
  } catch (cause: any) {
    throw new ShelfError({
      cause: cause,
      message:
        cause?.message ||
        "Something went wrong while getting available assets.",
      label: "Assets",
    });
  }
}

export async function updateKitLocation({
  id,
  organizationId,
  currentLocationId,
  newLocationId,
  userId,
}: {
  id: Kit["id"];
  organizationId: Kit["organizationId"];
  currentLocationId: Kit["locationId"];
  newLocationId: Kit["locationId"];
  userId?: User["id"];
}) {
  try {
    // Get kit with its assets first (split into two queries)
    const { data: kitRow, error: kitError } = await sbDb
      .from("Kit")
      .select("id, name")
      .eq("id", id)
      .eq("organizationId", organizationId)
      .maybeSingle();

    if (kitError) throw kitError;

    if (!kitRow) {
      throw new ShelfError({
        cause: null,
        message: "Kit not found",
        label,
      });
    }

    const { data: kitAssets, error: assetsError } = await sbDb
      .from("Asset")
      .select("id, title, locationId")
      .eq("kitId", id);

    if (assetsError) throw assetsError;

    // Fetch locations for assets that have one
    const locationIds = [
      ...new Set((kitAssets ?? []).map((a) => a.locationId).filter(Boolean)),
    ] as string[];
    const locationMap = new Map<string, { id: string; name: string }>();
    if (locationIds.length > 0) {
      const { data: locations } = await sbDb
        .from("Location")
        .select("id, name")
        .in("id", locationIds);
      locations?.forEach((l) => locationMap.set(l.id, l));
    }

    const kit = {
      ...kitRow,
      assets: (kitAssets ?? []).map((a) => ({
        id: a.id,
        title: a.title,
        location: a.locationId ? (locationMap.get(a.locationId) ?? null) : null,
      })),
    };

    const assetIds = kit.assets.map((asset) => asset.id);

    if (newLocationId) {
      // Connect both kit and its assets to the new location via direct FK updates
      const { error: kitLocError } = await sbDb
        .from("Kit")
        .update({ locationId: newLocationId })
        .eq("id", id);
      if (kitLocError) throw kitLocError;

      if (assetIds.length > 0) {
        const { error: assetLocError } = await sbDb
          .from("Asset")
          .update({ locationId: newLocationId })
          .in("id", assetIds);
        if (assetLocError) throw assetLocError;
      }

      // Add notes to assets about location update via parent kit
      if (userId && assetIds.length > 0) {
        const user = await getUserByID(userId, {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          } satisfies Prisma.UserSelect,
        });
        const { data: location, error: locationError } = await sbDb
          .from("Location")
          .select("id, name")
          .eq("id", newLocationId)
          .maybeSingle();

        if (locationError) {
          throw new ShelfError({
            cause: locationError,
            message: "Failed to fetch location",
            additionalData: { newLocationId },
            label,
          });
        }

        // Create individual notes for each asset
        await Promise.all(
          kit.assets.map((asset) =>
            createNote({
              content: getKitLocationUpdateNoteContent({
                currentLocation: asset.location, // Use the asset's current location
                newLocation: location,
                userId,
                firstName: user?.firstName ?? "",
                lastName: user?.lastName ?? "",
                isRemoving: false,
              }),
              type: "UPDATE",
              userId,
              assetId: asset.id,
            })
          )
        );
      }
    } else if (!newLocationId && currentLocationId) {
      // Disconnect both kit and its assets from the current location via direct FK updates
      const { error: kitDisconnectError } = await sbDb
        .from("Kit")
        .update({ locationId: null })
        .eq("id", id);
      if (kitDisconnectError) throw kitDisconnectError;

      if (assetIds.length > 0) {
        const { error: assetDisconnectError } = await sbDb
          .from("Asset")
          .update({ locationId: null })
          .in("id", assetIds);
        if (assetDisconnectError) throw assetDisconnectError;
      }

      // Add notes to assets about location removal via parent kit
      if (userId && assetIds.length > 0) {
        const user = await getUserByID(userId, {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          } satisfies Prisma.UserSelect,
        });
        const { data: currentLocation, error: currentLocationError } =
          await sbDb
            .from("Location")
            .select("id, name")
            .eq("id", currentLocationId)
            .maybeSingle();

        if (currentLocationError) {
          throw new ShelfError({
            cause: currentLocationError,
            message: "Failed to fetch current location",
            additionalData: { currentLocationId },
            label,
          });
        }

        // Create individual notes for each asset
        await Promise.all(
          kit.assets.map((asset) =>
            createNote({
              content: getKitLocationUpdateNoteContent({
                currentLocation: currentLocation,
                newLocation: null,
                userId,
                firstName: user?.firstName ?? "",
                lastName: user?.lastName ?? "",
                isRemoving: true,
              }),
              type: "UPDATE",
              userId,
              assetId: asset.id,
            })
          )
        );
      }
    }

    // Return the updated kit
    const { data: updatedKit, error: updatedKitError } = await sbDb
      .from("Kit")
      .select("*")
      .eq("id", id)
      .eq("organizationId", organizationId)
      .maybeSingle();

    if (updatedKitError) {
      throw new ShelfError({
        cause: updatedKitError,
        message: "Failed to fetch updated kit",
        additionalData: { id, organizationId },
        label,
      });
    }

    return updatedKit;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while updating kit location",
      label,
    });
  }
}

export async function bulkUpdateKitLocation({
  kitIds,
  organizationId,
  newLocationId,
  currentSearchParams,
  userId,
}: {
  kitIds: Array<Kit["id"]>;
  organizationId: Kit["organizationId"];
  newLocationId: Kit["locationId"];
  currentSearchParams?: string | null;
  userId: User["id"];
}) {
  try {
    // Get kits with their assets before updating (split into multiple queries)
    const kitRows = (await resolveKitIdsForBulk({
      kitIds,
      organizationId,
      currentSearchParams,
      selectColumns: "id, name, locationId",
    })) as Array<{ id: string; name: string; locationId: string | null }>;

    const resolvedKitIds = kitRows.map((k) => k.id);

    // Fetch locations for kits + assets for kits in parallel
    const kitLocationIds = [
      ...new Set(kitRows.map((k) => k.locationId).filter(Boolean)),
    ] as string[];
    const [kitLocResult, kitAssetsResult] = await Promise.all([
      kitLocationIds.length > 0
        ? sbDb.from("Location").select("id, name").in("id", kitLocationIds)
        : { data: [] as any[], error: null },
      resolvedKitIds.length > 0
        ? sbDb
            .from("Asset")
            .select("id, title, locationId, kitId")
            .in("kitId", resolvedKitIds)
        : { data: [] as any[], error: null },
    ]);
    if (kitLocResult.error) throw kitLocResult.error;
    if (kitAssetsResult.error) throw kitAssetsResult.error;

    const kitLocMap = new Map<string, { id: string; name: string }>();
    (kitLocResult.data ?? []).forEach((l: any) => kitLocMap.set(l.id, l));

    // Fetch asset locations
    const assetLocationIds = [
      ...new Set(
        (kitAssetsResult.data ?? [])
          .map((a: any) => a.locationId)
          .filter(Boolean)
      ),
    ] as string[];
    let assetLocMap = new Map<string, { id: string; name: string }>();
    if (assetLocationIds.length > 0) {
      const { data: assetLocs } = await sbDb
        .from("Location")
        .select("id, name")
        .in("id", assetLocationIds);
      (assetLocs ?? []).forEach((l) => assetLocMap.set(l.id, l));
    }
    // Merge kit locations into asset location map
    kitLocMap.forEach((v, k) => {
      if (!assetLocMap.has(k)) assetLocMap.set(k, v);
    });

    const kitsWithAssets = kitRows.map((k) => ({
      ...k,
      location: k.locationId ? (kitLocMap.get(k.locationId) ?? null) : null,
      assets: (kitAssetsResult.data ?? [])
        .filter((a: any) => a.kitId === k.id)
        .map((a: any) => ({
          id: a.id,
          title: a.title,
          location: a.locationId
            ? (assetLocMap.get(a.locationId) ?? null)
            : null,
        })),
    }));

    const actualKitIds = kitsWithAssets.map((kit) => kit.id);
    const allAssets = kitsWithAssets.flatMap((kit) => kit.assets);

    if (
      newLocationId &&
      newLocationId.trim() !== "" &&
      actualKitIds.length > 0
    ) {
      // Update location for both kits and their assets via direct FK updates
      if (actualKitIds.length > 0) {
        const { error: kitsLocError } = await sbDb
          .from("Kit")
          .update({ locationId: newLocationId })
          .in("id", actualKitIds);
        if (kitsLocError) throw kitsLocError;
      }

      if (allAssets.length > 0) {
        const { error: assetsLocError } = await sbDb
          .from("Asset")
          .update({ locationId: newLocationId })
          .in(
            "id",
            allAssets.map((asset) => asset.id)
          );
        if (assetsLocError) throw assetsLocError;
      }

      // Create notes for affected assets
      if (allAssets.length > 0) {
        const user = await getUserByID(userId, {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          } satisfies Prisma.UserSelect,
        });
        const { data: location, error: locationError } = await sbDb
          .from("Location")
          .select("id, name")
          .eq("id", newLocationId)
          .maybeSingle();

        if (locationError) {
          throw new ShelfError({
            cause: locationError,
            message: "Failed to fetch location",
            additionalData: { newLocationId },
            label,
          });
        }

        // Create individual notes for each asset
        await Promise.all(
          allAssets.map((asset) =>
            createNote({
              content: getKitLocationUpdateNoteContent({
                currentLocation: asset.location,
                newLocation: location,
                userId,
                firstName: user?.firstName ?? "",
                lastName: user?.lastName ?? "",
                isRemoving: false,
              }),
              type: "UPDATE",
              userId,
              assetId: asset.id,
            })
          )
        );
      }
    } else {
      // Removing location - set to null and handle cascade
      if (actualKitIds.length > 0) {
        const { error: kitLocNullError } = await sbDb
          .from("Kit")
          .update({ locationId: null })
          .in("id", actualKitIds);
        if (kitLocNullError) throw kitLocNullError;
      }

      // Also remove location from assets and create notes
      if (allAssets.length > 0) {
        const user = await getUserByID(userId, {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          } satisfies Prisma.UserSelect,
        });

        const { error: assetLocNullError } = await sbDb
          .from("Asset")
          .update({ locationId: null })
          .in(
            "id",
            allAssets.map((asset) => asset.id)
          );
        if (assetLocNullError) throw assetLocNullError;

        // Create individual notes for each asset
        await Promise.all(
          allAssets.map((asset) =>
            createNote({
              content: getKitLocationUpdateNoteContent({
                currentLocation: asset.location,
                newLocation: null,
                userId,
                firstName: user?.firstName ?? "",
                lastName: user?.lastName ?? "",
                isRemoving: true,
              }),
              type: "UPDATE",
              userId,
              assetId: asset.id,
            })
          )
        );
      }
    }

    // Create location activity notes
    const userForNote = await getUserByID(userId, {
      select: {
        id: true,
        firstName: true,
        lastName: true,
      } satisfies Prisma.UserSelect,
    });
    const userLink = wrapUserLinkForNote({
      id: userId,
      firstName: userForNote?.firstName,
      lastName: userForNote?.lastName,
    });

    if (newLocationId && newLocationId.trim() !== "") {
      const { data: location, error: locationError } = await sbDb
        .from("Location")
        .select("id, name")
        .eq("id", newLocationId)
        .maybeSingle();

      if (locationError) {
        throw new ShelfError({
          cause: locationError,
          message: "Failed to fetch location",
          additionalData: { newLocationId },
          label,
        });
      }

      if (location) {
        const locLink = wrapLinkForNote(
          `/locations/${location.id}`,
          location.name
        );

        // Only count kits not already at the target location
        const actuallyMovedKits = kitsWithAssets.filter(
          (k) => k.locationId !== newLocationId
        );

        if (actuallyMovedKits.length > 0) {
          const kitData = actuallyMovedKits.map((k) => ({
            id: k.id,
            name: k.name,
          }));
          const kitMarkup = wrapKitsWithDataForNote(kitData, "added");
          await createSystemLocationNote({
            locationId: location.id,
            content: `${userLink} added ${kitMarkup} to ${locLink}.`,
            userId,
          });
        }

        // Removal notes on previous locations
        const byPrevLoc = new Map<
          string,
          { name: string; kits: Array<{ id: string; name: string }> }
        >();
        for (const kit of actuallyMovedKits) {
          if (!kit.locationId || kit.locationId === newLocationId) continue;
          const prevLocName = kit.location?.name ?? "Unknown location";
          const prevLocId = kit.locationId;
          const existing = byPrevLoc.get(prevLocId);
          if (existing) {
            existing.kits.push({ id: kit.id, name: kit.name });
          } else {
            byPrevLoc.set(prevLocId, {
              name: prevLocName,
              kits: [{ id: kit.id, name: kit.name }],
            });
          }
        }
        for (const [locId, { name, kits }] of byPrevLoc) {
          const prevLocLink = wrapLinkForNote(`/locations/${locId}`, name);
          const kitMarkup = wrapKitsWithDataForNote(kits, "removed");
          const movedTo = ` Moved to ${locLink}.`;
          await createSystemLocationNote({
            locationId: locId,
            content: `${userLink} removed ${kitMarkup} from ${prevLocLink}.${movedTo}`,
            userId,
          });
        }
      }
    } else {
      // Kits removed from location — create removal notes
      const byPrevLoc = new Map<
        string,
        { name: string; kits: Array<{ id: string; name: string }> }
      >();
      for (const kit of kitsWithAssets) {
        if (!kit.locationId) continue;
        const prevLocName = kit.location?.name ?? "Unknown location";
        const existing = byPrevLoc.get(kit.locationId);
        if (existing) {
          existing.kits.push({ id: kit.id, name: kit.name });
        } else {
          byPrevLoc.set(kit.locationId, {
            name: prevLocName,
            kits: [{ id: kit.id, name: kit.name }],
          });
        }
      }
      for (const [locId, { name, kits }] of byPrevLoc) {
        const prevLocLink = wrapLinkForNote(`/locations/${locId}`, name);
        const kitMarkup = wrapKitsWithDataForNote(kits, "removed");
        await createSystemLocationNote({
          locationId: locId,
          content: `${userLink} removed ${kitMarkup} from ${prevLocLink}.`,
          userId,
        });
      }
    }

    return { count: actualKitIds.length };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while updating kit location",
      label,
    });
  }
}

export async function updateKitAssets({
  kitId,
  organizationId,
  userId,
  assetIds,
  request,
  addOnly = false,
}: {
  kitId: Kit["id"];
  organizationId: Organization["id"];
  userId: User["id"];
  assetIds: Asset["id"][];
  request: Request;
  addOnly?: boolean; // If true, only add assets, don't remove existing ones
}) {
  try {
    const user = await getUserByID(userId, {
      select: {
        id: true,
        firstName: true,
        lastName: true,
      } satisfies Prisma.UserSelect,
    });
    const actor = wrapUserLinkForNote({
      id: userId,
      firstName: user?.firstName,
      lastName: user?.lastName,
    });

    // Split deep nested Prisma query into multiple Supabase queries
    const { data: kitRow, error: kitErr } = await sbDb
      .from("Kit")
      .select("*, locationId, status, name, organizationId")
      .eq("id", kitId)
      .eq("organizationId", organizationId)
      .single();
    if (kitErr) {
      throw new ShelfError({
        cause: kitErr,
        message: "Kit not found",
        additionalData: { kitId, userId, organizationId },
        status: 404,
        label: "Kit",
      });
    }

    // Fetch location, assets, custody in parallel
    const [locResult, assetsResult, custodyResult] = await Promise.all([
      kitRow.locationId
        ? sbDb
            .from("Location")
            .select("id, name")
            .eq("id", kitRow.locationId)
            .single()
        : { data: null, error: null },
      sbDb.from("Asset").select("id, title, kitId").eq("kitId", kitId),
      sbDb
        .from("KitCustody")
        .select("id, custodianId")
        .eq("kitId", kitId)
        .maybeSingle(),
    ]);
    if (locResult.error) throw locResult.error;
    if (assetsResult.error) throw assetsResult.error;
    if (custodyResult.error) throw custodyResult.error;

    // Fetch bookings for each asset via junction table
    const assetIdsForBookings = (assetsResult.data ?? []).map((a) => a.id);
    const { data: junctionRows } =
      assetIdsForBookings.length > 0
        ? await sbDb
            .from("_AssetToBooking")
            .select("A, B")
            .in("A", assetIdsForBookings)
        : { data: [] as any[] };
    const bookingIds = [...new Set((junctionRows ?? []).map((r: any) => r.B))];
    let bookingMap = new Map<string, Array<{ id: string; status: string }>>();
    if (bookingIds.length > 0) {
      const { data: bookings } = await sbDb
        .from("Booking")
        .select("id, status")
        .in("id", bookingIds);
      // Build a map from assetId -> bookings
      const bookingById = new Map<string, { id: string; status: string }>();
      (bookings ?? []).forEach((b) => bookingById.set(b.id, b));
      (junctionRows ?? []).forEach((r: any) => {
        const b = bookingById.get(r.B);
        if (b) {
          const existing = bookingMap.get(r.A) ?? [];
          existing.push(b);
          bookingMap.set(r.A, existing);
        }
      });
    }

    // Fetch custodian with user (3+ level nesting)
    let custodianData: {
      id: string;
      name: string;
      user: {
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        profilePicture: string | null;
      } | null;
    } | null = null;
    if (custodyResult.data?.custodianId) {
      const { data: tmRow } = await sbDb
        .from("TeamMember")
        .select("id, name, userId")
        .eq("id", custodyResult.data.custodianId)
        .single();
      if (tmRow) {
        let tmUser = null;
        if (tmRow.userId) {
          const { data: userData } = await sbDb
            .from("User")
            .select("id, email, firstName, lastName, profilePicture")
            .eq("id", tmRow.userId)
            .single();
          tmUser = userData;
        }
        custodianData = {
          id: tmRow.id,
          name: tmRow.name,
          user: tmUser,
        };
      }
    }

    // Fetch full Kit row for each asset (asset.kit) - since all belong to this kit,
    // we can also fetch kits for assets that belong to OTHER kits
    const kitAssetRows = assetsResult.data ?? [];
    const otherKitIds = [
      ...new Set(
        kitAssetRows
          .map((a) => a.kitId)
          .filter((id): id is string => !!id && id !== kitId)
      ),
    ];
    let kitFullMap = new Map<string, any>();
    // The current kit
    kitFullMap.set(kitId, {
      ...kitRow,
      createdAt: new Date(kitRow.createdAt),
      updatedAt: new Date(kitRow.updatedAt),
      imageExpiration: kitRow.imageExpiration
        ? new Date(kitRow.imageExpiration)
        : null,
    });
    if (otherKitIds.length > 0) {
      const { data: otherKits } = await sbDb
        .from("Kit")
        .select("*")
        .in("id", otherKitIds);
      (otherKits ?? []).forEach((k) =>
        kitFullMap.set(k.id, {
          ...k,
          createdAt: new Date(k.createdAt),
          updatedAt: new Date(k.updatedAt),
          imageExpiration: k.imageExpiration
            ? new Date(k.imageExpiration)
            : null,
        })
      );
    }

    const kit = {
      ...kitRow,
      createdAt: new Date(kitRow.createdAt),
      updatedAt: new Date(kitRow.updatedAt),
      imageExpiration: kitRow.imageExpiration
        ? new Date(kitRow.imageExpiration)
        : null,
      location: locResult.data ?? null,
      status: kitRow.status as KitStatus,
      assets: kitAssetRows.map((a) => ({
        id: a.id,
        title: a.title,
        kit: a.kitId ? (kitFullMap.get(a.kitId) ?? null) : null,
        bookings: bookingMap.get(a.id) ?? [],
      })),
      custody: custodyResult.data ? { custodian: custodianData! } : null,
    };

    const kitCustodianDisplay = kit.custody?.custodian
      ? wrapCustodianForNote({ teamMember: kit.custody.custodian })
      : undefined;

    const removedAssets = kit.assets.filter(
      (asset) => !assetIds.includes(asset.id)
    );

    /**
     * If user has selected all assets, then we have to get ids of all those assets
     * with respect to the filters applied.
     * */
    const hasSelectedAll = assetIds.includes(ALL_SELECTED_KEY);
    if (hasSelectedAll) {
      const searchParams = getCurrentSearchParams(request);
      const allAssetIds = await getFilteredAssetIds({
        organizationId,
        currentSearchParams: searchParams.toString(),
      });

      const kitAssets = kit.assets.map((asset) => asset.id);
      const removedAssetsIds = removedAssets.map((asset) => asset.id);

      /**
       * New assets that needs to be added are
       * - Previously added assets
       * - All assets with applied filters
       */
      assetIds = [
        ...new Set([
          ...allAssetIds,
          ...kitAssets.filter((asset) => !removedAssetsIds.includes(asset)),
        ]),
      ];
    }

    // Get all assets that should be in the kit (based on assetIds) with organization scoping
    // Split into: assets -> kit, custody, location fetched separately
    const { data: rawAssetsForKit, error: rawAssetsErr } = await sbDb
      .from("Asset")
      .select("id, title, kitId, locationId")
      .in("id", assetIds)
      .eq("organizationId", organizationId);
    if (rawAssetsErr) {
      throw new ShelfError({
        cause: rawAssetsErr,
        message:
          "Something went wrong while fetching the assets. Please try again or contact support.",
        additionalData: { assetIds, userId, kitId },
        label: "Kit",
      });
    }

    const rawAssets = rawAssetsForKit ?? [];

    // Fetch related data for these assets
    const rawAssetIds = rawAssets.map((a) => a.id);
    const rawKitIds = [
      ...new Set(rawAssets.map((a) => a.kitId).filter(Boolean)),
    ] as string[];
    const rawLocIds = [
      ...new Set(rawAssets.map((a) => a.locationId).filter(Boolean)),
    ] as string[];

    const [custodiesRes, kitsRes, locsRes] = await Promise.all([
      rawAssetIds.length > 0
        ? sbDb
            .from("Custody")
            .select("id, assetId, teamMemberId, createdAt, updatedAt")
            .in("assetId", rawAssetIds)
        : { data: [] as any[], error: null },
      rawKitIds.length > 0
        ? sbDb.from("Kit").select("*").in("id", rawKitIds)
        : { data: [] as any[], error: null },
      rawLocIds.length > 0
        ? sbDb.from("Location").select("id, name").in("id", rawLocIds)
        : { data: [] as any[], error: null },
    ]);
    if (custodiesRes.error) throw custodiesRes.error;
    if (kitsRes.error) throw kitsRes.error;
    if (locsRes.error) throw locsRes.error;

    const custodyByAsset = new Map<string, any>();
    (custodiesRes.data ?? []).forEach((c: any) =>
      custodyByAsset.set(c.assetId, {
        ...c,
        createdAt: new Date(c.createdAt),
        updatedAt: new Date(c.updatedAt),
      })
    );
    const kitById = new Map<string, any>();
    (kitsRes.data ?? []).forEach((k: any) =>
      kitById.set(k.id, {
        ...k,
        createdAt: new Date(k.createdAt),
        updatedAt: new Date(k.updatedAt),
        imageExpiration: k.imageExpiration ? new Date(k.imageExpiration) : null,
      })
    );
    const locById = new Map<string, { id: string; name: string }>();
    (locsRes.data ?? []).forEach((l: any) => locById.set(l.id, l));

    const allAssetsForKit = rawAssets.map((a) => ({
      id: a.id,
      title: a.title,
      kit: a.kitId ? (kitById.get(a.kitId) ?? null) : null,
      custody: custodyByAsset.get(a.id) ?? null,
      location: a.locationId ? (locById.get(a.locationId) ?? null) : null,
    }));

    // Identify which assets are actually new (not already in this kit)
    const newlyAddedAssets = allAssetsForKit.filter(
      (asset) =>
        !kit.assets.some((existingAsset) => existingAsset.id === asset.id)
    );

    /** An asset already in custody cannot be added to a kit */
    const isSomeAssetInCustody = newlyAddedAssets.some(
      (asset) => asset.custody && asset.kit?.id !== kit.id
    );
    if (isSomeAssetInCustody) {
      throw new ShelfError({
        cause: null,
        message:
          "Cannot add assets that are already in custody to a kit. Please release custody of assets to allow them to be added to a kit.",
        additionalData: { userId, kitId },
        label: "Kit",
        shouldBeCaptured: false,
      });
    }

    const kitBookings =
      kit.assets.find((a) => a.bookings.length > 0)?.bookings ?? [];

    // Update asset kitId FKs directly instead of using kit.update with connect/disconnect
    if (!addOnly && removedAssets.length > 0) {
      /** Disconnect assets that should be removed (set kitId to null) */
      const { error: disconnectError } = await sbDb
        .from("Asset")
        .update({ kitId: null })
        .in(
          "id",
          removedAssets.map(({ id }) => id)
        );
      if (disconnectError) throw disconnectError;
    }

    if (newlyAddedAssets.length > 0) {
      /** Connect assets that should be added (set kitId to this kit) */
      const { error: connectError } = await sbDb
        .from("Asset")
        .update({ kitId: kit.id })
        .in(
          "id",
          newlyAddedAssets.map(({ id }) => id)
        );
      if (connectError) throw connectError;
    }

    await createBulkKitChangeNotes({
      kit,
      newlyAddedAssets,
      removedAssets: addOnly ? [] : removedAssets, // In addOnly mode, no assets are removed
      userId,
    });

    // Handle location cascade for newly added assets (after kit assignment notes)
    if (newlyAddedAssets.length > 0) {
      if (kit.location) {
        // Kit has a location, update all newly added assets to that location
        const { error: assetLocUpdateError } = await sbDb
          .from("Asset")
          .update({ locationId: kit.location.id })
          .in(
            "id",
            newlyAddedAssets.map((asset) => asset.id)
          );
        if (assetLocUpdateError) throw assetLocUpdateError;

        // Create notes for assets that had their location changed
        const user = await getUserByID(userId, {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          } satisfies Prisma.UserSelect,
        });
        await Promise.all(
          newlyAddedAssets.map((asset) =>
            createNote({
              content: getKitLocationUpdateNoteContent({
                currentLocation: asset.location,
                newLocation: kit.location,
                userId,
                firstName: user?.firstName ?? "",
                lastName: user?.lastName ?? "",
                isRemoving: false,
              }),
              type: "UPDATE",
              userId,
              assetId: asset.id,
            })
          )
        );
      } else {
        // Kit has no location, remove location from newly added assets
        const assetsWithLocation = newlyAddedAssets.filter(
          (asset) => asset.location
        );

        if (assetsWithLocation.length > 0) {
          const { error: assetLocNullError2 } = await sbDb
            .from("Asset")
            .update({ locationId: null })
            .in(
              "id",
              assetsWithLocation.map((asset) => asset.id)
            );
          if (assetLocNullError2) throw assetLocNullError2;

          // Create notes for assets that had their location removed
          const user = await getUserByID(userId, {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            } satisfies Prisma.UserSelect,
          });
          await Promise.all(
            assetsWithLocation.map((asset) =>
              createNote({
                content: getKitLocationUpdateNoteContent({
                  currentLocation: asset.location,
                  newLocation: null,
                  userId,
                  firstName: user?.firstName ?? "",
                  lastName: user?.lastName ?? "",
                  isRemoving: true,
                }),
                type: "UPDATE",
                userId,
                assetId: asset.id,
              })
            )
          );
        }
      }
    }

    /**
     * If a kit is in custody then the assets added to kit will also inherit the status
     */
    const assetsToInheritStatus = newlyAddedAssets.filter(
      (asset) => !asset.custody
    );

    if (
      kit.custody &&
      kit.custody.custodian.id &&
      assetsToInheritStatus.length > 0
    ) {
      // Update custody for all assets to inherit kit's custody
      const assetIdsForCustody = assetsToInheritStatus.map((a) => a.id);

      // 1) Set all assets to IN_CUSTODY status
      const { error: custodyStatusError } = await sbDb
        .from("Asset")
        .update({ status: AssetStatus.IN_CUSTODY })
        .in("id", assetIdsForCustody)
        .eq("organizationId", organizationId);
      if (custodyStatusError) throw custodyStatusError;

      // 2) Create custody records for each asset
      const { error: custodyCreateError } = await sbDb.from("Custody").insert(
        assetIdsForCustody.map((assetId) => ({
          id: id(),
          assetId,
          teamMemberId: kit.custody!.custodian.id,
        }))
      );
      if (custodyCreateError) throw custodyCreateError;

      // Create notes for all assets that inherited custody
      const custodianDisplay = kitCustodianDisplay ?? "**Unknown Custodian**";
      await createNotes({
        content: `${actor} granted ${custodianDisplay} custody.`,
        type: NoteType.UPDATE,
        userId,
        assetIds: assetsToInheritStatus.map((asset) => asset.id),
      });
    }

    /**
     * If a kit is in custody and some assets are removed,
     * then we have to make the removed assets Available
     * Only apply this when not in addOnly mode
     */
    if (!addOnly && removedAssets.length && kit.custody?.custodian.id) {
      const custodianDisplay = kitCustodianDisplay ?? "**Unknown Custodian**";
      const assetIds = removedAssets.map((a) => a.id);

      // Use RPC for atomicity - prevents orphaned custody records
      const { error: rpcError } = await sbDb.rpc(
        "shelf_kit_release_removed_assets",
        {
          p_asset_ids: assetIds,
          p_org_id: organizationId,
        }
      );
      if (rpcError) throw rpcError;

      // Notes can be created outside transaction (not critical for consistency)
      await createNotes({
        content: `${actor} released ${custodianDisplay}'s custody.`,
        type: NoteType.UPDATE,
        userId,
        assetIds,
      });
    }

    /**
     * If user is adding/removing an asset to a kit which is a part of DRAFT, RESERVED, ONGOING or OVERDUE booking,
     * then we have to add or remove these assets to booking also
     */
    const bookingsToUpdate = kitBookings.filter(
      (b) =>
        b.status === "DRAFT" ||
        b.status === "RESERVED" ||
        b.status === "ONGOING" ||
        b.status === "OVERDUE"
    );

    if (bookingsToUpdate?.length) {
      // Many-to-many connect/disconnect via _AssetToBooking junction table
      const connectRows: Array<{ A: string; B: string }> = [];
      const disconnectPairs: Array<{
        assetId: string;
        bookingId: string;
      }> = [];

      for (const booking of bookingsToUpdate) {
        for (const asset of newlyAddedAssets) {
          connectRows.push({ A: asset.id, B: booking.id });
        }
        for (const asset of removedAssets) {
          disconnectPairs.push({
            assetId: asset.id,
            bookingId: booking.id,
          });
        }
      }

      const ops: PromiseLike<any>[] = [];
      if (connectRows.length > 0) {
        // Upsert to avoid unique constraint violations if already linked
        ops.push(
          sbDb
            .from("_AssetToBooking")
            .upsert(connectRows, { onConflict: "A,B" })
            .then(({ error }) => {
              if (error) throw error;
            })
        );
      }
      if (disconnectPairs.length > 0) {
        // Delete junction rows for each asset-booking pair
        ops.push(
          ...disconnectPairs.map(({ assetId, bookingId }) =>
            sbDb
              .from("_AssetToBooking")
              .delete()
              .eq("A", assetId)
              .eq("B", bookingId)
              .then(({ error }) => {
                if (error) throw error;
              })
          )
        );
      }
      await Promise.all(ops);
    }

    /**
     * If the kit is part of an ONGOING booking, then we have to make all
     * the assets CHECKED_OUT
     */
    if (kit.status === KitStatus.CHECKED_OUT) {
      const { error: checkoutError } = await sbDb
        .from("Asset")
        .update({ status: AssetStatus.CHECKED_OUT })
        .in(
          "id",
          newlyAddedAssets.map((a) => a.id)
        );
      if (checkoutError) throw checkoutError;
    }

    return kit;
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);

    throw new ShelfError({
      cause,
      message: isShelfError
        ? cause.message
        : "Something went wrong while updating kit assets.",
      label,
      additionalData: { kitId, assetIds },
    });
  }
}

export async function bulkRemoveAssetsFromKits({
  assetIds,
  organizationId,
  userId,
  request,
  settings,
}: {
  assetIds: Asset["id"][];
  organizationId: Organization["id"];
  userId: User["id"];
  request: Request;
  settings: AssetIndexSettingsRow;
}) {
  try {
    const user = await getUserByID(userId, {
      select: {
        id: true,
        firstName: true,
        lastName: true,
      } satisfies Prisma.UserSelect,
    });
    const actor = wrapUserLinkForNote({
      id: userId,
      firstName: user?.firstName,
      lastName: user?.lastName,
    });

    // Resolve IDs (works for both simple and advanced mode)
    const searchParams = getCurrentSearchParams(request);
    const resolvedIds = await resolveAssetIdsForBulkOperation({
      assetIds,
      organizationId,
      currentSearchParams: searchParams.toString(),
      settings,
    });

    // Split nested Prisma query into multiple Supabase queries
    const { data: rawBulkAssets, error: rawBulkErr } = await sbDb
      .from("Asset")
      .select("id, title, kitId")
      .in("id", resolvedIds)
      .eq("organizationId", organizationId);
    if (rawBulkErr) throw rawBulkErr;

    const bulkAssetIds = (rawBulkAssets ?? []).map((a) => a.id);
    const bulkKitIds = [
      ...new Set((rawBulkAssets ?? []).map((a) => a.kitId).filter(Boolean)),
    ] as string[];

    // Fetch kit data (id, name) + kit custodies + asset custodies in parallel
    const [bulkKitsRes, bulkKitCustodiesRes, bulkAssetCustodiesRes] =
      await Promise.all([
        bulkKitIds.length > 0
          ? sbDb.from("Kit").select("id, name").in("id", bulkKitIds)
          : { data: [] as any[], error: null },
        bulkKitIds.length > 0
          ? sbDb.from("KitCustody").select("id, kitId").in("kitId", bulkKitIds)
          : { data: [] as any[], error: null },
        bulkAssetIds.length > 0
          ? sbDb
              .from("Custody")
              .select("id, assetId, teamMemberId")
              .in("assetId", bulkAssetIds)
          : { data: [] as any[], error: null },
      ]);
    if (bulkKitsRes.error) throw bulkKitsRes.error;
    if (bulkKitCustodiesRes.error) throw bulkKitCustodiesRes.error;
    if (bulkAssetCustodiesRes.error) throw bulkAssetCustodiesRes.error;

    // Build kit map: id -> { id, name, custody: { id } | null }
    const bulkKitMap = new Map<
      string,
      { id: string; name: string; custody: { id: string } | null }
    >();
    (bulkKitsRes.data ?? []).forEach((k: any) => {
      const kitCustody = (bulkKitCustodiesRes.data ?? []).find(
        (c: any) => c.kitId === k.id
      );
      bulkKitMap.set(k.id, {
        id: k.id,
        name: k.name,
        custody: kitCustody ? { id: kitCustody.id } : null,
      });
    });

    // Fetch custodian + user for asset custodies (3+ level nesting)
    const tmIdsForCustody = [
      ...new Set(
        (bulkAssetCustodiesRes.data ?? []).map(
          (c: any) => c.teamMemberId as string
        )
      ),
    ];
    let tmCustodianMap = new Map<
      string,
      {
        name: string;
        user: {
          id: string;
          firstName: string | null;
          lastName: string | null;
        } | null;
      }
    >();
    if (tmIdsForCustody.length > 0) {
      const { data: tmRows } = await sbDb
        .from("TeamMember")
        .select("id, name, userId")
        .in("id", tmIdsForCustody);
      const tmUserIds = (tmRows ?? [])
        .map((t) => t.userId)
        .filter(Boolean) as string[];
      let tmUserMap = new Map<string, any>();
      if (tmUserIds.length > 0) {
        const { data: users } = await sbDb
          .from("User")
          .select("id, firstName, lastName")
          .in("id", tmUserIds);
        (users ?? []).forEach((u) => tmUserMap.set(u.id, u));
      }
      (tmRows ?? []).forEach((tm) => {
        tmCustodianMap.set(tm.id, {
          name: tm.name,
          user: tm.userId ? (tmUserMap.get(tm.userId) ?? null) : null,
        });
      });
    }

    // Build asset custody map
    const bulkAssetCustodyMap = new Map<
      string,
      {
        id: string;
        custodian: {
          name: string;
          user: {
            id: string;
            firstName: string | null;
            lastName: string | null;
          } | null;
        } | null;
      }
    >();
    (bulkAssetCustodiesRes.data ?? []).forEach((c: any) => {
      bulkAssetCustodyMap.set(c.assetId, {
        id: c.id,
        custodian: tmCustodianMap.get(c.teamMemberId) ?? null,
      });
    });

    const assets = (rawBulkAssets ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      kit: a.kitId ? (bulkKitMap.get(a.kitId) ?? null) : null,
      custody: bulkAssetCustodyMap.get(a.id) ?? null,
    }));

    /** Pre-compute all data needed for the atomic RPC call */
    const assetsWhoseKitsInCustody = assets.filter(
      (asset) => !!asset.kit?.custody && asset.custody
    );

    const custodyIdsToDelete = assetsWhoseKitsInCustody.map((a) => {
      invariant(a.custody, "Custody not found over asset");
      return a.custody.id;
    });

    // Pre-compute custody release note contents
    const custodyNoteAssetIds = assetsWhoseKitsInCustody.map((a) => a.id);
    const custodyNoteContents = assetsWhoseKitsInCustody.map((asset) => {
      const custodianDisplay = asset.custody?.custodian
        ? wrapCustodianForNote({ teamMember: asset.custody.custodian })
        : "**Unknown Custodian**";
      return `${actor} released ${custodianDisplay}'s custody.`;
    });

    // Pre-compute kit removal note contents
    const assetsRemovedFromKit = assets.filter((asset) => asset.kit);
    const kitNoteAssetIds = assetsRemovedFromKit.map((a) => a.id);
    const kitNoteContents = assetsRemovedFromKit.map((asset) => {
      const kitLink = wrapLinkForNote(
        `/kits/${asset.kit!.id}`,
        asset.kit!.name.trim()
      );
      return `${actor} removed asset from ${kitLink}.`;
    });

    /** Atomically remove assets from kits via RPC */
    const { error: rpcError } = await sbDb.rpc("shelf_kit_bulk_remove_assets", {
      p_all_asset_ids: assets.map((a) => a.id),
      p_custody_ids_to_delete: custodyIdsToDelete,
      p_user_id: userId,
      p_custody_note_asset_ids: custodyNoteAssetIds,
      p_custody_note_contents: custodyNoteContents,
      p_kit_note_asset_ids: kitNoteAssetIds,
      p_kit_note_contents: kitNoteContents,
    });
    if (rpcError) throw rpcError;

    return true;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to bulk remove assets from kits",
      additionalData: { assetIds, organizationId, userId },
      label: "Kit",
    });
  }
}
