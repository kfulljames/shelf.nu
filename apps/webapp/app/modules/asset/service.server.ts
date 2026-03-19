import type {
  Category,
  Location,
  Note,
  Qr,
  Asset,
  User,
  Tag,
  Organization,
  TeamMember,
  Booking,
  Kit,
  UserOrganization,
  BarcodeType,
  TagUseFor,
} from "@prisma/client";
import {
  AssetStatus,
  BookingStatus,
  ErrorCorrection,
  KitStatus,
  Prisma,
} from "@prisma/client";
import { LRUCache } from "lru-cache";
import type { LoaderFunctionArgs } from "react-router";
import { extractStoragePath } from "~/components/assets/asset-image/utils";
import type {
  SortingDirection,
  SortingOptions,
} from "~/components/list/filters/sort-by";
import { db } from "~/database/db.server";
import { sbDb } from "~/database/supabase.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import type { AssetIndexSettingsRow } from "~/modules/asset-index-settings/service.server";
import {
  updateBarcodes,
  validateBarcodeUniqueness,
  parseBarcodesFromImportData,
} from "~/modules/barcode/service.server";
import { normalizeBarcodeValue } from "~/modules/barcode/validation";
import { createCategoriesIfNotExists } from "~/modules/category/service.server";
import {
  createCustomFieldsIfNotExists,
  getActiveCustomFields,
  upsertCustomField,
} from "~/modules/custom-field/service.server";
import type { CustomFieldDraftPayload } from "~/modules/custom-field/types";
import {
  createLocationChangeNote,
  createLocationsIfNotExists,
} from "~/modules/location/service.server";
import { createLoadUserForNotes } from "~/modules/note/load-user-for-notes.server";
import { getQr, parseQrCodesFromImportData } from "~/modules/qr/service.server";
import { createTagsIfNotExists } from "~/modules/tag/service.server";
import {
  createTeamMemberIfNotExists,
  getTeamMemberForCustodianFilter,
} from "~/modules/team-member/service.server";
import type { AllowedModelNames } from "~/routes/api+/model-filters";
import { getLocale } from "~/utils/client-hints";
import {
  ASSET_MAX_IMAGE_UPLOAD_SIZE,
  LEGACY_CUID_LENGTH,
} from "~/utils/constants";
import {
  getFiltersFromRequest,
  setCookie,
  updateCookieWithPerPage,
  userPrefs,
} from "~/utils/cookies.server";
import {
  buildCustomFieldValue,
  extractCustomFieldValuesFromPayload,
  formatInvalidNumericCustomFieldMessage,
  getDefinitionFromCsvHeader,
} from "~/utils/custom-fields";
import { dateTimeInUnix } from "~/utils/date-time-in-unix";
import type { ErrorLabel } from "~/utils/error";
import {
  ShelfError,
  isLikeShelfError,
  isNotFoundError,
  maybeUniqueConstraintViolation,
  VALIDATION_ERROR,
} from "~/utils/error";
import { getRedirectUrlFromRequest } from "~/utils/http";
import { getCurrentSearchParams } from "~/utils/http.server";
import { id } from "~/utils/id/id.server";
import { detectImageFormat } from "~/utils/image-format.server";
import * as importImageCacheServer from "~/utils/import.image-cache.server";
import type { CachedImage } from "~/utils/import.image-cache.server";
import { getParamsValues } from "~/utils/list";
import { Logger } from "~/utils/logger";
import {
  wrapUserLinkForNote,
  wrapCustodianForNote,
  wrapAssetsWithDataForNote,
  wrapLinkForNote,
} from "~/utils/markdoc-wrappers";
import { isValidImageUrl } from "~/utils/misc";
import { oneDayFromNow } from "~/utils/one-week-from-now";
import {
  createSignedUrl,
  parseFileFormData,
  uploadImageFromUrl,
} from "~/utils/storage.server";
import { resolveTeamMemberName } from "~/utils/user";
import { resolveAssetIdsForBulkOperation } from "./bulk-operations-helper.server";
import { assetIndexFields } from "./fields";
import {
  CUSTOM_FIELD_SEARCH_PATHS,
  assetQueryFragment,
  assetQueryJoins,
  assetReturnFragment,
  generateCustomFieldSelect,
  generateWhereClause,
  parseFiltersWithHierarchy,
  parseSortingOptions,
} from "./query.server";
import { getNextSequentialId } from "./sequential-id.server";
import type {
  AdvancedIndexAsset,
  AdvancedIndexQueryResult,
  CreateAssetFromBackupImportPayload,
  CreateAssetFromContentImportPayload,
  ShelfAssetCustomFieldValueType,
  UpdateAssetPayload,
} from "./types";
import {
  getLocationUpdateNoteContent,
  getCustomFieldUpdateNoteContent,
  detectPotentialChanges,
  detectCustomFieldChanges,
  type CustomFieldChangeInfo,
} from "./utils.server";
import type { Column } from "../asset-index-settings/helpers";
import { cancelAssetReminderScheduler } from "../asset-reminder/scheduler.server";
import { createKitsIfNotExists } from "../kit/service.server";
import { createSystemLocationNote } from "../location-note/service.server";
import {
  createAssetCategoryChangeNote,
  createAssetDescriptionChangeNote,
  createAssetNameChangeNote,
  createAssetValuationChangeNote,
  createNote,
  createTagChangeNoteIfNeeded,
  type TagSummary,
} from "../note/service.server";
import { getUserByID } from "../user/service.server";

const label: ErrorLabel = "Assets";

/**
 * Fetches the snapshot of fields required to build change notes before an update.
 */
async function fetchAssetBeforeUpdate({
  id,
  organizationId,
  shouldFetch,
}: {
  id: Asset["id"];
  organizationId: Asset["organizationId"];
  shouldFetch: boolean;
}) {
  if (!shouldFetch) {
    return null;
  }

  // Split into sequential queries to avoid deep nesting
  const { data: asset, error: assetError } = await sbDb
    .from("Asset")
    .select("title, description, categoryId, value")
    .eq("id", id)
    .eq("organizationId", organizationId)
    .maybeSingle();

  if (assetError) throw assetError;
  if (!asset) return null;

  // Fetch category, organization, and tags in parallel
  const [categoryResult, orgResult, tagsResult] = await Promise.all([
    asset.categoryId
      ? sbDb
          .from("Category")
          .select("id, name, color")
          .eq("id", asset.categoryId)
          .maybeSingle()
          .then(({ data, error }) => {
            if (error) throw error;
            return data;
          })
      : Promise.resolve(null),
    sbDb
      .from("Organization")
      .select("currency")
      .eq(
        "id",
        // We need the organizationId from the asset's org
        organizationId
      )
      .single()
      .then(({ data, error }) => {
        if (error) throw error;
        return data;
      }),
    sbDb
      .from("_AssetToTag")
      .select("B")
      .eq("A", id)
      .then(async ({ data: joinRows, error: joinError }) => {
        if (joinError) throw joinError;
        if (!joinRows || joinRows.length === 0) return [];
        const tagIds = joinRows.map((r) => r.B);
        const { data: tags, error: tagError } = await sbDb
          .from("Tag")
          .select("id, name")
          .in("id", tagIds);
        if (tagError) throw tagError;
        return tags ?? [];
      }),
  ]);

  return {
    title: asset.title,
    description: asset.description,
    category: categoryResult,
    valuation: asset.value,
    organization: orgResult!,
    tags: tagsResult,
  };
}

/**
 * Sets kit custody for imported assets after all assets have been created
 */
async function setKitCustodyAfterAssetImport({
  data,
  kits,
  teamMembers,
}: {
  data: CreateAssetFromContentImportPayload[];
  kits: Record<string, Kit>;
  teamMembers: Record<string, { id: string; name: string }>;
}) {
  // Normalize kit/custodian names so padded CSV values still map to created records.
  const assetsWithKitAndCustodian = data
    .map((asset) => ({
      kit: asset.kit?.trim(),
      custodian: asset.custodian?.trim(),
    }))
    .filter((asset) => asset.kit && asset.custodian);

  if (assetsWithKitAndCustodian.length === 0) {
    return; // Nothing to do
  }

  // Group by kit name and get the custodian for each kit
  const kitToCustodianMap = new Map<string, string>();
  for (const asset of assetsWithKitAndCustodian) {
    const kitName = asset.kit!;
    const custodianName = asset.custodian!;
    if (!kitToCustodianMap.has(kitName)) {
      kitToCustodianMap.set(kitName, custodianName);
    }
  }

  // Update kit custody - one update per kit instead of per asset for performance
  for (const [kitName, custodianName] of kitToCustodianMap) {
    const kit = kits[kitName];
    const teamMember = teamMembers[custodianName];

    if (kit && teamMember) {
      // Update kit status and create custody in parallel
      await Promise.all([
        sbDb
          .from("Kit")
          .update({ status: KitStatus.IN_CUSTODY })
          .eq("id", kit.id)
          .then(({ error }) => {
            if (error) throw error;
          }),
        sbDb
          .from("KitCustody")
          .insert({ kitId: kit.id, custodianId: teamMember.id })
          .then(({ error }) => {
            if (error) throw error;
          }),
      ]);
    }
  }
}

/**
 * Validates custody conflicts for kits during import.
 * This includes:
 * - Assets with custody being imported into kits that exist but are not in custody,
 * - Existing kits with different custodians,
 * - Multiple custodians assigned to the same kit within the same import.
 */
async function validateKitCustodyConflicts({
  data,
  organizationId,
}: {
  data: CreateAssetFromContentImportPayload[];
  organizationId: Organization["id"];
}) {
  // Extract assets that have both a kit and a custodian
  // Normalize kit/custodian names so padded CSV values don't bypass conflict checks.
  const conflictCandidates = data
    .map((asset) => ({
      title: asset.title,
      kit: asset.kit?.trim(),
      custodian: asset.custodian?.trim(),
    }))
    .filter((asset) => asset.kit && asset.custodian);

  if (conflictCandidates.length === 0) {
    return; // No conflicts possible
  }

  // Get unique kit names that might have conflicts
  const kitNames = [
    ...new Set(conflictCandidates.map((asset) => asset.kit)),
  ].filter(Boolean) as string[];

  // Fetch existing kits and their custody status using split queries
  const { data: kitRows, error: kitError } = await sbDb
    .from("Kit")
    .select("id, name")
    .in("name", kitNames)
    .eq("organizationId", organizationId);

  if (kitError) throw kitError;

  const kitIds = (kitRows ?? []).map((k) => k.id);

  // Fetch custody (with custodian name) and asset counts in parallel
  const [custodyRows, assetCountRows] = await Promise.all([
    sbDb
      .from("KitCustody")
      .select("id, kitId, custodianId")
      .in("kitId", kitIds)
      .then(async ({ data: custodies, error: custodyErr }) => {
        if (custodyErr) throw custodyErr;
        if (!custodies || custodies.length === 0) return [];
        const custodianIds = custodies.map((c) => c.custodianId);
        const { data: members, error: memErr } = await sbDb
          .from("TeamMember")
          .select("id, name")
          .in("id", custodianIds);
        if (memErr) throw memErr;
        const memberMap = new Map((members ?? []).map((m) => [m.id, m]));
        return custodies.map((c) => ({
          ...c,
          custodian: memberMap.get(c.custodianId) ?? { name: "" },
        }));
      }),
    sbDb
      .from("Asset")
      .select("id, kitId")
      .in("kitId", kitIds)
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      }),
  ]);

  // Build a map of kitId -> asset count
  const assetCountByKit = new Map<string, number>();
  for (const row of assetCountRows) {
    if (row.kitId) {
      assetCountByKit.set(row.kitId, (assetCountByKit.get(row.kitId) ?? 0) + 1);
    }
  }

  // Build custody map by kitId
  const custodyByKit = new Map(custodyRows.map((c) => [c.kitId, c]));

  // Assemble existingKits in the same shape expected downstream
  const existingKits = (kitRows ?? []).map((kit) => ({
    id: kit.id,
    name: kit.name,
    custody: custodyByKit.get(kit.id) ?? null,
    assets: Array.from(
      { length: assetCountByKit.get(kit.id) ?? 0 },
      (_, i) => ({ id: String(i) })
    ),
  }));

  // Find conflicts: existing kits without custody that would receive assets with custody
  const conflicts: Array<{
    asset: string;
    custodian: string;
    kit: string;
    issue: string;
  }> = [];
  const existingKitsMap = new Map(existingKits.map((kit) => [kit.name, kit]));

  // Check for conflicts within the import data itself - assets going to same kit with different custodians
  const kitToCustodiansMap = new Map<string, Set<string>>();
  for (const asset of conflictCandidates) {
    if (!kitToCustodiansMap.has(asset.kit!)) {
      kitToCustodiansMap.set(asset.kit!, new Set());
    }
    kitToCustodiansMap.get(asset.kit!)!.add(asset.custodian!);
  }

  // Add conflicts for kits with multiple custodians in the same import
  for (const [kitName, custodians] of kitToCustodiansMap) {
    if (custodians.size > 1) {
      const custodiansArray = Array.from(custodians);
      const assetsForThisKit = conflictCandidates.filter(
        (asset) => asset.kit === kitName
      );

      for (const asset of assetsForThisKit) {
        conflicts.push({
          asset: asset.title,
          custodian: asset.custodian!,
          kit: asset.kit!,
          issue: `Kit has assets with multiple custodians: ${custodiansArray.join(
            ", "
          )}`,
        });
      }
    }
  }

  for (const asset of conflictCandidates) {
    const existingKit = existingKitsMap.get(asset.kit!);

    if (existingKit) {
      if (!existingKit.custody && existingKit.assets.length > 0) {
        conflicts.push({
          asset: asset.title,
          custodian: asset.custodian!,
          kit: asset.kit!,
          issue: `Kit exists without custody but has ${
            existingKit.assets.length
          } existing asset${existingKit.assets.length === 1 ? "" : "s"}`,
        });
      } else if (existingKit.custody) {
        conflicts.push({
          asset: asset.title,
          custodian: asset.custodian!,
          kit: asset.kit!,
          issue: `Kit already has a custodian (${existingKit.custody.custodian.name}). Importing custody for kits that already have a custodian is not allowed`,
        });
      }
    }
  }

  if (conflicts.length > 0) {
    throw new ShelfError({
      cause: null,
      message: `We found custody conflicts with existing kits. Assets with custody cannot be imported into existing kits that are not in custody.`,
      additionalData: {
        kitCustodyConflicts: conflicts,
      },
      label: "Assets",
      status: 400,
      shouldBeCaptured: false,
    });
  }
}

type AssetWithInclude<T extends Prisma.AssetInclude | undefined> =
  T extends Prisma.AssetInclude
    ? Prisma.AssetGetPayload<{ include: T }>
    : Asset;

export async function getAsset<T extends Prisma.AssetInclude | undefined>({
  id,
  organizationId,
  userOrganizations,
  request,
  include,
}: Pick<Asset, "id"> & {
  organizationId: Asset["organizationId"];
  userOrganizations?: Pick<UserOrganization, "organizationId">[];
  request?: Request;
  include?: T;
}): Promise<AssetWithInclude<T>> {
  try {
    const otherOrganizationIds = userOrganizations?.map(
      (org) => org.organizationId
    );

    // KEPT AS PRISMA: Dynamic generic `include` parameter varies per caller
    const asset = await db.asset.findFirstOrThrow({
      where: {
        OR: [
          { id, organizationId },
          ...(userOrganizations?.length
            ? [{ id, organizationId: { in: otherOrganizationIds } }]
            : []),
        ],
      },
      include: { ...include },
    });

    /* User is accessing the asset in the wrong organization. In that case we need special 404 handling. */
    if (
      userOrganizations?.length &&
      asset.organizationId !== organizationId &&
      otherOrganizationIds?.includes(asset.organizationId)
    ) {
      const redirectTo =
        typeof request !== "undefined"
          ? getRedirectUrlFromRequest(request)
          : undefined;

      throw new ShelfError({
        cause: null,
        title: "Asset not found",
        message: "",
        additionalData: {
          model: "asset",
          organization: userOrganizations.find(
            (org) => org.organizationId === asset.organizationId
          ),
          redirectTo,
        },
        label,
        status: 404,
        shouldBeCaptured: false, // In this case we shouldnt be capturing the error
      });
    }

    return asset as AssetWithInclude<T>;
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);
    throw new ShelfError({
      cause,
      title: "Asset not found",
      message:
        "The asset you are trying to access does not exist or you do not have permission to access it.",
      additionalData: {
        id,
        organizationId,
        ...(isShelfError ? cause.additionalData : {}),
      },
      label,
      shouldBeCaptured: isShelfError
        ? cause.shouldBeCaptured
        : !isNotFoundError(cause),
    });
  }
}

/** This is used by both  getAssetsFromView & getAssets
 * Those are the statuses that are considered unavailable for booking assets
 */
const unavailableBookingStatuses = [
  BookingStatus.RESERVED,
  BookingStatus.ONGOING,
  BookingStatus.OVERDUE,
];

/**
 * Fetches assets directly from the asset table with enhanced search capabilities
 * @param params Search and filtering parameters for asset queries
 * @returns Assets and total count matching the criteria
 */
export async function getAssets(params: {
  organizationId: Organization["id"];
  page: number;
  orderBy: SortingOptions;
  orderDirection: SortingDirection;
  perPage?: number;
  search?: string | null;
  categoriesIds?: Category["id"][] | null;
  locationIds?: Location["id"][] | null;
  tagsIds?: Tag["id"][] | null;
  status?: Asset["status"] | null;
  hideUnavailable?: Asset["availableToBook"];
  bookingFrom?: Booking["from"];
  bookingTo?: Booking["to"];
  unhideAssetsBookigIds?: Booking["id"][];
  teamMemberIds?: TeamMember["id"][] | null;
  extraInclude?: Prisma.AssetInclude;
  /**
   * Hide all assets that cannot currently be added to kit.
   * This includes:
   * - assets in custody
   * - assets that are checkedout
   * */
  hideUnavailableToAddToKit?: boolean;
  assetKitFilter?: string | null;
  availableToBookOnly?: boolean;
}) {
  let {
    organizationId,
    orderBy,
    orderDirection,
    page = 1,
    perPage = 8,
    search,
    categoriesIds,
    locationIds,
    tagsIds,
    status,
    bookingFrom,
    bookingTo,
    hideUnavailable,
    unhideAssetsBookigIds,
    teamMemberIds,
    extraInclude,
    assetKitFilter,
    availableToBookOnly,
  } = params;

  try {
    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = perPage >= 1 && perPage <= 100 ? perPage : 20;

    const where: Prisma.AssetWhereInput = { organizationId };

    if (availableToBookOnly) {
      where.availableToBook = true;
    }

    if (search) {
      const searchTerms = search
        .toLowerCase()
        .trim()
        .split(",")
        .map((term) => term.trim())
        .filter(Boolean);

      where.OR = searchTerms.map((term) => ({
        OR: [
          // Search in asset fields
          { title: { contains: term, mode: "insensitive" } },
          // Search in asset sequential id
          { sequentialId: { contains: term, mode: "insensitive" } },
          // Search in asset description
          { description: { contains: term, mode: "insensitive" } },
          // Search in related category
          { category: { name: { contains: term, mode: "insensitive" } } },
          // Search in related location
          { location: { name: { contains: term, mode: "insensitive" } } },
          // Search in related tags
          { tags: { some: { name: { contains: term, mode: "insensitive" } } } },
          // Search in custodian names
          {
            custody: {
              custodian: {
                OR: [
                  { name: { contains: term, mode: "insensitive" } },
                  {
                    user: {
                      OR: [
                        { firstName: { contains: term, mode: "insensitive" } },
                        { lastName: { contains: term, mode: "insensitive" } },
                      ],
                    },
                  },
                ],
              },
            },
          },
          // Search qr code id
          {
            qrCodes: { some: { id: { contains: term, mode: "insensitive" } } },
          },
          // Search barcode values
          {
            barcodes: {
              some: { value: { contains: term, mode: "insensitive" } },
            },
          },
          // Search in custom fields
          {
            customFields: {
              some: {
                OR: CUSTOM_FIELD_SEARCH_PATHS.map((jsonPath) => ({
                  value: {
                    path: [jsonPath],
                    string_contains: term,
                    mode: "insensitive",
                  },
                })),
              },
            },
          },
        ],
      }));
    }

    if (status) {
      where.status = status;
    }

    if (categoriesIds?.length) {
      if (categoriesIds.includes("uncategorized")) {
        where.OR = [
          ...(where.OR ?? []),
          { categoryId: { in: categoriesIds } },
          { categoryId: null },
        ];
      } else {
        where.categoryId = { in: categoriesIds };
      }
    }

    if (hideUnavailable) {
      //not disabled for booking
      where.availableToBook = true;
      //not assigned to team meber
      where.custody = null;
      if (bookingFrom && bookingTo) {
        where.AND = [
          // Rule 1: Exclude assets from RESERVED bookings (all assets unavailable)
          {
            bookings: {
              none: {
                ...(unhideAssetsBookigIds?.length && {
                  id: { notIn: unhideAssetsBookigIds },
                }),
                status: BookingStatus.RESERVED,
                OR: [
                  { from: { lte: bookingTo }, to: { gte: bookingFrom } },
                  { from: { gte: bookingFrom }, to: { lte: bookingTo } },
                ],
              },
            },
          },
          // Rule 2: For ONGOING/OVERDUE bookings, only exclude CHECKED_OUT assets
          {
            OR: [
              // Either asset is AVAILABLE (checked in from partial check-in)
              { status: AssetStatus.AVAILABLE },
              // Or asset has no conflicting ONGOING/OVERDUE bookings
              {
                bookings: {
                  none: {
                    ...(unhideAssetsBookigIds?.length && {
                      id: { notIn: unhideAssetsBookigIds },
                    }),
                    status: {
                      in: [BookingStatus.ONGOING, BookingStatus.OVERDUE],
                    },
                    OR: [
                      { from: { lte: bookingTo }, to: { gte: bookingFrom } },
                      { from: { gte: bookingFrom }, to: { lte: bookingTo } },
                    ],
                  },
                },
              },
            ],
          },
        ];
      }
    }
    if (hideUnavailable === true && (!bookingFrom || !bookingTo)) {
      throw new ShelfError({
        cause: null,
        message: "booking dates are needed to hide unavailable assets",
        additionalData: {
          hideUnavailable,
          bookingFrom,
          bookingTo,
        },
        label,
      });
    }
    if (bookingFrom && bookingTo) {
      where.availableToBook = true;
    }

    if (tagsIds && tagsIds.length) {
      // Check if 'untagged' is part of the selected tag IDs
      if (tagsIds.includes("untagged")) {
        // Remove 'untagged' from the list of tags
        tagsIds = tagsIds.filter((id) => id !== "untagged");

        // Filter for assets that are untagged only
        where.OR = [
          ...(where.OR || []), // Preserve existing AND conditions if any
          { tags: { none: {} } }, // Include assets with no tags
        ];
      }

      // If there are other tags specified, apply AND condition
      if (tagsIds.length > 0) {
        where.OR = [
          ...(where.OR || []), // Preserve existing AND conditions if any
          { tags: { some: { id: { in: tagsIds } } } }, // Filter by remaining tags
        ];
      }
    }

    if (locationIds && locationIds.length > 0) {
      if (locationIds.includes("without-location")) {
        where.OR = [
          ...(where.OR ?? []),
          { locationId: { in: locationIds } },
          { locationId: null },
        ];
      } else {
        where.location = {
          id: { in: locationIds },
        };
      }
    }

    /**
     * User should only see the assets without kits for hideUnavailable true
     */
    if (hideUnavailable === true) {
      where.kit = null;
    }

    if (teamMemberIds && teamMemberIds.length) {
      where.OR = [
        ...(where.OR ?? []),
        {
          custody: { teamMemberId: { in: teamMemberIds } },
        },
        { custody: { custodian: { userId: { in: teamMemberIds } } } },
        {
          bookings: {
            some: {
              custodianTeamMemberId: { in: teamMemberIds },
              /** We only get them if the booking is ongoing */
              status: {
                in: [BookingStatus.ONGOING, BookingStatus.OVERDUE],
              },
            },
          },
        },
        {
          bookings: {
            some: {
              custodianUserId: { in: teamMemberIds },
              /** We only get them if the booking is ongoing */
              status: {
                in: [BookingStatus.ONGOING, BookingStatus.OVERDUE],
              },
            },
          },
        },
        ...(teamMemberIds.includes("without-custody")
          ? [{ custody: null }]
          : []),
      ];
    }

    if (assetKitFilter === "NOT_IN_KIT") {
      where.kit = null;
    } else if (assetKitFilter === "IN_OTHER_KITS") {
      where.kit = { isNot: null };
    }

    // KEPT AS PRISMA: Dynamic where with nested relations (tags, custody,
    // bookings) + dynamic include from assetIndexFields and extraInclude
    const [assets, totalAssets] = await Promise.all([
      db.asset.findMany({
        skip,
        take,
        where,
        include: {
          ...assetIndexFields({
            bookingFrom,
            bookingTo,
            unavailableBookingStatuses,
          }),
          ...extraInclude,
        },
        orderBy: { [orderBy]: orderDirection },
      }),
      db.asset.count({ where }),
    ]);

    return { assets, totalAssets };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while fetching assets",
      additionalData: { ...params },
      label,
    });
  }
}

/**
 * Fetches filtered and paginated assets for advanced asset index view.
 * @param request - The incoming request
 * @param organizationId - Organization ID to filter assets by
 * @param filters - String of filter parameters
 * @param settings - Asset index settings containing column configuration
 * @param takeAll - When true, returns all matching assets without pagination
 * @param assetIds - Optional array of specific asset IDs to filter by
 * @returns Object containing assets data, pagination info, and search parameters
 */
export async function getAdvancedPaginatedAndFilterableAssets({
  request,
  organizationId,
  settings,
  filters = "",
  takeAll = false,
  assetIds,
  getBookings = false,
  canUseBarcodes = false,
  availableToBookOnly = false,
}: {
  request: LoaderFunctionArgs["request"];
  organizationId: Organization["id"];
  settings: AssetIndexSettingsRow;
  filters?: string;
  takeAll?: boolean;
  assetIds?: string[];
  getBookings?: boolean;
  canUseBarcodes?: boolean;
  availableToBookOnly?: boolean;
}) {
  const currentFilterParams = new URLSearchParams(filters || "");
  const searchParams = filters
    ? currentFilterParams
    : getCurrentSearchParams(request);
  const paramsValues = getParamsValues(searchParams);
  const { page, perPageParam, search } = paramsValues;
  const cookie = await updateCookieWithPerPage(request, perPageParam);
  const { perPage } = cookie;

  const settingColumns = settings?.columns as Column[];

  const isUpcomingBookingsColumnVisible =
    settings.mode === "ADVANCED" &&
    settingColumns?.some(
      (col) => col.name === "upcomingBookings" && col.visible
    );

  try {
    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = Math.min(Math.max(perPage, 1), 100);
    const parsedFilters = await parseFiltersWithHierarchy(
      filters,
      settingColumns,
      organizationId
    );

    const whereClause = generateWhereClause(
      organizationId,
      search,
      parsedFilters,
      assetIds,
      availableToBookOnly
    );
    const { orderByClause, customFieldSortings } = parseSortingOptions(
      searchParams.getAll("sortBy")
    );
    const customFieldSelect = generateCustomFieldSelect(customFieldSortings);
    // Modify query to conditionally include LIMIT/OFFSET
    const paginationClause = takeAll
      ? Prisma.empty
      : Prisma.sql`LIMIT ${take} OFFSET ${skip}`;
    const query = Prisma.sql`
      WITH asset_query AS (
        ${assetQueryFragment({
          withBookings: getBookings || isUpcomingBookingsColumnVisible,
          withBarcodes: canUseBarcodes,
        })}
        ${customFieldSelect}
        ${assetQueryJoins}
        ${whereClause}
        GROUP BY a.id, k.id, k.name, c.id, c.name, c.color, l.id, l."parentId", l.name, cu.id, tm.name, u.id, u."firstName", u."lastName", u."profilePicture", u.email, b.id, bu.id, bu."firstName", bu."lastName", bu."profilePicture", bu.email, btm.id, btm.name
      ), 
      sorted_asset_query AS (
        SELECT * FROM asset_query
        ${Prisma.raw(orderByClause)}
        ${paginationClause}
      ),
      count_query AS (
        SELECT COUNT(*)::integer AS total_count
        FROM asset_query
      )
      SELECT 
        (SELECT total_count FROM count_query) AS total_count,
        ${assetReturnFragment({
          withBookings: getBookings || isUpcomingBookingsColumnVisible,
          withBarcodes: canUseBarcodes,
        })}
      FROM sorted_asset_query aq;
    `;

    // KEPT AS PRISMA: $queryRaw with dynamic Prisma.sql template
    const result = await db.$queryRaw<AdvancedIndexQueryResult>(query);
    const totalAssets = result[0].total_count;
    const assets: AdvancedIndexAsset[] = result[0].assets;
    const totalPages = Math.ceil(totalAssets / take);
    return {
      search,
      totalAssets,
      perPage: take,
      page,
      assets,
      totalPages,
      cookie,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to fetch paginated and filterable assets",
      additionalData: {
        organizationId,
        paramsValues,
      },
      label,
    });
  }
}

export async function createAsset({
  title,
  description,
  userId,
  kitId,
  categoryId,
  locationId,
  qrId,
  tags,
  custodian,
  customFieldsValues,
  organizationId,
  valuation,
  availableToBook = true,
  mainImage,
  mainImageExpiration,
  barcodes,
  id: assetId, // Add support for passing an ID
}: Pick<
  Asset,
  "description" | "title" | "categoryId" | "userId" | "valuation"
> & {
  kitId?: Kit["id"];
  qrId?: Qr["id"];
  locationId?: Location["id"];
  tags?: { set: { id: string }[] };
  custodian?: TeamMember["id"];
  customFieldsValues?: ShelfAssetCustomFieldValueType[];
  barcodes?: { type: BarcodeType; value: string; existingId?: string }[];
  organizationId: Organization["id"];
  availableToBook?: Asset["availableToBook"];
  id?: Asset["id"]; // Make ID optional
  mainImage?: Asset["mainImage"];
  mainImageExpiration?: Asset["mainImageExpiration"];
}) {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      // Generate sequential ID
      const sequentialId = await getNextSequentialId(organizationId);

      /** User connection data */
      const user = {
        connect: {
          id: userId,
        },
      };

      const organization = {
        connect: {
          id: organizationId as string,
        },
      };

      /**
       * If a qr code is passed, link to that QR
       * Otherwise, create a new one
       * Here we also need to double check:
       * 1. If the qr code exists
       * 2. If the qr code belongs to the current organization
       * 3. If the qr code is not linked to an asset or a kit
       */

      const qr = qrId ? await getQr({ id: qrId }) : null;
      const qrCodes =
        qr &&
        (qr.organizationId === organizationId || !qr.organizationId) &&
        qr.assetId === null &&
        qr.kitId === null
          ? { connect: { id: qrId } }
          : {
              create: [
                {
                  id: id(),
                  version: 0,
                  errorCorrection: ErrorCorrection["L"],
                  user,
                  organization,
                },
              ],
            };

      /** Data object we send via prisma to create Asset */
      const data: Prisma.AssetCreateInput = {
        id: assetId, // Use provided ID if available
        title,
        description,
        sequentialId, // Add the generated sequential ID
        user,
        qrCodes,
        valuation,
        organization,
        availableToBook,
        mainImage,
        mainImageExpiration,
      };

      /** If a kitId is passed, link the kit to the asset. */
      if (kitId && kitId !== "uncategorized") {
        Object.assign(data, {
          kit: {
            connect: {
              id: kitId,
            },
          },
        });
      }

      /** If a categoryId is passed, link the category to the asset. */
      if (categoryId && categoryId !== "uncategorized") {
        Object.assign(data, {
          category: {
            connect: {
              id: categoryId,
            },
          },
        });
      }

      /** If a locationId is passed, link the location to the asset. */
      if (locationId) {
        Object.assign(data, {
          location: {
            connect: {
              id: locationId,
            },
          },
        });
      }

      /** If a tags is passed, link the category to the asset. */
      if (tags && tags?.set?.length > 0) {
        Object.assign(data, {
          tags: {
            connect: tags?.set,
          },
        });
      }

      /** If a custodian is passed, create a Custody relation with that asset
       * `custodian` represents the id of a {@link TeamMember}. */
      if (custodian) {
        Object.assign(data, {
          custody: {
            create: {
              custodian: {
                connect: {
                  id: custodian,
                },
              },
            },
          },
          status: AssetStatus.IN_CUSTODY,
        });
      }

      /** If custom fields are passed, create them */
      if (customFieldsValues && customFieldsValues.length > 0) {
        const customFieldValuesToAdd = customFieldsValues.filter(
          (cf) => !!cf.value
        );

        Object.assign(data, {
          /** Custom fields here refers to the values, check the Schema for more info */
          customFields: {
            create: customFieldValuesToAdd?.map(
              ({ id, value }) =>
                id &&
                value && {
                  value,
                  customFieldId: id,
                }
            ),
          },
        });
      }

      /** If barcodes are passed, handle reusing orphaned barcodes or creating new ones */
      if (barcodes && barcodes.length > 0) {
        const barcodesToAdd = barcodes.filter(
          (barcode) => !!barcode.value && !!barcode.type
        );

        if (barcodesToAdd.length > 0) {
          const barcodesToConnect = barcodesToAdd
            .filter((b) => b.existingId)
            .map((b) => ({ id: b.existingId! }));

          const barcodesToCreate = barcodesToAdd
            .filter((b) => !b.existingId)
            .map(({ type, value }) => ({
              type,
              value: normalizeBarcodeValue(type, value),
              organizationId,
            }));

          // Build barcodes relation data
          const barcodeRelationData: any = {};

          if (barcodesToConnect.length > 0) {
            barcodeRelationData.connect = barcodesToConnect;
          }

          if (barcodesToCreate.length > 0) {
            barcodeRelationData.create = barcodesToCreate;
          }

          if (Object.keys(barcodeRelationData).length > 0) {
            Object.assign(data, { barcodes: barcodeRelationData });
          }
        }
      }

      // KEPT AS PRISMA: Nested relation creates (barcodes, tags, customFields)
      // + sequential ID retry with P2002 unique constraint detection
      const asset = await db.asset.create({
        data,
        include: {
          location: true,
          user: true,
          custody: true,
        },
      });

      // Successfully created asset, exit the retry loop
      return asset;
    } catch (cause) {
      // Check for sequential ID unique constraint violation and retry
      if (cause instanceof Error && "code" in cause && cause.code === "P2002") {
        const prismaError = cause as any;
        const target = prismaError.meta?.target;

        // Handle sequential ID conflicts with retry
        if (
          target &&
          target.includes("sequentialId") &&
          attempts < maxAttempts - 1
        ) {
          attempts++;
          continue; // Retry with next sequential ID
        }

        // If it's a Prisma unique constraint violation on barcode values,
        // use our detailed validation to provide specific field errors
        if (
          target &&
          target.includes("value") &&
          barcodes &&
          barcodes.length > 0
        ) {
          const barcodesToAdd = barcodes.filter(
            (barcode) => !!barcode.value && !!barcode.type
          );
          if (barcodesToAdd.length > 0) {
            // Use existing validation function for detailed error messages
            await validateBarcodeUniqueness(barcodesToAdd, organizationId);
          }
        }
      }

      throw maybeUniqueConstraintViolation(cause, "Asset", {
        additionalData: { userId, organizationId },
      });
    }
  }

  // If we reach here, all retry attempts failed
  throw new ShelfError({
    cause: null,
    message:
      "Failed to create asset after maximum retry attempts for sequential ID generation",
    label: "Assets",
    additionalData: { userId, organizationId, maxAttempts },
  });
}

export async function updateAsset({
  title,
  description,
  mainImage,
  mainImageExpiration,
  thumbnailImage,
  categoryId,
  tags,
  id,
  newLocationId,
  currentLocationId,
  userId,
  valuation,
  customFieldsValues: customFieldsValuesFromForm,
  barcodes,
  organizationId,
  request,
}: UpdateAssetPayload) {
  try {
    const isChangingLocation = newLocationId !== currentLocationId;

    // Check if asset belongs to a kit and prevent location updates
    if (isChangingLocation) {
      // Fetch asset's kitId, then fetch kit name if needed
      const { data: assetRow } = await sbDb
        .from("Asset")
        .select("kitId")
        .eq("id", id)
        .eq("organizationId", organizationId)
        .maybeSingle();

      if (assetRow?.kitId) {
        const { data: kitRow } = await sbDb
          .from("Kit")
          .select("id, name")
          .eq("id", assetRow.kitId)
          .single();

        if (kitRow) {
          throw new ShelfError({
            cause: null,
            message: `This asset's location is managed by its parent kit "${kitRow.name}". Please update the kit's location instead.`,
            additionalData: {
              assetId: id,
              kitId: kitRow.id,
              kitName: kitRow.name,
            },
            label: "Assets",
            status: 400,
            shouldBeCaptured: false,
          });
        }
      }
    }

    const isTagUpdate = Boolean(tags?.set);

    const trackedFieldUpdates = Boolean(
      typeof title !== "undefined" ||
      typeof description !== "undefined" ||
      typeof categoryId !== "undefined" ||
      typeof valuation !== "undefined"
    );

    const assetBeforeUpdate = await fetchAssetBeforeUpdate({
      id,
      organizationId,
      shouldFetch: trackedFieldUpdates || isTagUpdate,
    });

    const previousTags: TagSummary[] = isTagUpdate
      ? (assetBeforeUpdate?.tags ?? []).map((tag) => ({
          id: tag.id,
          name: tag.name ?? "",
        }))
      : [];

    const loadUserForNotes = createLoadUserForNotes(userId);

    const data: Prisma.AssetUpdateInput = {
      title,
      description,
      valuation,
      mainImage,
      mainImageExpiration,
      thumbnailImage,
    };

    /** If uncategorized is passed, disconnect the category */
    if (categoryId === "uncategorized") {
      Object.assign(data, {
        category: {
          disconnect: true,
        },
      });
    }

    // If category id is passed and is different than uncategorized, connect the category
    if (categoryId && categoryId !== "uncategorized") {
      Object.assign(data, {
        category: {
          connect: {
            id: categoryId,
          },
        },
      });
    }

    /** Connect the new location id */
    if (newLocationId) {
      Object.assign(data, {
        location: {
          connect: {
            id: newLocationId,
          },
        },
      });
    }

    /** disconnecting location relation if a user clears locations */
    if (currentLocationId && !newLocationId) {
      Object.assign(data, {
        location: {
          disconnect: true,
        },
      });
    }

    /** If a tags is passed, link the category to the asset. */
    if (isTagUpdate) {
      Object.assign(data, {
        tags,
      });
    }

    /** If custom fields are passed, create/update them */
    let currentCustomFieldsValuesWithFields: {
      id: string;
      customFieldId: string;
      value: any;
      customField: { id: string; name: string; type: any };
    }[] = [];

    if (customFieldsValuesFromForm && customFieldsValuesFromForm.length > 0) {
      /** We get the current values with field information for comparison. We need this to detect changes for notes */
      // Split into 2 queries: fetch values, then fetch related custom fields
      const { data: cfValues, error: cfValuesError } = await sbDb
        .from("AssetCustomFieldValue")
        .select("id, customFieldId, value")
        .eq("assetId", id);

      if (cfValuesError) throw cfValuesError;

      const cfIds = (cfValues ?? []).map((v) => v.customFieldId);
      const { data: cfDefs, error: cfDefsError } = await sbDb
        .from("CustomField")
        .select("id, name, type")
        .in("id", cfIds);

      if (cfDefsError) throw cfDefsError;

      const cfDefsMap = new Map((cfDefs ?? []).map((cf) => [cf.id, cf]));

      currentCustomFieldsValuesWithFields = (cfValues ?? []).map((v) => ({
        id: v.id,
        customFieldId: v.customFieldId,
        value: v.value,
        customField: cfDefsMap.get(v.customFieldId) ?? {
          id: v.customFieldId,
          name: "",
          type: "" as any,
        },
      }));

      const customFieldValuesToAdd = customFieldsValuesFromForm.filter(
        (cf) => !!cf.value
      );

      const customFieldValuesToRemove = customFieldsValuesFromForm.filter(
        (cf) => !cf.value
      );

      Object.assign(data, {
        customFields: {
          upsert: customFieldValuesToAdd?.map(({ id, value }) => ({
            where: {
              id:
                currentCustomFieldsValuesWithFields.find(
                  (ccfv) => ccfv.customFieldId === id
                )?.id || "",
            },
            update: { value },
            create: {
              value,
              customFieldId: id,
            },
          })),
          deleteMany: customFieldValuesToRemove.map((cf) => ({
            customFieldId: cf.id,
          })),
        },
      });
    }

    // KEPT AS PRISMA: Nested relation writes (customFieldValues
    // create/update/deleteMany, tags connect/set, barcodes upsert)
    const asset = await db.asset.update({
      where: { id, organizationId },
      data,
      include: {
        location: true,
        tags: true,
        category: true,
        organization: true,
      },
    });

    /** If barcodes are passed, update existing barcodes efficiently */
    if (barcodes !== undefined) {
      await updateBarcodes({
        barcodes,
        assetId: id,
        organizationId,
        userId,
      });
    }

    /** If the location id was passed, we create a note for the move */
    if (isChangingLocation) {
      /**
       * Create a note for the move
       * Here we actually need to query the locations so we can print their names
       * */

      const user = await loadUserForNotes();

      const currentLocation = currentLocationId
        ? await sbDb
            .from("Location")
            .select("*")
            .eq("id", currentLocationId)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) throw error;
              return data;
            })
        : null;

      const newLocation = newLocationId
        ? await sbDb
            .from("Location")
            .select("*")
            .eq("id", newLocationId)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) throw error;
              return data;
            })
        : null;

      await createLocationChangeNote({
        currentLocation,
        newLocation,
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        assetId: asset.id,
        userId,
        isRemoving: newLocationId === null,
      });

      // Create location activity notes
      const userLink = wrapUserLinkForNote({
        id: userId,
        firstName: user.firstName,
        lastName: user.lastName,
      });
      const assetData = [{ id: asset.id, title: asset.title }];

      if (newLocation) {
        const newLocLink = wrapLinkForNote(
          `/locations/${newLocation.id}`,
          newLocation.name
        );
        const assetMarkup = wrapAssetsWithDataForNote(assetData, "added");
        const movedFrom = currentLocation
          ? ` Moved from ${wrapLinkForNote(
              `/locations/${currentLocation.id}`,
              currentLocation.name
            )}.`
          : "";
        await createSystemLocationNote({
          locationId: newLocation.id,
          content: `${userLink} added ${assetMarkup} to ${newLocLink}.${movedFrom}`,
          userId,
        });
      }

      if (currentLocation && currentLocation.id !== newLocation?.id) {
        const prevLocLink = wrapLinkForNote(
          `/locations/${currentLocation.id}`,
          currentLocation.name
        );
        const assetMarkup = wrapAssetsWithDataForNote(assetData, "removed");
        const movedTo = newLocation
          ? ` Moved to ${wrapLinkForNote(
              `/locations/${newLocation.id}`,
              newLocation.name
            )}.`
          : "";
        await createSystemLocationNote({
          locationId: currentLocation.id,
          content: `${userLink} removed ${assetMarkup} from ${prevLocLink}.${movedTo}`,
          userId,
        });
      }
    }

    if (assetBeforeUpdate && trackedFieldUpdates) {
      await Promise.all([
        createAssetNameChangeNote({
          assetId: asset.id,
          userId,
          previousName: assetBeforeUpdate.title,
          newName: title,
          loadUserForNotes,
        }),
        createAssetDescriptionChangeNote({
          assetId: asset.id,
          userId,
          previousDescription: assetBeforeUpdate.description,
          newDescription: description,
          loadUserForNotes,
        }),
        createAssetCategoryChangeNote({
          assetId: asset.id,
          userId,
          previousCategory: assetBeforeUpdate.category,
          newCategory: asset.category
            ? {
                id: asset.category.id,
                name: asset.category.name ?? "Unnamed category",
                color: asset.category.color ?? "#575757",
              }
            : null,
          loadUserForNotes,
        }),
        createAssetValuationChangeNote({
          assetId: asset.id,
          userId,
          previousValuation: assetBeforeUpdate.valuation,
          newValuation: asset.valuation,
          currency: assetBeforeUpdate.organization.currency,
          locale: getLocale(request),
          loadUserForNotes,
        }),
      ]);
    }

    if (isTagUpdate) {
      await createTagChangeNoteIfNeeded({
        assetId: asset.id,
        userId,
        previousTags,
        currentTags: asset.tags ?? [],
        loadUserForNotes,
      });
    }

    /** If custom fields were processed, create notes for any changes */
    if (customFieldsValuesFromForm && customFieldsValuesFromForm.length > 0) {
      // Early detection of potential changes to avoid unnecessary DB queries
      const potentialChanges = detectPotentialChanges(
        currentCustomFieldsValuesWithFields,
        customFieldsValuesFromForm
      );

      if (potentialChanges.length > 0) {
        // Fetch required data in parallel only if we have potential changes
        const [user, customFieldsFromForm] = await Promise.all([
          sbDb
            .from("User")
            .select("firstName, lastName")
            .eq("id", userId)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) {
                throw new ShelfError({
                  cause: error,
                  message: "Failed to fetch user for custom field notes",
                  additionalData: { userId },
                  label,
                });
              }
              return data;
            }),
          sbDb
            .from("CustomField")
            .select("id, name, type")
            .in(
              "id",
              customFieldsValuesFromForm.map((cf) => cf.id)
            )
            .eq("active", true)
            .is("deletedAt", null)
            .then(({ data, error }) => {
              if (error) {
                throw new ShelfError({
                  cause: error,
                  message: "Failed to fetch custom fields",
                  label,
                });
              }
              return data ?? [];
            }),
        ]);

        // Detect actual changes with robust comparison
        const changes = detectCustomFieldChanges(
          currentCustomFieldsValuesWithFields,
          customFieldsValuesFromForm,
          customFieldsFromForm
        );

        // Batch create all notes in parallel if we have changes
        if (changes.length > 0) {
          const notePromises = changes.map((change: CustomFieldChangeInfo) =>
            createCustomFieldChangeNote({
              customFieldName: change.customFieldName,
              previousValue: change.previousValue,
              newValue: change.newValue,
              firstName: user?.firstName || "",
              lastName: user?.lastName || "",
              assetId: asset.id,
              userId,
              isFirstTimeSet: change.isFirstTimeSet,
            })
          );

          await Promise.all(notePromises);
        }
      }
    }

    return asset;
  } catch (cause) {
    // If it's already a ShelfError with validation errors, re-throw as is
    if (
      cause instanceof ShelfError &&
      cause.additionalData?.[VALIDATION_ERROR]
    ) {
      throw cause;
    }

    throw maybeUniqueConstraintViolation(cause, "Asset", {
      additionalData: { userId, id, organizationId },
    });
  }
}

export async function deleteAsset({
  id,
  organizationId,
}: Pick<Asset, "id"> & { organizationId: Organization["id"] }) {
  try {
    // Fetch reminders before deleting the asset
    const { data: reminders, error: remindersError } = await sbDb
      .from("AssetReminder")
      .select("alertDateTime, activeSchedulerReference")
      .eq("assetId", id);

    if (remindersError) throw remindersError;

    // Delete the asset
    const { error: deleteError } = await sbDb
      .from("Asset")
      .delete()
      .eq("id", id)
      .eq("organizationId", organizationId);

    if (deleteError) throw deleteError;

    // Cancel reminder schedulers
    await Promise.all(
      (reminders ?? []).map((r) =>
        cancelAssetReminderScheduler({
          alertDateTime: new Date(r.alertDateTime),
          activeSchedulerReference: r.activeSchedulerReference,
        })
      )
    );
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while deleting asset",
      additionalData: { id, organizationId },
      label,
    });
  }
}

export async function updateAssetMainImage({
  request,
  assetId,
  userId,
  organizationId,
  isNewAsset = false,
}: {
  request: Request;
  assetId: string;
  userId: User["id"];
  organizationId: Organization["id"];
  isNewAsset?: boolean;
}) {
  try {
    const fileData = await parseFileFormData({
      request,
      bucketName: "assets",
      newFileName: `${userId}/${assetId}/main-image-${dateTimeInUnix(
        Date.now()
      )}`,
      resizeOptions: {
        width: 1200,
        withoutEnlargement: true,
      },
      generateThumbnail: true, // Enable thumbnail generation
      thumbnailSize: 108, // Size matches what we use in AssetImage component
      maxFileSize: ASSET_MAX_IMAGE_UPLOAD_SIZE,
    });

    const image = fileData.get("mainImage") as string | null;

    if (!image) {
      return;
    }

    // Handle both the old string response and new stringified object response
    let mainImagePath: string;
    let thumbnailPath: string | null = null;

    // Try parsing as JSON first (for new thumbnail format)
    try {
      const parsedImage = JSON.parse(image);
      if (parsedImage.originalPath) {
        mainImagePath = parsedImage.originalPath;
        thumbnailPath = parsedImage.thumbnailPath;
      } else {
        // Fallback to string if parsing succeeds but no originalPath
        mainImagePath = image;
      }
    } catch {
      // If parsing fails, it's just a regular path string
      mainImagePath = image;
    }

    const signedUrl = await createSignedUrl({ filename: mainImagePath });
    let thumbnailSignedUrl: string | null = null;

    if (thumbnailPath) {
      thumbnailSignedUrl = await createSignedUrl({ filename: thumbnailPath });
    }

    await updateAsset({
      id: assetId,
      mainImage: signedUrl,
      thumbnailImage: thumbnailSignedUrl,
      mainImageExpiration: oneDayFromNow(),
      userId,
      organizationId,
      request,
    });

    /**
     * If updateAssetMainImage is called from new asset route, then we don't have to delete other images
     * because no others images for this assets exists yet.
     */
    if (!isNewAsset) {
      await deleteOtherImages({
        userId,
        assetId,
        data: { path: mainImagePath },
      });
    }
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);
    throw new ShelfError({
      cause,
      message: isShelfError
        ? cause.message
        : "Something went wrong while updating asset main image",
      additionalData: { assetId, userId, field: "mainImage" },
      label,
    });
  }
}

function extractMainImageName(path: string): string | null {
  const match = path.match(/main-image-[\w-]+\.\w+/);
  if (match) {
    return match[0];
  } else {
    // Handle case without file extension
    const matchNoExt = path.match(/main-image-[\w-]+/);
    return matchNoExt ? matchNoExt[0] : null;
  }
}

export async function deleteOtherImages({
  userId,
  assetId,
  data,
}: {
  userId: string;
  assetId: string;
  data: { path: string };
}): Promise<void> {
  try {
    if (!data?.path) {
      // asset image storage failure. do nothing
      return;
    }

    const currentImage = extractMainImageName(data.path);
    if (!currentImage) {
      // do nothing
      return;
    }

    // Derive thumbnail name from current image
    const currentThumbnail = currentImage.includes(".")
      ? currentImage.replace(/(\.[^.]+)$/, "-thumbnail$1")
      : `${currentImage}-thumbnail`;

    const { data: deletedImagesData, error: deletedImagesError } =
      await getSupabaseAdmin()
        .storage.from("assets")
        .list(`${userId}/${assetId}`);

    if (deletedImagesError) {
      throw new ShelfError({
        cause: deletedImagesError,
        message: "Failed to fetch images",
        additionalData: { userId, assetId, currentImage, data },
        label,
      });
    }

    // Extract the image names and filter out the ones to keep
    const imagesToDelete = (
      deletedImagesData?.map((image) => image.name) || []
    ).filter(
      (image) =>
        // Keep the current main image and its thumbnail
        image !== currentImage && image !== currentThumbnail
    );

    // Delete the images
    await Promise.all(
      imagesToDelete.map((image) =>
        getSupabaseAdmin()
          .storage.from("assets")
          .remove([`${userId}/${assetId}/${image}`])
      )
    );
  } catch (cause) {
    Logger.error(
      new ShelfError({
        cause,
        title: "Oops, deletion of other asset images failed",
        message: "Something went wrong while deleting other asset images",
        additionalData: { assetId, userId },
        label,
      })
    );
  }
}

export async function uploadDuplicateAssetMainImage(
  mainImageUrl: string,
  assetId: string,
  userId: string
) {
  try {
    const originalPath = extractStoragePath(mainImageUrl, "assets");

    if (!originalPath) {
      throw new ShelfError({
        cause: null,
        message: "Failed to extract asset image path for duplication",
        additionalData: { mainImageUrl, assetId, userId },
        label,
        shouldBeCaptured: false,
      });
    }

    const { data: originalFile, error: downloadError } =
      await getSupabaseAdmin().storage.from("assets").download(originalPath);

    if (downloadError) {
      throw new ShelfError({
        cause: downloadError,
        message: "Failed to download asset image for duplication",
        additionalData: { originalPath, assetId, userId },
        label,
      });
    }

    const arrayBuffer = await originalFile.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    const detectedFormat = detectImageFormat(imageBuffer);

    if (!detectedFormat) {
      throw new ShelfError({
        cause: null,
        message: "Unsupported image format for asset duplication",
        additionalData: { originalPath, assetId, userId },
        label,
        shouldBeCaptured: false,
      });
    }

    /** Uploading the Blob to supabase */
    const { data, error } = await getSupabaseAdmin()
      .storage.from("assets")
      .upload(
        `${userId}/${assetId}/main-image-${dateTimeInUnix(Date.now())}`,
        imageBuffer,
        { contentType: detectedFormat, upsert: true }
      );

    if (error) {
      throw error;
    }
    await deleteOtherImages({ userId, assetId, data });
    /** Getting the signed url from supabase to we can view image  */
    return await createSignedUrl({ filename: data.path });
  } catch (cause) {
    throw new ShelfError({
      cause,
      title: "Oops, duplicating failed",
      message: "Something went wrong while uploading the image",
      additionalData: { mainImageUrl, assetId, userId },
      label,
    });
  }
}

export function createCustomFieldsPayloadFromAsset(
  asset: Prisma.AssetGetPayload<{
    include: {
      custody: { include: { custodian: true } };
      tags: true;
      customFields: true;
    };
  }>
) {
  if (!asset?.customFields || asset?.customFields?.length === 0) {
    return {};
  }

  return (
    asset.customFields?.reduce(
      (obj, { customFieldId, value }) => {
        const rawValue = (value as { raw: string })?.raw ?? value ?? "";
        return { ...obj, [`cf-${customFieldId}`]: rawValue };
      },
      {} as Record<string, any>
    ) || {}
  );
}

export async function duplicateAsset({
  asset,
  userId,
  amountOfDuplicates,
  organizationId,
}: {
  asset: Prisma.AssetGetPayload<{
    include: {
      custody: { include: { custodian: true } };
      tags: true;
      customFields: true;
    };
  }>;
  userId: string;
  amountOfDuplicates: number;
  organizationId: string;
}) {
  try {
    const duplicatedAssets: Awaited<ReturnType<typeof createAsset>>[] = [];

    //irrespective category it has to copy all the custom fields;
    const customFields = await getActiveCustomFields({
      organizationId,
      includeAllCategories: true,
    });

    const payload = {
      title: `${asset.title}`,
      organizationId,
      description: asset.description,
      userId,
      categoryId: asset.categoryId,
      locationId: asset.locationId ?? undefined,
      tags: { set: asset.tags.map((tag) => ({ id: tag.id })) },
      valuation: asset.valuation,
    };

    const customFieldValues = createCustomFieldsPayloadFromAsset(asset);

    const extractedCustomFieldValues = extractCustomFieldValuesFromPayload({
      payload: { ...payload, ...customFieldValues },
      customFieldDef: customFields,
      isDuplicate: true,
    });
    for (const i of [...Array(amountOfDuplicates)].keys()) {
      const duplicatedAsset = await createAsset({
        ...payload,
        title: `${asset.title} (copy ${amountOfDuplicates > 1 ? i + 1 : ""})`,
        customFieldsValues: extractedCustomFieldValues,
      });

      if (asset.mainImage) {
        try {
          const imagePath = await uploadDuplicateAssetMainImage(
            asset.mainImage,
            duplicatedAsset.id,
            userId
          );

          if (typeof imagePath === "string") {
            const { error: updateError } = await sbDb
              .from("Asset")
              .update({
                mainImage: imagePath,
                mainImageExpiration: oneDayFromNow().toISOString(),
              })
              .eq("id", duplicatedAsset.id);

            if (updateError) {
              throw new ShelfError({
                cause: updateError,
                message: "Failed to update duplicated asset main image",
                additionalData: { assetId: duplicatedAsset.id },
                label,
              });
            }
          }
        } catch (cause) {
          // Log the error so we are aware there is an issue anc can check if it is on our side
          Logger.error(
            new ShelfError({
              cause,
              message: "Skipping duplicate asset image due to upload failure",
              additionalData: {
                assetId: duplicatedAsset.id,
                originalAssetId: asset.id,
                userId,
              },
              label,
              shouldBeCaptured: false,
            })
          );
        }
      }

      duplicatedAssets.push(duplicatedAsset);
    }

    return duplicatedAssets;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while duplicating the asset",
      additionalData: { asset, userId, amountOfDuplicates, organizationId },
      label,
    });
  }
}

export async function getAllEntriesForCreateAndEdit({
  organizationId,
  request,
  defaults,
  tagUseFor,
}: {
  organizationId: Organization["id"];
  request: LoaderFunctionArgs["request"];
  defaults?: {
    category?: string | string[] | null;
    tag?: string | null;
    location?: string | null;
  };
  tagUseFor?: TagUseFor;
}) {
  const searchParams = getCurrentSearchParams(request);
  const categorySelected =
    searchParams.get("category") ?? defaults?.category ?? "";
  const locationSelected =
    searchParams.get("location") ?? defaults?.location ?? "";
  const getAllEntries = searchParams.getAll("getAll") as AllowedModelNames[];

  try {
    const [
      { categories, totalCategories },
      tags,
      { locations, totalLocations },
    ] = await Promise.all([
      getCategoriesForCreateAndEdit({
        request,
        organizationId,
        defaultCategory: defaults?.category,
      }),

      /** Get the tags */
      sbDb
        .from("Tag")
        .select("*")
        .eq("organizationId", organizationId)
        .or(
          tagUseFor ? `useFor.eq.{},useFor.cs.{${tagUseFor}}` : `useFor.eq.{}`
        )
        .order("name", { ascending: true })
        .then(({ data, error }) => {
          if (error) throw error;
          return data ?? [];
        }),

      /** Get the locations */
      getLocationsForCreateAndEdit({
        organizationId,
        request,
        defaultLocation: defaults?.location,
      }),
    ]);

    return {
      categories,
      totalCategories,
      tags,
      locations,
      totalLocations,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Fail to get all entries for create and edit",
      additionalData: {
        categorySelected,
        locationSelected,
        defaults,
        organizationId,
        getAllEntries,
      },
      label,
    });
  }
}

export async function getPaginatedAndFilterableAssets({
  request,
  organizationId,
  extraInclude,
  excludeCategoriesQuery = false,
  excludeTagsQuery = false,
  excludeLocationQuery = false,
  filters = "",
  isSelfService,
  userId,
}: {
  request: LoaderFunctionArgs["request"];
  organizationId: Organization["id"];
  kitId?: Prisma.AssetWhereInput["kitId"];
  extraInclude?: Prisma.AssetInclude;
  excludeCategoriesQuery?: boolean;
  excludeTagsQuery?: boolean;
  excludeLocationQuery?: boolean;
  filters?: string;

  isSelfService?: boolean;
  userId?: string;
}) {
  const currentFilterParams = new URLSearchParams(filters || "");
  const searchParams = filters
    ? currentFilterParams
    : getCurrentSearchParams(request);

  const paramsValues = getParamsValues(searchParams);
  const status =
    searchParams.get("status") === "ALL" // If the value is "ALL", we just remove the param
      ? null
      : (searchParams.get("status") as AssetStatus | null);
  const getAllEntries = searchParams.getAll("getAll") as AllowedModelNames[];
  const {
    page,
    perPageParam,
    orderBy,
    orderDirection,
    search,
    categoriesIds,
    tagsIds,
    bookingFrom,
    bookingTo,
    hideUnavailable,
    unhideAssetsBookigIds,
    locationIds,
    teamMemberIds,
    assetKitFilter,
  } = paramsValues;

  const cookie = await updateCookieWithPerPage(request, perPageParam);
  const { perPage } = cookie;

  try {
    const {
      tags,
      totalTags,
      categories,
      totalCategories,
      locations,
      totalLocations,
    } = await getEntitiesWithSelectedValues({
      organizationId,
      allSelectedEntries: getAllEntries,
      selectedCategoryIds: categoriesIds,
      selectedTagIds: tagsIds,
      selectedLocationIds: locationIds,
    });

    const teamMembersData = await getTeamMemberForCustodianFilter({
      organizationId,
      selectedTeamMembers: teamMemberIds,
      getAll: getAllEntries.includes("teamMember"),
      filterByUserId: isSelfService,
      userId,
    });

    const { assets, totalAssets } = await getAssets({
      organizationId,
      page,
      perPage,
      orderBy,
      orderDirection,
      search,
      categoriesIds,
      tagsIds,
      status,
      bookingFrom: bookingFrom ?? undefined,
      bookingTo: bookingTo ?? undefined,
      hideUnavailable,
      unhideAssetsBookigIds,
      locationIds,
      teamMemberIds,
      extraInclude,
      assetKitFilter,
      availableToBookOnly: isSelfService,
    });

    const totalPages = Math.ceil(totalAssets / perPage);

    return {
      page,
      perPage,
      search,
      totalAssets,
      totalCategories,
      totalTags,
      categories: excludeCategoriesQuery ? [] : categories,
      tags: excludeTagsQuery ? [] : tags,
      assets,
      totalPages,
      cookie,
      locations: excludeLocationQuery ? [] : locations,
      totalLocations,
      ...teamMembersData,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Fail to fetch paginated and filterable assets",
      additionalData: {
        organizationId,
        excludeCategoriesQuery,
        excludeTagsQuery,
        paramsValues,
        getAllEntries,
      },
      label,
    });
  }
}

export async function createCustomFieldChangeNote({
  customFieldName,
  previousValue,
  newValue,
  firstName,
  lastName,
  assetId,
  userId,
  isFirstTimeSet,
}: {
  customFieldName: string;
  previousValue?: string | null;
  newValue?: string | null;
  firstName: string;
  lastName: string;
  assetId: Asset["id"];
  userId: User["id"];
  isFirstTimeSet: boolean;
}) {
  try {
    const message = getCustomFieldUpdateNoteContent({
      customFieldName,
      previousValue,
      newValue,
      userId,
      firstName,
      lastName,
      isFirstTimeSet,
    });

    if (!message) {
      return; // No note to create if message is empty
    }

    await createNote({
      content: message,
      type: "UPDATE",
      userId,
      assetId,
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while creating a custom field change note. Please try again or contact support",
      additionalData: { userId, assetId, customFieldName },
      label,
    });
  }
}

/** Fetches assets with the data needed for exporting to CSV */
export async function fetchAssetsForExport({
  organizationId,
}: {
  organizationId: Organization["id"];
}) {
  try {
    // 1. Fetch base assets
    const { data: assets, error: assetsError } = await sbDb
      .from("Asset")
      .select("*")
      .eq("organizationId", organizationId);

    if (assetsError) throw assetsError;
    if (!assets || assets.length === 0) return [];

    const assetIds = assets.map((a) => a.id);
    const categoryIds = assets
      .map((a) => a.categoryId)
      .filter(Boolean) as string[];
    const locationIds = assets
      .map((a) => a.locationId)
      .filter(Boolean) as string[];

    // 2. Fetch all related data in parallel
    const [categories, locations, notes, custodies, tagJoinRows, cfValues] =
      await Promise.all([
        categoryIds.length > 0
          ? sbDb
              .from("Category")
              .select("*")
              .in("id", categoryIds)
              .then(({ data, error }) => {
                if (error) throw error;
                return data ?? [];
              })
          : Promise.resolve([]),
        locationIds.length > 0
          ? sbDb
              .from("Location")
              .select("*")
              .in("id", locationIds)
              .then(({ data, error }) => {
                if (error) throw error;
                return data ?? [];
              })
          : Promise.resolve([]),
        sbDb
          .from("Note")
          .select("*")
          .in("assetId", assetIds)
          .then(({ data, error }) => {
            if (error) throw error;
            return data ?? [];
          }),
        sbDb
          .from("Custody")
          .select("*")
          .in("assetId", assetIds)
          .then(({ data, error }) => {
            if (error) throw error;
            return data ?? [];
          }),
        sbDb
          .from("_AssetToTag")
          .select("A, B")
          .in("A", assetIds)
          .then(({ data, error }) => {
            if (error) throw error;
            return data ?? [];
          }),
        sbDb
          .from("AssetCustomFieldValue")
          .select("*")
          .in("assetId", assetIds)
          .then(({ data, error }) => {
            if (error) throw error;
            return data ?? [];
          }),
      ]);

    // 3. Fetch custodians (TeamMember), tags, and customField defs
    const custodianIds = custodies.map((c) => c.teamMemberId);
    const tagIds = [...new Set(tagJoinRows.map((r) => r.B))];
    const cfIds = [...new Set(cfValues.map((v) => v.customFieldId))];

    const [custodians, tags, customFieldDefs] = await Promise.all([
      custodianIds.length > 0
        ? sbDb
            .from("TeamMember")
            .select("*")
            .in("id", custodianIds)
            .then(({ data, error }) => {
              if (error) throw error;
              return data ?? [];
            })
        : Promise.resolve([]),
      tagIds.length > 0
        ? sbDb
            .from("Tag")
            .select("*")
            .in("id", tagIds)
            .then(({ data, error }) => {
              if (error) throw error;
              return data ?? [];
            })
        : Promise.resolve([]),
      cfIds.length > 0
        ? sbDb
            .from("CustomField")
            .select("*")
            .in("id", cfIds)
            .then(({ data, error }) => {
              if (error) throw error;
              return data ?? [];
            })
        : Promise.resolve([]),
    ]);

    // 4. Build lookup maps
    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const locationMap = new Map(locations.map((l) => [l.id, l]));
    const custodianMap = new Map(custodians.map((tm) => [tm.id, tm]));
    const tagMap = new Map(tags.map((t) => [t.id, t]));
    const cfDefMap = new Map(customFieldDefs.map((cf) => [cf.id, cf]));

    // Group by assetId
    const notesByAsset = new Map<string, typeof notes>();
    for (const n of notes) {
      if (n.assetId) {
        const arr = notesByAsset.get(n.assetId) ?? [];
        arr.push(n);
        notesByAsset.set(n.assetId, arr);
      }
    }

    const custodyByAsset = new Map<string, (typeof custodies)[0]>();
    for (const c of custodies) {
      if (c.assetId) custodyByAsset.set(c.assetId, c);
    }

    const tagsByAsset = new Map<string, typeof tags>();
    for (const row of tagJoinRows) {
      const tag = tagMap.get(row.B);
      if (tag) {
        const arr = tagsByAsset.get(row.A) ?? [];
        arr.push(tag);
        tagsByAsset.set(row.A, arr);
      }
    }

    const cfByAsset = new Map<
      string,
      Array<(typeof cfValues)[0] & { customField: (typeof customFieldDefs)[0] }>
    >();
    for (const v of cfValues) {
      if (v.assetId) {
        const def = cfDefMap.get(v.customFieldId);
        if (def) {
          const arr = cfByAsset.get(v.assetId) ?? [];
          arr.push({ ...v, customField: def });
          cfByAsset.set(v.assetId, arr);
        }
      }
    }

    // 5. Assemble results — cast Supabase date strings to Date objects
    // Map DB column "value" back to Prisma field name "valuation"
    return assets.map((asset) => {
      const custody = custodyByAsset.get(asset.id);
      const custodian = custody
        ? (custodianMap.get(custody.teamMemberId) ?? null)
        : null;
      // Destructure to rename `value` -> `valuation` for downstream compat
      const { value: valuation, ...restAsset } = asset;
      return {
        ...restAsset,
        valuation,
        createdAt: new Date(asset.createdAt),
        updatedAt: new Date(asset.updatedAt),
        mainImageExpiration: asset.mainImageExpiration
          ? new Date(asset.mainImageExpiration)
          : null,
        category: asset.categoryId
          ? (categoryMap.get(asset.categoryId) ?? null)
          : null,
        location: asset.locationId
          ? (locationMap.get(asset.locationId) ?? null)
          : null,
        notes: (notesByAsset.get(asset.id) ?? []).map((n) => ({
          ...n,
          createdAt: new Date(n.createdAt),
          updatedAt: new Date(n.updatedAt),
        })),
        custody: custody
          ? {
              ...custody,
              createdAt: new Date(custody.createdAt),
              custodian,
            }
          : null,
        tags: tagsByAsset.get(asset.id) ?? [],
        customFields: cfByAsset.get(asset.id) ?? [],
      };
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while fetching assets for export",
      additionalData: { organizationId },
      label,
    });
  }
}

/**
 * Creates assets from imported content, handling image URLs if provided
 * Pre-generates IDs for consistent asset and image file naming
 */
export async function createAssetsFromContentImport({
  data,
  userId,
  organizationId,
  canUseBarcodes,
}: {
  data: CreateAssetFromContentImportPayload[];
  userId: User["id"];
  organizationId: Organization["id"];
  canUseBarcodes?: boolean;
}) {
  try {
    // Create cache instance for this import operation
    const imageCache = new LRUCache<string, CachedImage>({
      maxSize: importImageCacheServer.MAX_CACHE_SIZE,
      sizeCalculation: (value) => {
        // Ensure size is always a positive integer to prevent LRU cache errors
        const size = value?.size || 0;
        return typeof size === "number" && size > 0 ? size : 1;
      },
    });

    const qrCodesPerAsset = await parseQrCodesFromImportData({
      data,
      organizationId,
      userId,
    });

    // Check if any assets have barcode data and if barcodes are enabled
    const hasBarcodesData = data.some(
      (asset) =>
        asset.barcode_Code128 ||
        asset.barcode_Code39 ||
        asset.barcode_DataMatrix
    );

    if (hasBarcodesData && !canUseBarcodes) {
      throw new ShelfError({
        cause: null,
        message:
          "Your workspace doesn't have barcodes enabled. Please contact sales to learn more about barcodes.",
        additionalData: { userId, organizationId },
        label: "Assets",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    // Parse barcode data if barcodes are enabled
    const barcodesPerAsset = canUseBarcodes
      ? await parseBarcodesFromImportData({
          data,
          organizationId,
          userId,
        })
      : [];

    // Validate kit-custody conflicts before any database operations
    await validateKitCustodyConflicts({
      data,
      organizationId,
    });

    // Create all required related entities
    const [kits, categories, locations, teamMembers, tags, { customFields }] =
      await Promise.all([
        createKitsIfNotExists({
          data,
          userId,
          organizationId,
        }),
        createCategoriesIfNotExists({
          data,
          userId,
          organizationId,
        }),
        createLocationsIfNotExists({
          data,
          userId,
          organizationId,
        }),
        createTeamMemberIfNotExists({
          data,
          organizationId,
        }),
        createTagsIfNotExists({
          data,
          userId,
          organizationId,
        }),
        createCustomFieldsIfNotExists({
          data,
          organizationId,
          userId,
        }),
      ]);

    // Process assets sequentially to handle image uploads
    for (const asset of data) {
      // Generate asset ID upfront
      const assetId = id(LEGACY_CUID_LENGTH); // This generates our standard CUID format. We use legacy length(25 chars) so it fits with the length of IDS generated by prisma

      const customFieldsValues: ShelfAssetCustomFieldValueType[] =
        Object.entries(asset).reduce((res, [key, val]) => {
          if (!key.startsWith("cf:")) {
            return res;
          }

          if (
            val === undefined ||
            val === null ||
            (typeof val === "string" && val.trim() === "")
          ) {
            return res;
          }

          const { name } = getDefinitionFromCsvHeader(key);
          const definition = customFields[name];

          if (!definition?.id) {
            return res;
          }

          try {
            const value = buildCustomFieldValue(
              { raw: asset[key] },
              definition as any
            );

            if (value) {
              res.push({
                id: definition.id,
                value,
              } as ShelfAssetCustomFieldValueType);
            }
          } catch (error) {
            const isNumericField =
              definition.type === "AMOUNT" || definition.type === "NUMBER";

            if (isNumericField) {
              // If the error is already a ShelfError with a specific message from sanitizeNumericInput,
              // enhance it with asset context. Otherwise, create a generic message.
              let message: string;

              if (isLikeShelfError(error)) {
                // Check if asset context has already been added by checking additionalData
                const hasAssetContext =
                  error.additionalData && "assetKey" in error.additionalData;

                if (hasAssetContext) {
                  message = error.message;
                } else {
                  // Add asset context after the field name using regex to be precise
                  message = error.message.replace(
                    /^(Custom field '[^']+')(:)/,
                    `$1 (asset: '${asset.title}')$2`
                  );
                }
              } else {
                message = formatInvalidNumericCustomFieldMessage(
                  definition.name,
                  asset[key],
                  { assetTitle: asset.title }
                );
              }

              throw new ShelfError({
                cause: error,
                label,
                message,
                additionalData: {
                  assetKey: asset.key,
                  customFieldId: definition.id,
                  customFieldType: definition.type,
                  rawValue: asset[key],
                  ...(isLikeShelfError(error) && error.additionalData),
                },
                shouldBeCaptured: false,
              });
            }

            throw error;
          }

          return res;
        }, [] as ShelfAssetCustomFieldValueType[]);

      // Handle image URL if provided
      let mainImage: string | undefined;
      let mainImageExpiration: Date | undefined;

      if (asset.imageUrl) {
        try {
          if (!isValidImageUrl(asset.imageUrl)) {
            throw new ShelfError({
              cause: null,
              message: "Invalid image format. Please use .png, .jpg, or .jpeg",
              additionalData: { url: asset.imageUrl },
              label: "Assets",
              shouldBeCaptured: false,
            });
          }
          const filename = `${userId}/${assetId}/main-image-${dateTimeInUnix(
            Date.now()
          )}`;

          const path = await uploadImageFromUrl(
            asset.imageUrl,
            {
              filename,
              contentType: "image/jpeg",
              bucketName: "assets",
              resizeOptions: {
                width: 1200,
                withoutEnlargement: true,
              },
            },
            imageCache
          );

          if (path) {
            mainImage = await createSignedUrl({ filename: path });
            mainImageExpiration = oneDayFromNow();
          }
        } catch (cause) {
          // This catch block should rarely be reached now since uploadImageFromUrl returns null instead of throwing
          // But we keep it for any unexpected errors in createSignedUrl or other operations
          const isShelfError = isLikeShelfError(cause);

          Logger.error(
            new ShelfError({
              cause,
              message: isShelfError
                ? `${cause?.message} for asset: ${asset.title}`
                : `Unexpected error during image processing for asset ${asset.title}`,
              additionalData: { imageUrl: asset.imageUrl, assetId },
              label: "Assets",
            })
          );

          // Continue with asset creation without the image
          mainImage = undefined;
          mainImageExpiration = undefined;
        }
      }

      // Get barcodes for this asset if any
      const assetBarcodes =
        barcodesPerAsset.find((item) => item.key === asset.key)?.barcodes || [];

      // Resolve kit/custodian IDs from normalized CSV values to avoid undefined lookups.
      const kitKey = asset.kit?.trim();
      const kitId = kitKey ? kits?.[kitKey]?.id : undefined;
      // Surface a clear import error instead of a TypeError when a kit value can't be resolved.
      if (kitKey && !kitId) {
        throw new ShelfError({
          cause: null,
          message: `Kit "${kitKey}" could not be resolved for asset "${asset.title}". Please verify the kit column values in your CSV.`,
          additionalData: {
            assetKey: asset.key,
            assetTitle: asset.title,
            kit: kitKey,
          },
          label: "Assets",
          shouldBeCaptured: false,
        });
      }

      const custodianKey = asset.custodian?.trim();
      const custodianId = custodianKey
        ? teamMembers?.[custodianKey]?.id
        : undefined;
      // Surface a clear import error instead of a TypeError when a custodian value can't be resolved.
      if (custodianKey && !custodianId) {
        throw new ShelfError({
          cause: null,
          message: `Custodian "${custodianKey}" could not be resolved for asset "${asset.title}". Please verify the custodian column values in your CSV.`,
          additionalData: {
            assetKey: asset.key,
            assetTitle: asset.title,
            custodian: custodianKey,
          },
          label: "Assets",
          shouldBeCaptured: false,
        });
      }

      await createAsset({
        id: assetId, // Pass the pre-generated ID
        qrId: qrCodesPerAsset.find((item) => item?.key === asset.key)?.qrId,
        organizationId,
        title: asset.title,
        description: asset.description || "",
        userId,
        kitId,
        categoryId: asset.category ? categories?.[asset.category] : null,
        locationId: asset.location ? locations?.[asset.location] : undefined,
        custodian: custodianId,
        tags:
          asset?.tags && asset.tags.length > 0
            ? {
                set: asset.tags
                  .filter((t) => tags[t])
                  .map((t) => ({ id: tags[t] })),
              }
            : undefined,
        valuation: asset.valuation ? +asset.valuation : null,
        customFieldsValues,
        availableToBook: asset?.bookable !== "no",
        mainImage: mainImage || null,
        mainImageExpiration: mainImageExpiration || null,
        // Add barcodes if present
        barcodes: assetBarcodes.length > 0 ? assetBarcodes : undefined,
      });
    }

    // Set kit custody for imported assets after all assets have been created
    await setKitCustodyAfterAssetImport({
      data,
      kits,
      teamMembers: teamMembers as Record<string, { id: string; name: string }>,
    });

    return true;
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);
    const rawConstraintMessage = (() => {
      if (isShelfError && cause.cause instanceof Error) {
        return cause.cause.message;
      }

      if (cause instanceof Error) {
        return cause.message;
      }

      return undefined;
    })();

    if (
      rawConstraintMessage &&
      rawConstraintMessage.includes("AssetCustomFieldValue") &&
      rawConstraintMessage.includes("ensure_value_structure_and_types")
    ) {
      throw new ShelfError({
        cause,
        label,
        message:
          "We were unable to save numeric custom field values. Please ensure AMOUNT and NUMBER fields use plain numbers without currency symbols or letters (e.g., 600.00).",
        additionalData: {
          userId,
          organizationId,
          ...(isShelfError && cause.additionalData),
        },
        shouldBeCaptured: false,
      });
    }

    throw new ShelfError({
      cause,
      message: isShelfError
        ? cause?.message
        : "Something went wrong while creating assets from content import",
      additionalData: {
        userId,
        organizationId,
        ...(isShelfError && cause.additionalData),
      },
      label,
    });
  }
}

export async function createAssetsFromBackupImport({
  data,
  userId,
  organizationId,
}: {
  data: CreateAssetFromBackupImportPayload[];
  userId: User["id"];
  organizationId: Organization["id"];
}) {
  try {
    //TODO use concurrency control or it will overload the server
    await Promise.all(
      data.map(async (asset) => {
        /** Base data from asset */
        const d = {
          data: {
            title: asset.title,
            description: asset.description || null,
            mainImage: asset.mainImage || null,
            mainImageExpiration: oneDayFromNow(),
            userId,
            organizationId,
            status: asset.status,
            createdAt: new Date(asset.createdAt),
            updatedAt: new Date(asset.updatedAt),
            qrCodes: {
              create: [
                {
                  id: id(),
                  version: 0,
                  errorCorrection: ErrorCorrection["L"],
                  userId,
                  organizationId,
                },
              ],
            },
            valuation: asset.valuation ? +asset.valuation : null,
          },
        };

        /** Category */
        if (asset.category && Object.keys(asset?.category).length > 0) {
          const category = asset.category as Category;

          const existingCat = await sbDb
            .from("Category")
            .select("*")
            .eq("organizationId", organizationId)
            .eq("name", category.name)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) throw error;
              return data;
            });

          /** If it doesn't exist, create a new one */
          if (!existingCat) {
            const { data: newCat, error: catCreateError } = await sbDb
              .from("Category")
              .insert({
                organizationId,
                name: category.name,
                description: category.description || "",
                color: category.color,
                userId,
                createdAt: new Date(category.createdAt).toISOString(),
                updatedAt: new Date(category.updatedAt).toISOString(),
              })
              .select()
              .single();

            if (catCreateError || !newCat) {
              throw catCreateError || new Error("Failed to create category");
            }
            /** Add it to the data for creating the asset */
            Object.assign(d.data, {
              categoryId: newCat.id,
            });
          } else {
            /** Add it to the data for creating the asset */
            Object.assign(d.data, {
              categoryId: existingCat.id,
            });
          }
        }

        /** Location */
        if (asset.location && Object.keys(asset?.location).length > 0) {
          const location = asset.location as Location;

          const existingLoc = await sbDb
            .from("Location")
            .select("*")
            .eq("organizationId", organizationId)
            .eq("name", location.name)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) throw error;
              return data;
            });

          /** If it doesn't exist, create a new one */
          if (!existingLoc) {
            const { data: newLoc, error: locCreateError } = await sbDb
              .from("Location")
              .insert({
                name: location.name,
                description: location.description || "",
                address: location.address || "",
                organizationId,
                userId,
                createdAt: new Date(location.createdAt).toISOString(),
                updatedAt: new Date(location.updatedAt).toISOString(),
              })
              .select()
              .single();

            if (locCreateError || !newLoc) {
              throw locCreateError || new Error("Failed to create location");
            }
            /** Add it to the data for creating the asset */
            Object.assign(d.data, {
              locationId: newLoc.id,
            });
          } else {
            /** Add it to the data for creating the asset */
            Object.assign(d.data, {
              locationId: existingLoc.id,
            });
          }
        }

        /** Custody */
        if (asset.custody && Object.keys(asset?.custody).length > 0) {
          const { custodian } = asset.custody;

          const existingCustodian = await sbDb
            .from("TeamMember")
            .select("*")
            .is("deletedAt", null)
            .eq("organizationId", organizationId)
            .eq("name", custodian.name)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) throw error;
              return data;
            });

          if (!existingCustodian) {
            const { data: newCustodian, error: custodianCreateError } =
              await sbDb
                .from("TeamMember")
                .insert({
                  name: custodian.name,
                  organizationId,
                  createdAt: new Date(custodian.createdAt).toISOString(),
                  updatedAt: new Date(custodian.updatedAt).toISOString(),
                })
                .select()
                .single();

            if (custodianCreateError || !newCustodian) {
              throw (
                custodianCreateError ||
                new Error("Failed to create team member")
              );
            }

            Object.assign(d.data, {
              custody: {
                create: {
                  teamMemberId: newCustodian.id,
                },
              },
            });
          } else {
            Object.assign(d.data, {
              custody: {
                create: {
                  teamMemberId: existingCustodian.id,
                },
              },
            });
          }
        }

        /** Tags */
        if (asset.tags && asset.tags.length > 0) {
          const tagsNames = asset.tags.map((t) => t.name);
          // now we loop through the categories and check if they exist
          const tags: Record<string, string> = {};
          for (const tag of tagsNames) {
            const existingTag = await sbDb
              .from("Tag")
              .select("*")
              .eq("name", tag)
              .eq("organizationId", organizationId)
              .maybeSingle()
              .then(({ data, error }) => {
                if (error) throw error;
                return data;
              });

            if (!existingTag) {
              // if the tag doesn't exist, we create a new one
              const { data: newTag, error: tagCreateError } = await sbDb
                .from("Tag")
                .insert({
                  name: tag as string,
                  userId,
                  organizationId,
                })
                .select("id")
                .single();

              if (tagCreateError || !newTag) {
                throw tagCreateError || new Error("Failed to create tag");
              }
              tags[tag] = newTag.id;
            } else {
              // if the tag exists, we just update the id
              tags[tag] = existingTag.id;
            }
          }

          Object.assign(d.data, {
            tags:
              asset.tags.length > 0
                ? {
                    connect: asset.tags.map((tag) => ({ id: tags[tag.name] })),
                  }
                : undefined,
          });
        }

        /** Custom fields */
        if (asset.customFields && asset.customFields.length > 0) {
          const customFieldDef = asset.customFields.reduce(
            (res, { value, customField }) => {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { id, createdAt, updatedAt, ...rest } = customField;
              const options = value?.valueOption?.length
                ? [value?.valueOption]
                : undefined;
              res.push({ ...rest, options, userId, organizationId });
              return res;
            },
            [] as Array<CustomFieldDraftPayload>
          );

          const cfIds = await upsertCustomField(customFieldDef);

          Object.assign(d.data, {
            customFields: {
              create: asset.customFields.map((cf) => ({
                value: cf.value,
                // @ts-ignore
                customFieldId: cfIds[cf.customField.name].id,
              })),
            },
          });
        }

        /** Create the Asset */
        // KEPT AS PRISMA: Nested relation creates (tags, customFields) in import
        const { id: assetId } = await db.asset.create(d);

        /** Create notes */
        if (asset?.notes?.length > 0) {
          const { error: notesError } = await sbDb.from("Note").insert(
            asset.notes.map((note: Note) => ({
              content: note.content,
              type: note.type,
              assetId,
              userId,
              createdAt: new Date(note.createdAt).toISOString(),
              updatedAt: new Date(note.updatedAt).toISOString(),
            }))
          );

          if (notesError) throw notesError;
        }
      })
    );
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while creating assets from backup import",
      additionalData: { userId, organizationId },
      label,
    });
  }
}

export async function updateAssetBookingAvailability({
  id,
  availableToBook,
  organizationId,
}: Pick<Asset, "id" | "availableToBook" | "organizationId">) {
  try {
    const { data, error } = await sbDb
      .from("Asset")
      .update({ availableToBook })
      .eq("id", id)
      .eq("organizationId", organizationId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (cause) {
    throw maybeUniqueConstraintViolation(cause, "Asset", {
      additionalData: { id },
    });
  }
}

export async function updateAssetsWithBookingCustodians<T extends Asset>(
  assets: T[]
) {
  try {
    /** When assets are checked out, we want to make an extra query to get the custodian for those assets. */
    const checkedOutAssetsIds = assets
      .filter((a) => a.status === "CHECKED_OUT")
      .map((a) => a.id);

    if (checkedOutAssetsIds.length > 0) {
      /** We query again the assets that are checked-out so we can get the user via the booking*/

      // Split: fetch bookings for checked-out assets, then custodian details
      // 1. Get booking-asset join rows via _AssetToBooking
      const { data: bookingJoinRows, error: joinErr } = await sbDb
        .from("_AssetToBooking")
        .select("A, B")
        .in("A", checkedOutAssetsIds);

      if (joinErr) throw joinErr;

      const bookingIds = [...new Set((bookingJoinRows ?? []).map((r) => r.B))];

      // 2. Fetch bookings with ONGOING/OVERDUE status
      const { data: bookings, error: bookingsErr } =
        bookingIds.length > 0
          ? await sbDb
              .from("Booking")
              .select("id, custodianTeamMemberId, custodianUserId")
              .in("id", bookingIds)
              .in("status", ["ONGOING", "OVERDUE"])
          : { data: [] as any[], error: null };

      if (bookingsErr) throw bookingsErr;

      // 3. Fetch custodian users and team members in parallel
      const userIds = (bookings ?? [])
        .map((b: any) => b.custodianUserId)
        .filter(Boolean) as string[];
      const tmIds = (bookings ?? [])
        .map((b: any) => b.custodianTeamMemberId)
        .filter(Boolean) as string[];

      const [custodianUsers, custodianTeamMembers] = await Promise.all([
        userIds.length > 0
          ? sbDb
              .from("User")
              .select("id, firstName, lastName, profilePicture")
              .in("id", userIds)
              .then(({ data, error }) => {
                if (error) throw error;
                return data ?? [];
              })
          : Promise.resolve([]),
        tmIds.length > 0
          ? sbDb
              .from("TeamMember")
              .select("*")
              .in("id", tmIds)
              .then(({ data, error }) => {
                if (error) throw error;
                return data ?? [];
              })
          : Promise.resolve([]),
      ]);

      const userMap = new Map(custodianUsers.map((u) => [u.id, u]));
      const tmMap = new Map(custodianTeamMembers.map((tm) => [tm.id, tm]));

      // Build booking map: bookingId -> booking with resolved relations
      const bookingMap = new Map(
        (bookings ?? []).map((b: any) => [
          b.id,
          {
            id: b.id,
            custodianUser: b.custodianUserId
              ? (userMap.get(b.custodianUserId) ?? null)
              : null,
            custodianTeamMember: b.custodianTeamMemberId
              ? (tmMap.get(b.custodianTeamMemberId) ?? null)
              : null,
          },
        ])
      );

      // Build assetId -> bookings array
      const bookingsByAsset = new Map<string, any[]>();
      for (const row of bookingJoinRows ?? []) {
        const booking = bookingMap.get(row.B);
        if (booking) {
          const arr = bookingsByAsset.get(row.A) ?? [];
          arr.push(booking);
          bookingsByAsset.set(row.A, arr);
        }
      }

      // Assemble in the same shape the downstream code expects
      const assetsWithCustodians = checkedOutAssetsIds.map((assetId) => ({
        id: assetId,
        bookings: bookingsByAsset.get(assetId) ?? [],
      }));

      /**
       * We take the first booking of the array and extract the user from it and add it to the asset
       */
      assets = assets.map((a) => {
        const assetWithUser = assetsWithCustodians.find(
          (awu) => awu.id === a.id
        );
        const booking = assetWithUser?.bookings[0];
        const custodianUser = booking?.custodianUser;
        const custodianTeamMember = booking?.custodianTeamMember;

        if (checkedOutAssetsIds.includes(a.id)) {
          /** If there is a custodian user, use its data to display the name */
          if (custodianUser) {
            return {
              ...a,
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
            };
          }

          /** If there is a custodian teamMember, use its name */
          if (custodianTeamMember) {
            return {
              ...a,
              custody: {
                custodian: {
                  name: custodianTeamMember.name,
                },
              },
            };
          }

          /** Data integrity edge case: asset is CHECKED_OUT but booking has no custodian assigned */
          Logger.warn(
            new ShelfError({
              cause: null,
              message: "Couldn't find custodian for asset",
              additionalData: { asset: a },
              label,
            })
          );
        }

        return a;
      });
    }
    return assets;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Fail to update assets with booking custodians",
      additionalData: { assets },
      label,
    });
  }
}

export async function updateAssetQrCode({
  assetId,
  newQrId,
  organizationId,
}: {
  organizationId: string;
  assetId: string;
  newQrId: string;
}) {
  // Disconnect all existing QR codes
  try {
    // Disconnect all existing QR codes by setting assetId to null
    const { error: disconnectError } = await sbDb
      .from("Qr")
      .update({ assetId: null })
      .eq("assetId", assetId);

    if (disconnectError) {
      throw new ShelfError({
        cause: disconnectError,
        message: "Couldn't disconnect existing codes",
        label,
        additionalData: { assetId, organizationId, newQrId },
      });
    }

    // Connect the new QR code by setting its assetId
    const { error: connectError } = await sbDb
      .from("Qr")
      .update({ assetId })
      .eq("id", newQrId);

    if (connectError) {
      throw new ShelfError({
        cause: connectError,
        message: "Couldn't connect the new QR code",
        label,
        additionalData: { assetId, organizationId, newQrId },
      });
    }
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while updating asset QR code",
      label,
      additionalData: { assetId, organizationId, newQrId },
    });
  }
}

export async function bulkDeleteAssets({
  assetIds,
  organizationId,
  userId,
  currentSearchParams,
  settings,
}: {
  assetIds: Asset["id"][];
  organizationId: Asset["organizationId"];
  userId: User["id"];
  currentSearchParams?: string | null;
  settings: AssetIndexSettingsRow;
}) {
  try {
    // Resolve IDs (works for both simple and advanced mode)
    const resolvedIds = await resolveAssetIdsForBulkOperation({
      assetIds,
      organizationId,
      currentSearchParams,
      settings,
    });

    /**
     * We have to remove the images of assets so we have to make this query first
     */
    const { data: assets, error: findError } = await sbDb
      .from("Asset")
      .select("id, mainImage")
      .in("id", resolvedIds)
      .eq("organizationId", organizationId);

    if (findError) {
      throw new ShelfError({
        cause: findError,
        message: "Failed to fetch assets for bulk delete",
        label,
      });
    }

    try {
      const { error: deleteError } = await sbDb
        .from("Asset")
        .delete()
        .in(
          "id",
          (assets ?? []).map((asset) => asset.id)
        );

      if (deleteError) throw deleteError;

      /** Deleting images of the assets (if any) */
      const assetsWithImages = assets.filter((asset) => !!asset.mainImage);
      await Promise.all(
        assetsWithImages.map((asset) =>
          deleteOtherImages({
            userId,
            assetId: asset.id,
            data: { path: `main-image-${asset.id}.jpg` },
          })
        )
      );
    } catch (cause) {
      throw new ShelfError({
        cause,
        message:
          "Something went wrong while deleting assets. The transaction was failed.",
        label: "Assets",
      });
    }
  } catch (cause) {
    const message =
      cause instanceof ShelfError
        ? cause.message
        : "Something went wrong while bulk deleting assets";

    throw new ShelfError({
      cause,
      message,
      additionalData: { assetIds, organizationId },
      label,
    });
  }
}

export async function bulkCheckOutAssets({
  userId,
  assetIds,
  custodianId,
  custodianName,
  organizationId,
  currentSearchParams,
  settings,
}: {
  userId: User["id"];
  assetIds: Asset["id"][];
  custodianId: TeamMember["id"];
  custodianName: TeamMember["name"];
  organizationId: Asset["organizationId"];
  currentSearchParams?: string | null;
  settings: AssetIndexSettingsRow;
}) {
  try {
    // Resolve IDs (works for both simple and advanced mode)
    const resolvedIds = await resolveAssetIdsForBulkOperation({
      assetIds,
      organizationId,
      currentSearchParams,
      settings,
    });

    /**
     * In order to make notes for the assets we have to make this query to get info about assets
     */
    const [assets, user, custodianTeamMember] = await Promise.all([
      sbDb
        .from("Asset")
        .select("id, title, status")
        .in("id", resolvedIds)
        .eq("organizationId", organizationId)
        .then(({ data, error }) => {
          if (error) {
            throw new ShelfError({
              cause: error,
              message: "Failed to fetch assets for bulk checkout",
              label,
            });
          }
          return data ?? [];
        }),
      getUserByID(userId, {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        } satisfies Prisma.UserSelect,
      }),
      sbDb
        .from("TeamMember")
        .select("name, userId")
        .eq("id", custodianId)
        .single()
        .then(async ({ data: tm, error: tmError }) => {
          if (tmError) throw tmError;
          let user: {
            id: string;
            firstName: string | null;
            lastName: string | null;
          } | null = null;
          if (tm?.userId) {
            const { data: u, error: uError } = await sbDb
              .from("User")
              .select("id, firstName, lastName")
              .eq("id", tm.userId)
              .single();
            if (uError) throw uError;
            user = u;
          }
          return { name: tm?.name ?? null, user };
        }),
    ]);

    const assetsNotAvailable = assets.some(
      (asset) => asset.status !== "AVAILABLE"
    );

    if (assetsNotAvailable) {
      throw new ShelfError({
        cause: null,
        message:
          "There are some unavailable assets. Please make sure you are selecting only available assets.",
        label: "Assets",
        shouldBeCaptured: false,
      });
    }

    /**
     * updateMany does not allow to create nested relationship rows
     * so we have to make two queries to bulk assign custody of assets
     * 1. Create custodies for all assets
     * 2. Update status of all assets to IN_CUSTODY
     */
    /** Pre-compute note content */
    const actor = wrapUserLinkForNote({
      id: userId,
      firstName: user.firstName,
      lastName: user.lastName,
    });
    const custodianDisplay = custodianTeamMember
      ? wrapCustodianForNote({ teamMember: custodianTeamMember })
      : `**${custodianName.trim()}**`;
    const noteContent = `${actor} granted ${custodianDisplay} custody.`;

    /** Atomically create custody, update status, create notes via RPC */
    const { error: rpcError } = await sbDb.rpc("shelf_asset_bulk_checkout", {
      p_asset_ids: assets.map((asset) => asset.id),
      p_custodian_id: custodianId,
      p_user_id: userId,
      p_note_content: noteContent,
    });
    if (rpcError) throw rpcError;

    return true;
  } catch (cause) {
    const message =
      cause instanceof ShelfError
        ? cause.message
        : "Something went wrong while bulk checking out assets.";

    throw new ShelfError({
      cause,
      message,
      additionalData: { assetIds, custodianId },
      label,
    });
  }
}

export async function bulkCheckInAssets({
  userId,
  assetIds,
  organizationId,
  currentSearchParams,
  settings,
}: {
  userId: User["id"];
  assetIds: Asset["id"][];
  organizationId: Asset["organizationId"];
  currentSearchParams?: string | null;
  settings: AssetIndexSettingsRow;
}) {
  try {
    // Resolve IDs (works for both simple and advanced mode)
    const resolvedIds = await resolveAssetIdsForBulkOperation({
      assetIds,
      organizationId,
      currentSearchParams,
      settings,
    });

    /**
     * In order to make notes for the assets we have to make this query to get info about assets
     */
    // Split: fetch assets, custodies, custodians, users in sequence
    const [assetRows, user] = await Promise.all([
      sbDb
        .from("Asset")
        .select("id, title")
        .in("id", resolvedIds)
        .eq("organizationId", organizationId)
        .then(({ data, error }) => {
          if (error) throw error;
          return data ?? [];
        }),
      getUserByID(userId, {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        } satisfies Prisma.UserSelect,
      }),
    ]);

    const assetIdsForCustody = assetRows.map((a) => a.id);

    // Fetch custodies for these assets
    const { data: custodyRows, error: custodyErr } = await sbDb
      .from("Custody")
      .select("id, assetId, teamMemberId")
      .in("assetId", assetIdsForCustody);

    if (custodyErr) throw custodyErr;

    // Fetch team members (custodians) with their user relations
    const tmIds = (custodyRows ?? []).map((c) => c.teamMemberId);
    const { data: teamMembers, error: tmErr } =
      tmIds.length > 0
        ? await sbDb.from("TeamMember").select("*").in("id", tmIds)
        : { data: [] as any[], error: null };

    if (tmErr) throw tmErr;

    const tmUserIds = (teamMembers ?? [])
      .map((tm: any) => tm.userId)
      .filter(Boolean) as string[];
    const { data: tmUsers, error: tmUserErr } =
      tmUserIds.length > 0
        ? await sbDb.from("User").select("*").in("id", tmUserIds)
        : { data: [] as any[], error: null };

    if (tmUserErr) throw tmUserErr;

    const userMap = new Map((tmUsers ?? []).map((u: any) => [u.id, u]));
    const tmMap = new Map(
      (teamMembers ?? []).map((tm: any) => [
        tm.id,
        { ...tm, user: tm.userId ? (userMap.get(tm.userId) ?? null) : null },
      ])
    );
    const custodyByAsset = new Map(
      (custodyRows ?? []).map((c) => [
        c.assetId,
        {
          id: c.id,
          custodian: tmMap.get(c.teamMemberId) ?? null,
        },
      ])
    );

    // Assemble assets with custody in the shape expected downstream
    const assets = assetRows.map((a) => ({
      ...a,
      custody: custodyByAsset.get(a.id) ?? null,
    }));

    const hasAssetsWithoutCustody = assets.some((asset) => !asset.custody);

    if (hasAssetsWithoutCustody) {
      throw new ShelfError({
        cause: null,
        message:
          "There are some assets without custody. Please make sure you are selecting assets with custody.",
        label: "Assets",
        shouldBeCaptured: false,
      });
    }

    /**
     * updateMany does not allow to update nested relationship rows
     * so we have to make two queries to bulk release custody of assets
     * 1. Delete all custodies for all assets
     * 2. Update status of all assets to AVAILABLE
     */
    /** Pre-compute custody IDs and per-asset note contents */
    const custodyIds = assets.map((asset) => {
      if (!asset.custody) {
        throw new ShelfError({
          cause: null,
          label: "Assets",
          message: "Could not find custody over asset.",
        });
      }
      return asset.custody.id;
    });

    const noteContents = assets.map(
      (asset) =>
        `**${user.firstName?.trim()} ${
          user.lastName
        }** has released **${resolveTeamMemberName(
          asset.custody!.custodian
        )}'s** custody over **${asset.title?.trim()}**`
    );

    /** Atomically delete custody, update status, create notes via RPC */
    const { error: rpcError } = await sbDb.rpc("shelf_asset_bulk_checkin", {
      p_custody_ids: custodyIds,
      p_asset_ids: assets.map((asset) => asset.id),
      p_user_id: userId,
      p_note_contents: noteContents,
    });
    if (rpcError) throw rpcError;

    return true;
  } catch (cause) {
    const message =
      cause instanceof ShelfError
        ? cause.message
        : "Something went wrong while bulk checking in assSets.";

    throw new ShelfError({
      cause,
      message,
      additionalData: { assetIds, userId },
      label,
    });
  }
}

export async function bulkUpdateAssetLocation({
  userId,
  assetIds,
  organizationId,
  newLocationId,
  currentSearchParams,
  settings,
}: {
  userId: User["id"];
  assetIds: Asset["id"][];
  organizationId: Asset["organizationId"];
  newLocationId?: Location["id"] | null;
  currentSearchParams?: string | null;
  settings: AssetIndexSettingsRow;
}) {
  try {
    // Resolve IDs (works for both simple and advanced mode)
    const resolvedIds = await resolveAssetIdsForBulkOperation({
      assetIds,
      organizationId,
      currentSearchParams,
      settings,
    });

    /** We have to create notes for all the assets so we have make this query */
    // Split: fetch assets with locationId/kitId, then resolve location and kit details
    const [assetRows, user] = await Promise.all([
      sbDb
        .from("Asset")
        .select("id, title, locationId, kitId")
        .in("id", resolvedIds)
        .eq("organizationId", organizationId)
        .then(({ data, error }) => {
          if (error) throw error;
          return data ?? [];
        }),
      getUserByID(userId, {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        } satisfies Prisma.UserSelect,
      }),
    ]);

    // Resolve locations and kits in parallel
    const locIds = assetRows
      .map((a) => a.locationId)
      .filter(Boolean) as string[];
    const kitIdsToResolve = assetRows
      .map((a) => a.kitId)
      .filter(Boolean) as string[];

    const [locationRows, kitRows] = await Promise.all([
      locIds.length > 0
        ? sbDb
            .from("Location")
            .select("*")
            .in("id", locIds)
            .then(({ data, error }) => {
              if (error) throw error;
              return data ?? [];
            })
        : Promise.resolve([]),
      kitIdsToResolve.length > 0
        ? sbDb
            .from("Kit")
            .select("id, name")
            .in("id", kitIdsToResolve)
            .then(({ data, error }) => {
              if (error) throw error;
              return data ?? [];
            })
        : Promise.resolve([]),
    ]);

    const locMap = new Map(locationRows.map((l) => [l.id, l]));
    const kitMap = new Map(kitRows.map((k) => [k.id, k]));

    const assets = assetRows.map((a) => ({
      id: a.id,
      title: a.title,
      location: a.locationId ? (locMap.get(a.locationId) ?? null) : null,
      kit: a.kitId ? (kitMap.get(a.kitId) ?? null) : null,
    }));

    // Check if any assets belong to kits and prevent bulk location updates
    const assetsInKits = assets.filter((asset) => asset.kit);
    if (assetsInKits.length > 0) {
      const kitNames = Array.from(
        new Set(assetsInKits.map((asset) => asset.kit?.name))
      ).join(", ");
      throw new ShelfError({
        cause: null,
        message: `Cannot update location for assets that belong to kits: ${kitNames}. Update the kit locations instead.`,
        additionalData: {
          assetIds: assetsInKits.map((asset) => asset.id),
          kitNames,
          userId,
          organizationId,
        },
        label: "Assets",
        status: 400,
        shouldBeCaptured: false,
      });
    }

    const newLocation = newLocationId
      ? await sbDb
          .from("Location")
          .select("*")
          .eq("id", newLocationId)
          .eq("organizationId", organizationId)
          .maybeSingle()
          .then(({ data, error }) => {
            if (error) {
              throw new ShelfError({
                cause: error,
                message: "Failed to fetch location",
                additionalData: { newLocationId },
                label,
              });
            }
            return data;
          })
      : null;

    // Filter out assets already at the target location
    const assetsToUpdate = assets.filter(
      (a) => a.location?.id !== newLocation?.id
    );

    if (assetsToUpdate.length > 0) {
      /** Pre-compute note contents for each asset */
      const assetIdsToUpdate = assetsToUpdate.map((asset) => asset.id);
      const noteContents = assetsToUpdate.map((asset) => {
        const isRemoving = !newLocationId;
        return getLocationUpdateNoteContent({
          currentLocation: asset.location,
          newLocation,
          userId,
          firstName: user?.firstName ?? "",
          lastName: user?.lastName ?? "",
          isRemoving,
        });
      });

      /** Atomically update locations and create notes via RPC */
      const { error: rpcError } = await sbDb.rpc(
        "shelf_asset_bulk_update_location",
        {
          p_asset_ids: assetIdsToUpdate,
          p_new_location_id: newLocation?.id ?? null,
          p_note_contents: noteContents,
          p_note_user_id: userId,
        }
      );
      if (rpcError) throw rpcError;
    }

    // Create location activity notes
    const userLink = wrapUserLinkForNote({
      id: userId,
      firstName: user?.firstName,
      lastName: user?.lastName,
    });
    // Filter out assets already at the target location
    const actuallyChanged = assets.filter(
      (a) => a.location?.id !== newLocation?.id
    );
    const assetData = actuallyChanged.map((a) => ({
      id: a.id,
      title: a.title,
    }));

    // Group assets by their previous location
    const byPrevLocation = new Map<
      string,
      { name: string; assets: typeof assetData }
    >();
    for (const asset of actuallyChanged) {
      if (!asset.location) continue;
      const existing = byPrevLocation.get(asset.location.id);
      if (existing) {
        existing.assets.push({ id: asset.id, title: asset.title });
      } else {
        byPrevLocation.set(asset.location.id, {
          name: asset.location.name,
          assets: [{ id: asset.id, title: asset.title }],
        });
      }
    }

    // Note on the new location
    if (newLocation && assetData.length > 0) {
      const newLocLink = wrapLinkForNote(
        `/locations/${newLocation.id}`,
        newLocation.name
      );
      const assetMarkup = wrapAssetsWithDataForNote(assetData, "added");

      const prevLocLinks = [...byPrevLocation.entries()].map(([id, { name }]) =>
        wrapLinkForNote(`/locations/${id}`, name)
      );
      const movedFromSuffix =
        prevLocLinks.length > 0
          ? ` Moved from ${prevLocLinks.join(", ")}.`
          : "";

      await createSystemLocationNote({
        locationId: newLocation.id,
        content: `${userLink} added ${assetMarkup} to ${newLocLink}.${movedFromSuffix}`,
        userId,
      });
    }

    // Removal notes on previous locations
    for (const [locId, { name, assets: locAssets }] of byPrevLocation) {
      const prevLocLink = wrapLinkForNote(`/locations/${locId}`, name);
      const assetMarkup = wrapAssetsWithDataForNote(locAssets, "removed");
      const movedToSuffix = newLocation
        ? ` Moved to ${wrapLinkForNote(
            `/locations/${newLocation.id}`,
            newLocation.name
          )}.`
        : "";
      await createSystemLocationNote({
        locationId: locId,
        content: `${userLink} removed ${assetMarkup} from ${prevLocLink}.${movedToSuffix}`,
        userId,
      });
    }

    return true;
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);

    throw new ShelfError({
      cause,
      message: isShelfError
        ? cause.message
        : "Something went wrong while bulk updating location.",
      additionalData: { userId, assetIds, newLocationId },
      label,
    });
  }
}

export async function bulkUpdateAssetCategory({
  userId,
  assetIds,
  organizationId,
  categoryId,
  currentSearchParams,
  settings,
}: {
  userId: string;
  assetIds: Asset["id"][];
  organizationId: Asset["organizationId"];
  categoryId: Asset["categoryId"];
  currentSearchParams?: string | null;
  settings: AssetIndexSettingsRow;
}) {
  try {
    // Resolve IDs (works for both simple and advanced mode)
    const resolvedIds = await resolveAssetIdsForBulkOperation({
      assetIds,
      organizationId,
      currentSearchParams,
      settings,
    });

    const { error: updateError } = await sbDb
      .from("Asset")
      .update({
        /** If nothing is selected then we have to remove the relation and set category to null */
        categoryId: !categoryId ? null : categoryId,
      })
      .in("id", resolvedIds)
      .eq("organizationId", organizationId);

    if (updateError) throw updateError;

    return true;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while bulk updating category.",
      additionalData: { userId, assetIds, organizationId, categoryId },
      label,
    });
  }
}

export async function bulkAssignAssetTags({
  userId,
  assetIds,
  organizationId,
  tagsIds,
  currentSearchParams,
  remove,
  settings,
}: {
  userId: string;
  assetIds: Asset["id"][];
  organizationId: Asset["organizationId"];
  tagsIds: string[];
  currentSearchParams?: string | null;
  remove: boolean;
  settings: AssetIndexSettingsRow;
}) {
  try {
    // Resolve IDs (works for both simple and advanced mode)
    const resolvedIds = await resolveAssetIdsForBulkOperation({
      assetIds,
      organizationId,
      currentSearchParams,
      settings,
    });

    if (resolvedIds.length === 0) {
      return true;
    }

    const loadUserForNotes = createLoadUserForNotes(userId);

    // Split: fetch asset-tag join rows, then fetch tag details
    const { data: joinRows, error: joinError } = await sbDb
      .from("_AssetToTag")
      .select("A, B")
      .in("A", resolvedIds);

    if (joinError) throw joinError;

    const tagIdsFromJoin = [...new Set((joinRows ?? []).map((r) => r.B))];
    const { data: tagRows, error: tagError } = await sbDb
      .from("Tag")
      .select("id, name")
      .in("id", tagIdsFromJoin);

    if (tagError) throw tagError;

    const tagMap = new Map((tagRows ?? []).map((t) => [t.id, t]));

    const previousTagsByAssetId = (joinRows ?? []).reduce<
      Map<string, TagSummary[]>
    >((acc, row) => {
      const tag = tagMap.get(row.B);
      if (tag) {
        const existing = acc.get(row.A) ?? [];
        existing.push({ id: tag.id, name: tag.name ?? "" });
        acc.set(row.A, existing);
      }
      return acc;
    }, new Map());

    // Update _AssetToTag join table directly for each asset
    const updatePromises = resolvedIds.map(async (assetId) => {
      if (remove) {
        // Delete join rows for disconnecting tags
        const { error: delError } = await sbDb
          .from("_AssetToTag")
          .delete()
          .eq("A", assetId)
          .in("B", tagsIds);

        if (delError) throw delError;
      } else {
        // Insert join rows for connecting tags (ignore duplicates)
        const rows = tagsIds.map((tagId) => ({ A: assetId, B: tagId }));
        const { error: insError } = await sbDb
          .from("_AssetToTag")
          .upsert(rows, { onConflict: "A,B", ignoreDuplicates: true });

        if (insError) throw insError;
      }

      // Fetch current tags for this asset after update
      const { data: currentJoinRows, error: cjError } = await sbDb
        .from("_AssetToTag")
        .select("B")
        .eq("A", assetId);

      if (cjError) throw cjError;

      const currentTagIds = (currentJoinRows ?? []).map((r) => r.B);
      const { data: currentTags, error: ctError } = await sbDb
        .from("Tag")
        .select("id, name")
        .in("id", currentTagIds);

      if (ctError) throw ctError;

      return {
        id: assetId,
        tags: (currentTags ?? []).map((t) => ({
          id: t.id,
          name: t.name ?? "",
        })),
      };
    });

    const updatedAssets = await Promise.all(updatePromises);

    await Promise.all(
      updatedAssets.map((asset) =>
        createTagChangeNoteIfNeeded({
          assetId: asset.id,
          userId,
          previousTags: previousTagsByAssetId.get(asset.id) ?? [],
          currentTags: asset.tags,
          loadUserForNotes,
        })
      )
    );

    return true;
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);

    throw new ShelfError({
      cause,
      message: isShelfError
        ? cause.message
        : "Something went wrong while bulk updating tags.",
      additionalData: { userId, assetIds, organizationId, tagsIds },
      label,
    });
  }
}

export async function bulkMarkAvailability({
  organizationId,
  assetIds,
  type,
  currentSearchParams,
  settings,
}: {
  organizationId: Asset["organizationId"];
  assetIds: Asset["id"][];
  type: "available" | "unavailable";
  currentSearchParams?: string | null;
  settings: AssetIndexSettingsRow;
}) {
  try {
    // Resolve IDs (works for both simple and advanced mode)
    const resolvedIds = await resolveAssetIdsForBulkOperation({
      assetIds,
      organizationId,
      currentSearchParams,
      settings,
    });

    // Simple, consistent where clause
    const { error: updateError } = await sbDb
      .from("Asset")
      .update({ availableToBook: type === "available" })
      .in("id", resolvedIds)
      .eq("organizationId", organizationId)
      .eq("availableToBook", type === "unavailable");

    if (updateError) throw updateError;

    return true;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while marking assets as available.",
      additionalData: { assetIds, organizationId },
      label,
    });
  }
}

/**
 * Relinks an asset to a different QR code, unlinking any previous code.
 * Throws if the QR belongs to another org, asset, or kit.
 */
export async function relinkAssetQrCode({
  qrId,
  assetId,
  organizationId,
  userId,
}: {
  qrId: Qr["id"];
  userId: User["id"];
  assetId: Asset["id"];
  organizationId: Organization["id"];
}) {
  const [qr, user, asset] = await Promise.all([
    getQr({ id: qrId }),
    getUserByID(userId, {
      select: {
        id: true,
        firstName: true,
        lastName: true,
      } satisfies Prisma.UserSelect,
    }),
    // Fetch asset's QR codes via Qr table instead of nested include
    sbDb
      .from("Qr")
      .select("id")
      .eq("assetId", assetId)
      .then(({ data: qrRows, error: qrErr }) => {
        if (qrErr) throw qrErr;
        return qrRows ? { qrCodes: qrRows } : null;
      }),
  ]);

  /** User cannot link qr code of other organization */
  if (qr.organizationId && qr.organizationId !== organizationId) {
    throw new ShelfError({
      cause: null,
      title: "QR not valid.",
      message: "This QR code does not belong to your organization",
      label: "QR",
    });
  }

  if (qr.kitId) {
    throw new ShelfError({
      cause: null,
      title: "QR already linked.",
      message:
        "You cannot link to this code because its already linked to another kit. Delete the other kit to free up the code and try again.",
      label: "QR",
      shouldBeCaptured: false,
    });
  }

  if (qr.assetId && qr.assetId !== assetId) {
    throw new ShelfError({
      cause: null,
      title: "QR already linked.",
      message:
        "You cannot link to this code because its already linked to another asset. Delete the other asset to free up the code and try again.",
      label: "QR",
      shouldBeCaptured: false,
    });
  }

  const oldQrCode = asset?.qrCodes[0];

  await Promise.all([
    sbDb
      .from("Qr")
      .update({ organizationId, userId })
      .eq("id", qr.id)
      .then(({ error }) => {
        if (error) {
          throw new ShelfError({
            cause: error,
            message: "Failed to update QR code",
            additionalData: { qrId: qr.id },
            label,
          });
        }
      }),
    // Disconnect all existing QR codes from this asset, then connect the new one
    sbDb
      .from("Qr")
      .update({ assetId: null })
      .eq("assetId", assetId)
      .then(({ error }) => {
        if (error) throw error;
      })
      .then(() =>
        sbDb
          .from("Qr")
          .update({ assetId })
          .eq("id", qr.id)
          .then(({ error }) => {
            if (error) throw error;
          })
      ),
    createNote({
      assetId,
      userId,
      type: "UPDATE",
      content: `${wrapUserLinkForNote({
        id: userId,
        firstName: user.firstName,
        lastName: user.lastName,
      })} changed QR code ${
        oldQrCode ? `from **${oldQrCode.id}**` : ""
      } to **${qrId}**.`,
    }),
  ]);
}

export async function getUserAssetsTabLoaderData({
  userId,
  request,
  organizationId,
}: {
  userId: User["id"];
  request: Request;
  organizationId: Organization["id"];
}) {
  try {
    const { filters } = await getFiltersFromRequest(
      request,
      organizationId,
      { name: "assetFilter_v2", path: "/" } // Use root path for RR7 single fetch
    );

    const filtersSearchParams = new URLSearchParams(filters);
    filtersSearchParams.set("teamMember", userId);

    const {
      search,
      totalAssets,
      perPage,
      page,
      categories,
      tags,
      assets,
      totalPages,
      cookie,
      totalCategories,
      totalTags,
      locations,
      totalLocations,
    } = await getPaginatedAndFilterableAssets({
      request,
      organizationId,
      filters: filtersSearchParams.toString(),
    });

    const modelName = {
      singular: "asset",
      plural: "assets",
    };

    const userPrefsCookie = await userPrefs.serialize(cookie);
    const headers = [setCookie(userPrefsCookie)];

    return {
      search,
      totalItems: totalAssets,
      perPage,
      page,
      categories,
      tags,
      items: assets,
      totalPages,
      cookie,
      totalCategories,
      totalTags,
      locations,
      totalLocations,
      modelName,
      headers,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      label,
      message: "Something went wrong while fetching assets",
    });
  }
}

/**
 * This function returns the categories, tags and locations
 * including already selected items
 *
 * e.g if `id1` is selected for tag then it will return `[id1, ...other tags]` for tags
 */
export async function getEntitiesWithSelectedValues({
  organizationId,
  allSelectedEntries,
  selectedTagIds = [],
  selectedCategoryIds = [],
  selectedLocationIds = [],
}: {
  organizationId: Organization["id"];
  allSelectedEntries: AllowedModelNames[];
  selectedTagIds: Array<Tag["id"]>;
  selectedCategoryIds: Array<Category["id"]>;
  selectedLocationIds: Array<Location["id"]>;
}) {
  const [
    // Categories
    categoryExcludedSelected,
    selectedCategories,
    totalCategories,

    // Tags
    tagsExcludedSelected,
    selectedTags,
    totalTags,

    // Locations
    locationExcludedSelected,
    selectedLocations,
    totalLocations,
  ] = await Promise.all([
    /** Categories start */
    sbDb
      .from("Category")
      .select("*")
      .eq("organizationId", organizationId)
      .not("id", "in", `(${selectedCategoryIds.join(",")})`)
      .limit(allSelectedEntries.includes("category") ? 1000 : 12)
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      }),
    sbDb
      .from("Category")
      .select("*")
      .eq("organizationId", organizationId)
      .in("id", selectedCategoryIds)
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      }),
    sbDb
      .from("Category")
      .select("id", { count: "exact", head: true })
      .eq("organizationId", organizationId)
      .then(({ count, error }) => {
        if (error) throw error;
        return count ?? 0;
      }),
    /** Categories end */

    /** Tags start */
    (() => {
      let query = sbDb
        .from("Tag")
        .select("*")
        .eq("organizationId", organizationId)
        .or(`useFor.eq.{},useFor.cs.{ASSET}`)
        .order("name", { ascending: true });

      if (selectedTagIds.length > 0) {
        query = query.not("id", "in", `(${selectedTagIds.join(",")})`);
      }

      if (!allSelectedEntries.includes("tag")) {
        query = query.limit(12);
      }

      return query.then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      });
    })(),
    sbDb
      .from("Tag")
      .select("*")
      .eq("organizationId", organizationId)
      .in("id", selectedTagIds)
      .or(`useFor.eq.{},useFor.cs.{ASSET}`)
      .order("name", { ascending: true })
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      }),
    sbDb
      .from("Tag")
      .select("id", { count: "exact", head: true })
      .eq("organizationId", organizationId)
      .or(`useFor.eq.{},useFor.cs.{ASSET}`)
      .then(({ count, error }) => {
        if (error) throw error;
        return count ?? 0;
      }),
    /** Tags end */

    /** Location start */
    sbDb
      .from("Location")
      .select("*")
      .eq("organizationId", organizationId)
      .not("id", "in", `(${selectedLocationIds.join(",")})`)
      .limit(allSelectedEntries.includes("location") ? 1000 : 12)
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      }),
    sbDb
      .from("Location")
      .select("*")
      .eq("organizationId", organizationId)
      .in("id", selectedLocationIds)
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      }),
    sbDb
      .from("Location")
      .select("id", { count: "exact", head: true })
      .eq("organizationId", organizationId)
      .then(({ count, error }) => {
        if (error) throw error;
        return count ?? 0;
      }),
    /** Location end */
  ]);

  return {
    categories: [...selectedCategories, ...categoryExcludedSelected],
    totalCategories,
    tags: [...selectedTags, ...tagsExcludedSelected],
    totalTags,
    locations: [...selectedLocations, ...locationExcludedSelected],
    totalLocations,
  };
}

export async function getCategoriesForCreateAndEdit({
  organizationId,
  request,
  defaultCategory,
}: {
  organizationId: Organization["id"];
  request: Request;
  defaultCategory?: string | string[] | null;
}) {
  const searchParams = getCurrentSearchParams(request);
  const categorySelected =
    searchParams.get("category") ?? defaultCategory ?? "";
  const getAllEntries = searchParams.getAll("getAll") as AllowedModelNames[];

  try {
    const [categoryExcludedSelected, selectedCategories, totalCategories] =
      await Promise.all([
        (() => {
          let query = sbDb
            .from("Category")
            .select("*")
            .eq("organizationId", organizationId);
          if (Array.isArray(categorySelected)) {
            query = query.not("id", "in", `(${categorySelected.join(",")})`);
          } else {
            query = query.neq("id", categorySelected);
          }
          if (!getAllEntries.includes("category")) {
            query = query.limit(12);
          }
          return query.then(({ data, error }) => {
            if (error) throw error;
            return data ?? [];
          });
        })(),
        (() => {
          let query = sbDb
            .from("Category")
            .select("*")
            .eq("organizationId", organizationId);
          if (Array.isArray(categorySelected)) {
            query = query.in("id", categorySelected);
          } else {
            query = query.eq("id", categorySelected);
          }
          return query.then(({ data, error }) => {
            if (error) throw error;
            return data ?? [];
          });
        })(),
        sbDb
          .from("Category")
          .select("id", { count: "exact", head: true })
          .eq("organizationId", organizationId)
          .then(({ count, error }) => {
            if (error) throw error;
            return count ?? 0;
          }),
      ]);

    return {
      categories: [...selectedCategories, ...categoryExcludedSelected],
      totalCategories,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while fetching categories",
      additionalData: { organizationId, categorySelected },
      label,
    });
  }
}

export async function getLocationsForCreateAndEdit({
  organizationId,
  request,
  defaultLocation,
}: {
  organizationId: Organization["id"];
  request: Request;
  defaultLocation?: string | null;
}) {
  try {
    const searchParams = getCurrentSearchParams(request);
    const locationSelected =
      searchParams.get("location") ?? defaultLocation ?? "";
    const getAllEntries = searchParams.getAll("getAll") as AllowedModelNames[];

    const [locationExcludedSelected, selectedLocation, totalLocations] =
      await Promise.all([
        (() => {
          let query = sbDb
            .from("Location")
            .select("*")
            .eq("organizationId", organizationId)
            .neq("id", locationSelected);
          if (!getAllEntries.includes("location")) {
            query = query.limit(12);
          }
          return query.then(({ data, error }) => {
            if (error) throw error;
            return data ?? [];
          });
        })(),
        sbDb
          .from("Location")
          .select("*")
          .eq("organizationId", organizationId)
          .eq("id", locationSelected)
          .then(({ data, error }) => {
            if (error) throw error;
            return data ?? [];
          }),
        sbDb
          .from("Location")
          .select("id", { count: "exact", head: true })
          .eq("organizationId", organizationId)
          .then(({ count, error }) => {
            if (error) throw error;
            return count ?? 0;
          }),
      ]);

    return {
      locations: [...selectedLocation, ...locationExcludedSelected],
      totalLocations,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while fetching tags",
      additionalData: { organizationId, defaultLocation },
      label,
    });
  }
}
