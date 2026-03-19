import type {
  Prisma,
  User,
  Location,
  Organization,
  UserOrganization,
  Asset,
  Kit,
  KitStatus,
} from "@prisma/client";
import { BookingStatus } from "@prisma/client";
import { db } from "~/database/db.server";
import { sbDb } from "~/database/supabase.server";
import { getSupabaseAdmin } from "~/integrations/supabase/client";
import {
  DEFAULT_MAX_IMAGE_UPLOAD_SIZE,
  PUBLIC_BUCKET,
} from "~/utils/constants";
import type { ErrorLabel } from "~/utils/error";
import {
  ShelfError,
  isLikeShelfError,
  isNotFoundError,
  maybeUniqueConstraintViolation,
} from "~/utils/error";
import { geolocate } from "~/utils/geolocate.server";
import { getRedirectUrlFromRequest } from "~/utils/http";
import { getCurrentSearchParams } from "~/utils/http.server";
import { id } from "~/utils/id/id.server";
import { ALL_SELECTED_KEY } from "~/utils/list";
import {
  wrapDescriptionForNote,
  wrapLinkForNote,
  wrapUserLinkForNote,
} from "~/utils/markdoc-wrappers";
import {
  getFileUploadPath,
  parseFileFormData,
  removePublicFile,
} from "~/utils/storage.server";
import {
  formatLocationLink,
  buildAssetListMarkup,
  buildKitListMarkup,
} from "./utils";
import type { CreateAssetFromContentImportPayload } from "../asset/types";
import {
  getFilteredAssetIds,
  getLocationUpdateNoteContent,
  getKitLocationUpdateNoteContent,
} from "../asset/utils.server";
import { createSystemLocationNote as createSystemLocationActivityNote } from "../location-note/service.server";
import { createNote } from "../note/service.server";
import { getUserByID } from "../user/service.server";

const label: ErrorLabel = "Location";
const MAX_LOCATION_DEPTH = 12;

export async function getLocation(
  params: Pick<Location, "id"> & {
    organizationId: Organization["id"];
    /** Page number. Starts at 1 */
    page?: number;
    /** Assets to be loaded per page with the location */
    perPage?: number;
    search?: string | null;
    orderBy?: string;
    orderDirection?: "asc" | "desc";
    userOrganizations?: Pick<UserOrganization, "organizationId">[];
    request?: Request;
    include?: Prisma.LocationInclude;
    teamMemberIds?: string[] | null;
  }
) {
  const {
    organizationId,
    id,
    page = 1,
    perPage = 8,
    search,
    userOrganizations,
    request,
    orderBy = "createdAt",
    orderDirection,
    include,
    teamMemberIds,
  } = params;

  try {
    const otherOrganizationIds = userOrganizations?.map(
      (org) => org.organizationId
    );

    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = perPage >= 1 ? perPage : 8; // min 1 and max 25 per page

    /** Build where object for querying related assets */
    const assetsWhere: Prisma.AssetWhereInput = {};

    if (search) {
      assetsWhere.title = {
        contains: search,
        mode: "insensitive",
      };
    }

    if (teamMemberIds && teamMemberIds.length) {
      assetsWhere.OR = [
        ...(assetsWhere.OR ?? []),
        {
          custody: { teamMemberId: { in: teamMemberIds } },
        },
        {
          custody: { custodian: { userId: { in: teamMemberIds } } },
        },
        {
          bookings: {
            some: {
              custodianTeamMemberId: { in: teamMemberIds },
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

    const parentInclude = {
      select: {
        id: true,
        name: true,
        parentId: true,
        _count: { select: { children: true } },
      },
    } satisfies Prisma.LocationInclude["parent"];

    const locationInclude: Prisma.LocationInclude = include
      ? { ...include, parent: parentInclude }
      : {
          assets: {
            include: {
              category: {
                select: {
                  id: true,
                  name: true,
                  color: true,
                },
              },
              tags: {
                select: {
                  id: true,
                  name: true,
                },
              },
              custody: {
                select: {
                  custodian: {
                    select: {
                      id: true,
                      name: true,
                      user: {
                        select: {
                          id: true,
                          firstName: true,
                          lastName: true,
                          profilePicture: true,
                          email: true,
                        },
                      },
                    },
                  },
                },
              },
            },
            skip,
            take,
            where: assetsWhere,
            orderBy: { [orderBy]: orderDirection },
          },
          parent: parentInclude,
        };

    const [location, totalAssetsWithinLocation] = await Promise.all([
      /**
       * Get the items.
       * KEPT AS PRISMA: `locationInclude` is a dynamic Prisma.LocationInclude
       * built from an optional `include` parameter that varies per caller
       * (assets with nested category/tags/custody, kits, notes, etc.).
       * It also uses `_count` in the parent include and pagination (skip/take)
       * on nested assets. Replicating this in Supabase would require
       * rewriting every caller and losing the dynamic include pattern.
       */
      db.location.findFirstOrThrow({
        where: {
          OR: [
            { id, organizationId },
            ...(userOrganizations?.length
              ? [{ id, organizationId: { in: otherOrganizationIds } }]
              : []),
          ],
        },
        include: locationInclude,
      }),

      /** Count them */
      sbDb
        .from("Asset")
        .select("*", { count: "exact", head: true })
        .eq("locationId", id)
        .then(({ count, error }) => {
          if (error) throw error;
          return count ?? 0;
        }),
    ]);

    /* User is accessing the location in the wrong organization. In that case we need special 404 handling. */
    if (
      userOrganizations?.length &&
      location.organizationId !== organizationId &&
      otherOrganizationIds?.includes(location.organizationId)
    ) {
      const redirectTo =
        typeof request !== "undefined"
          ? getRedirectUrlFromRequest(request)
          : undefined;

      throw new ShelfError({
        cause: null,
        title: "Location not found.",
        message: "",
        additionalData: {
          model: "location",
          organization: userOrganizations.find(
            (org) => org.organizationId === location.organizationId
          ),
          redirectTo,
        },
        label,
        status: 404,
        shouldBeCaptured: false,
      });
    }

    return { location, totalAssetsWithinLocation };
  } catch (cause) {
    const isShelfError = isLikeShelfError(cause);

    throw new ShelfError({
      cause,
      title: "Location not found",
      message:
        "The location you are trying to access does not exist or you do not have permission to access it.",
      additionalData: {
        id,
        organizationId,
        ...(isLikeShelfError(cause) ? cause.additionalData : {}),
      },
      label,
      shouldBeCaptured: isShelfError
        ? cause.shouldBeCaptured
        : !isNotFoundError(cause),
    });
  }
}

export type LocationHierarchyEntry = Pick<
  Location,
  "id" | "name" | "parentId"
> & {
  depth: number;
};

/**
 * Returns the ancestor chain for a given location ordered from the root down to the provided node.
 */
export async function getLocationHierarchy(params: {
  organizationId: Organization["id"];
  locationId: Location["id"];
}) {
  const { organizationId, locationId } = params;

  const { data, error } = await sbDb.rpc("get_location_hierarchy", {
    location_id: locationId,
    organization_id: organizationId,
  });

  if (error) throw error;

  return (data ?? []) as LocationHierarchyEntry[];
}

/** Represents a node in the descendant tree rendered on location detail pages. */
export type LocationTreeNode = Pick<Location, "id" | "name"> & {
  children: LocationTreeNode[];
};

/** Raw row returned when querying descendants via recursive CTE. */
type LocationDescendantRow = Pick<Location, "id" | "name" | "parentId">;

/**
 * Fetches a nested tree of all descendants for the provided location.
 * Used to render the hierarchical child list on the location page sidebar.
 */
export async function getLocationDescendantsTree(params: {
  organizationId: Organization["id"];
  locationId: Location["id"];
}): Promise<LocationTreeNode[]> {
  const { organizationId, locationId } = params;

  const { data, error } = await sbDb.rpc("get_location_descendants", {
    location_id: locationId,
    organization_id: organizationId,
  });

  if (error) throw error;

  const descendants = (data ?? []) as LocationDescendantRow[];

  const nodes = new Map<string, LocationTreeNode>();
  const rootNodes: LocationTreeNode[] = [];

  for (const row of descendants) {
    nodes.set(row.id, { id: row.id, name: row.name, children: [] });
  }

  for (const row of descendants) {
    const node = nodes.get(row.id);
    if (!node) continue;

    if (row.parentId === locationId) {
      rootNodes.push(node);
    }

    const parentNode = row.parentId ? nodes.get(row.parentId) : null;
    if (parentNode) {
      parentNode.children.push(node);
    }
  }

  return rootNodes;
}

/**
 * Returns the maximum depth (root node counted as 0) for a location's subtree.
 * Used by validation to ensure re-parent operations do not exceed the configured max depth.
 */
export async function getLocationSubtreeDepth(params: {
  organizationId: Organization["id"];
  locationId: Location["id"];
}): Promise<number> {
  const { organizationId, locationId } = params;

  const { data, error } = await sbDb.rpc("get_location_subtree_depth", {
    location_id: locationId,
    organization_id: organizationId,
  });

  if (error) throw error;

  return (data as number) ?? 0;
}

export const LOCATION_LIST_INCLUDE = {
  _count: { select: { kits: true, assets: true, children: true } },
  parent: {
    select: {
      id: true,
      name: true,
      parentId: true,
      _count: { select: { children: true } },
    },
  },
  image: { select: { updatedAt: true } },
} satisfies Prisma.LocationInclude;

export async function getLocations(params: {
  organizationId: Organization["id"];
  /** Page number. Starts at 1 */
  page?: number;
  /** Items to be loaded per page */
  perPage?: number;
  search?: string | null;
}) {
  const { organizationId, page = 1, perPage = 8, search } = params;

  try {
    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = perPage >= 1 ? perPage : 8; // min 1 and max 25 per page

    /**
     * Supabase select with nested relation counts to match the
     * Prisma LOCATION_LIST_INCLUDE shape:
     *   _count: { kits, assets, children }
     *   parent: { id, name, parentId, _count: { children } }
     *   image: { updatedAt }
     *
     * PostgREST returns counts as `[{ count: N }]` arrays — we
     * transform them into the `_count` shape below.
     */
    const selectFields = [
      "*",
      "Kit(count)",
      "Asset(count)",
      "children:Location!Location_parentId_fkey(count)",
      "parent:Location!parentId(id, name, parentId, children:Location!Location_parentId_fkey(count))",
      "image:Image(updatedAt)",
    ].join(", ");

    let listQuery = sbDb
      .from("Location")
      .select(selectFields, { count: "exact" })
      .eq("organizationId", organizationId)
      .order("updatedAt", { ascending: false })
      .range(skip, skip + take - 1);

    if (search) {
      listQuery = listQuery.ilike("name", `%${search}%`);
    }

    const { data, count: totalLocations, error } = await listQuery;

    if (error) throw error;

    // Transform rows to match the Prisma shape expected by consumers
    const locations = (data ?? []).map((row) => {
      const {
        Kit: kitCount,
        Asset: assetCount,
        children,
        parent: rawParent,
        image: rawImage,
        ...rest
      } = row as unknown as Record<string, unknown> & {
        Kit: { count: number }[];
        Asset: { count: number }[];
        children: { count: number }[];
        parent: {
          id: string;
          name: string;
          parentId: string | null;
          children: { count: number }[];
        } | null;
        image: { updatedAt: string }[] | null;
      };

      const parent = rawParent
        ? {
            id: rawParent.id,
            name: rawParent.name,
            parentId: rawParent.parentId,
            _count: {
              children: rawParent.children?.[0]?.count ?? 0,
            },
          }
        : null;

      const imageRow =
        Array.isArray(rawImage) && rawImage.length > 0
          ? { updatedAt: new Date(rawImage[0].updatedAt) }
          : null;

      return {
        ...rest,
        _count: {
          kits: kitCount?.[0]?.count ?? 0,
          assets: assetCount?.[0]?.count ?? 0,
          children: children?.[0]?.count ?? 0,
        },
        parent,
        image: imageRow,
        // Cast date strings to Date objects for downstream compatibility
        createdAt: new Date(rest.createdAt as unknown as string),
        updatedAt: new Date(rest.updatedAt as unknown as string),
      };
    });

    return { locations, totalLocations: totalLocations ?? 0 };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while fetching the locations",
      additionalData: { ...params },
      label,
    });
  }
}

export async function getLocationTotalValuation({
  locationId,
}: {
  locationId: Location["id"];
}) {
  const { data, error } = await sbDb
    .from("Asset")
    .select("value")
    .eq("locationId", locationId);

  if (error) {
    throw new ShelfError({
      cause: error,
      message: "Something went wrong while fetching the location valuation",
      additionalData: { locationId },
      label,
    });
  }

  const total = data.reduce(
    (sum, asset) => sum + (asset.value ? Number(asset.value) : 0),
    0
  );

  return total;
}

/**
 * Validates that a parent location belongs to the same organization, does not create cycles,
 * and keeps the tree depth under {@link MAX_LOCATION_DEPTH}.
 */
async function validateParentLocation({
  organizationId,
  parentId,
  currentLocationId,
}: {
  organizationId: Organization["id"];
  parentId?: Location["parentId"];
  currentLocationId?: Location["id"];
}) {
  if (!parentId) {
    return null;
  }

  if (currentLocationId && parentId === currentLocationId) {
    throw new ShelfError({
      cause: null,
      message: "A location cannot be its own parent.",
      additionalData: { currentLocationId, parentId, organizationId },
      label,
      status: 400,
      shouldBeCaptured: false,
    });
  }

  const { data: parentLocation, error: parentLocationError } = await sbDb
    .from("Location")
    .select("id")
    .eq("id", parentId)
    .eq("organizationId", organizationId)
    .single();

  if (parentLocationError || !parentLocation) {
    throw new ShelfError({
      cause: null,
      message: "Parent location not found.",
      additionalData: { parentId, organizationId },
      label,
      status: 404,
      shouldBeCaptured: false,
    });
  }

  const hierarchy = await getLocationHierarchy({
    organizationId,
    locationId: parentId,
  });

  const parentDepth = hierarchy.reduce(
    (maxDepth, location) => Math.max(maxDepth, location.depth),
    0
  );

  const subtreeDepth =
    currentLocationId === undefined
      ? 0
      : await getLocationSubtreeDepth({
          organizationId,
          locationId: currentLocationId,
        });

  if (parentDepth + 1 + subtreeDepth > MAX_LOCATION_DEPTH) {
    throw new ShelfError({
      cause: null,
      title: "Not allowed",
      message: `Locations cannot be nested deeper than ${MAX_LOCATION_DEPTH} levels.`,
      additionalData: {
        parentId,
        organizationId,
        parentDepth,
        subtreeDepth,
      },
      label,
      status: 400,
      shouldBeCaptured: false,
    });
  }

  if (currentLocationId && hierarchy.some((l) => l.id === currentLocationId)) {
    throw new ShelfError({
      cause: null,
      message: "A location cannot be assigned to one of its descendants.",
      additionalData: { parentId, currentLocationId, organizationId },
      label,
      status: 400,
      shouldBeCaptured: false,
    });
  }

  return parentLocation.id;
}

export async function createLocation({
  name,
  description,
  address,
  userId,
  organizationId,
  parentId,
}: Pick<Location, "description" | "name" | "address"> & {
  userId: User["id"];
  organizationId: Organization["id"];
  parentId?: Location["parentId"];
}) {
  try {
    // Geocode the address if provided
    let coordinates: { lat: number; lon: number } | null = null;
    if (address) {
      coordinates = await geolocate(address);
    }

    const validatedParentId = await validateParentLocation({
      organizationId,
      parentId,
    });

    const { data: location, error: createError } = await sbDb
      .from("Location")
      .insert({
        name: name.trim(),
        description,
        address,
        latitude: coordinates?.lat || null,
        longitude: coordinates?.lon || null,
        userId,
        organizationId,
        ...(validatedParentId && { parentId: validatedParentId }),
      })
      .select()
      .single();

    if (createError || !location) {
      throw createError || new Error("Failed to create location");
    }

    return {
      ...location,
      createdAt: new Date(location.createdAt),
      updatedAt: new Date(location.updatedAt),
    };
  } catch (cause) {
    if (isLikeShelfError(cause)) {
      throw cause;
    }
    throw maybeUniqueConstraintViolation(cause, "Location", {
      additionalData: { userId, organizationId },
    });
  }
}

export async function deleteLocation({
  id,
  organizationId,
}: Pick<Location, "id" | "organizationId">) {
  try {
    const { data: location, error: deleteLocationError } = await sbDb
      .from("Location")
      .delete()
      .eq("id", id)
      .eq("organizationId", organizationId)
      .select()
      .single();

    if (deleteLocationError || !location) {
      throw new ShelfError({
        cause: deleteLocationError,
        message: "Something went wrong while deleting the location",
        additionalData: { id },
        label,
      });
    }

    if (location.imageId) {
      const { error: deleteImageError } = await sbDb
        .from("Image")
        .delete()
        .eq("id", location.imageId);

      if (deleteImageError) {
        throw new ShelfError({
          cause: deleteImageError,
          message: "Something went wrong while deleting the location image",
          additionalData: { imageId: location.imageId },
          label,
        });
      }
    }

    return location;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while deleting the location",
      additionalData: { id },
      label,
    });
  }
}

export async function updateLocation(payload: {
  id: Location["id"];
  name?: Location["name"];
  address?: Location["address"];
  description?: Location["description"];
  userId: User["id"];
  organizationId: Organization["id"];
  parentId?: Location["parentId"];
}) {
  const { id, name, address, description, userId, organizationId, parentId } =
    payload;

  try {
    // Get the current location to check for changes
    const { data: locationRow, error: fetchError } = await sbDb
      .from("Location")
      .select("name, description, address, latitude, longitude, parentId")
      .eq("id", id)
      .eq("organizationId", organizationId)
      .single();

    if (fetchError || !locationRow) {
      throw new ShelfError({
        cause: fetchError,
        message: "Location not found",
        additionalData: { id, organizationId },
        label,
        status: 404,
      });
    }

    // Fetch parent separately if parentId exists
    let parentData: { id: string; name: string } | null = null;
    if (locationRow.parentId) {
      const { data: parent } = await sbDb
        .from("Location")
        .select("id, name")
        .eq("id", locationRow.parentId)
        .single();
      parentData = parent;
    }

    const currentLocation = {
      ...locationRow,
      parent: parentData,
    };

    // Check if address has changed and geocode if necessary
    let coordinates: { lat: number; lon: number } | null = null;
    let shouldUpdateCoordinates = false;

    if (address !== undefined) {
      // address is being updated (could be null or string)
      if (address !== currentLocation.address) {
        shouldUpdateCoordinates = true;
        if (address) {
          coordinates = await geolocate(address);
        }
      }
    }

    const validatedParentId =
      parentId === undefined
        ? undefined
        : await validateParentLocation({
            organizationId,
            parentId,
            currentLocationId: id,
          });

    const updateData: Record<string, unknown> = {
      name: name?.trim(),
      description,
      address,
      ...(shouldUpdateCoordinates && {
        latitude: coordinates?.lat || null,
        longitude: coordinates?.lon || null,
      }),
      ...(validatedParentId !== undefined && {
        parentId: validatedParentId || null,
      }),
    };

    const { data: updatedLocation, error: updateError } = await sbDb
      .from("Location")
      .update(updateData)
      .eq("id", id)
      .eq("organizationId", organizationId)
      .select()
      .single();

    if (updateError || !updatedLocation) {
      throw updateError || new Error("Failed to update location");
    }

    // Create location activity notes for changed fields
    await createLocationEditNotes({
      locationId: id,
      userId,
      previous: currentLocation,
      next: {
        name,
        description,
        address,
        parentId: validatedParentId,
      },
    });

    return updatedLocation;
  } catch (cause) {
    if (isLikeShelfError(cause)) {
      throw cause;
    }
    throw maybeUniqueConstraintViolation(cause, "Location", {
      additionalData: {
        id,
        userId,
        organizationId,
      },
    });
  }
}

async function createLocationEditNotes({
  locationId,
  userId,
  previous,
  next,
}: {
  locationId: string;
  userId: string;
  previous: {
    name: string;
    description: string | null;
    address: string | null;
    parentId: string | null;
    parent: { id: string; name: string } | null;
  };
  next: {
    name?: string;
    description?: string | null;
    address?: string | null;
    parentId?: string | null;
  };
}) {
  const escape = (v: string) => `**${v.replace(/([*_`~])/g, "\\$1")}**`;
  const changes: string[] = [];

  // Name change
  if (next.name !== undefined && next.name !== previous.name) {
    changes.push(`- **Name:** ${escape(previous.name)} → ${escape(next.name)}`);
  }

  // Description change
  if (next.description !== undefined) {
    const prev = previous.description?.trim() || null;
    const curr = next.description?.trim() || null;
    if (prev !== curr) {
      const tag = wrapDescriptionForNote(prev, curr);
      changes.push(`- **Description:** ${tag}`);
    }
  }

  // Address change
  if (next.address !== undefined) {
    const prev = previous.address?.trim() || null;
    const curr = next.address?.trim() || null;
    if (prev !== curr) {
      const prevDisplay = prev ? escape(prev) : "*none*";
      const currDisplay = curr ? escape(curr) : "*none*";
      changes.push(`- **Address:** ${prevDisplay} → ${currDisplay}`);
    }
  }

  // Parent location change
  if (next.parentId !== undefined && next.parentId !== previous.parentId) {
    const prevParent = previous.parent
      ? wrapLinkForNote(
          `/locations/${previous.parent.id}`,
          previous.parent.name
        )
      : "*none*";

    let newParentDisplay = "*none*";
    if (next.parentId) {
      const { data: newParent, error: newParentError } = await sbDb
        .from("Location")
        .select("id, name")
        .eq("id", next.parentId)
        .single();

      if (newParentError) {
        throw new ShelfError({
          cause: newParentError,
          message: "Something went wrong while fetching the parent location",
          additionalData: { parentId: next.parentId },
          label,
        });
      }
      newParentDisplay = newParent
        ? wrapLinkForNote(`/locations/${newParent.id}`, newParent.name)
        : "*unknown*";
    }

    changes.push(`- **Parent:** ${prevParent} → ${newParentDisplay}`);
  }

  if (changes.length === 0) return;

  const { data: user, error: userError } = await sbDb
    .from("User")
    .select("firstName, lastName")
    .eq("id", userId)
    .single();

  if (userError) {
    throw new ShelfError({
      cause: userError,
      message: "Something went wrong while fetching the user",
      additionalData: { userId },
      label,
    });
  }

  const userLink = wrapUserLinkForNote({
    id: userId,
    firstName: user?.firstName,
    lastName: user?.lastName,
  });

  const content = `${userLink} updated the location:\n\n${changes.join("\n")}`;

  await createSystemLocationActivityNote({
    locationId,
    content,
    userId,
  });
}

export async function createLocationsIfNotExists({
  data,
  userId,
  organizationId,
}: {
  data: CreateAssetFromContentImportPayload[];
  userId: User["id"];
  organizationId: Organization["id"];
}): Promise<Record<string, Location["id"]>> {
  try {
    // first we get all the locations from the assets and make then into an object where the category is the key and the value is an empty string
    const locations = new Map(
      data
        .filter((asset) => asset.location)
        .map((asset) => [asset.location, ""])
    );

    // now we loop through the locations and check if they exist
    for (const [location, _] of locations) {
      const trimmedLocation = (location as string).trim();
      const { data: existingLocation, error: existingLocationError } =
        await sbDb
          .from("Location")
          .select("*")
          .ilike("name", trimmedLocation)
          .eq("organizationId", organizationId)
          .maybeSingle();

      if (existingLocationError) {
        throw new ShelfError({
          cause: existingLocationError,
          message: "Something went wrong while checking for existing location",
          additionalData: { trimmedLocation, organizationId },
          label,
        });
      }

      if (!existingLocation) {
        // if the location doesn't exist, we create a new one
        const { data: newLocation, error: createLocError } = await sbDb
          .from("Location")
          .insert({
            name: trimmedLocation,
            userId,
            organizationId,
          })
          .select("id")
          .single();

        if (createLocError || !newLocation) {
          throw createLocError || new Error("Failed to create location");
        }

        locations.set(location, newLocation.id);
      } else {
        // if the location exists, we just update the id
        locations.set(location, existingLocation.id);
      }
    }

    return Object.fromEntries(Array.from(locations));
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while creating locations. Seems like some of the location data in your import file is invalid. Please check and try again.",
      additionalData: { userId, organizationId },
      label,
      /** No need to capture those. They are mostly related to malformed CSV data */
      shouldBeCaptured: false,
    });
  }
}

export async function bulkDeleteLocations({
  locationIds,
  organizationId,
}: {
  locationIds: Location["id"][];
  organizationId: Organization["id"];
}) {
  try {
    /** We have to delete the images of locations if any */
    let query = sbDb
      .from("Location")
      .select("id, imageId")
      .eq("organizationId", organizationId);

    if (!locationIds.includes(ALL_SELECTED_KEY)) {
      query = query.in("id", locationIds);
    }

    const { data: locations, error: fetchError } = await query;
    if (fetchError) throw fetchError;

    const locationIdList = (locations ?? []).map((l) => l.id);
    const imageIdList = (locations ?? [])
      .filter((l): l is typeof l & { imageId: string } => !!l.imageId)
      .map((l) => l.imageId);

    const { error: rpcError } = await sbDb.rpc("shelf_location_bulk_delete", {
      p_location_ids: locationIdList,
      p_image_ids: imageIdList,
    });
    if (rpcError) throw rpcError;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while bulk deleting locations.",
      additionalData: { locationIds, organizationId },
      label,
    });
  }
}

export async function updateLocationImage({
  organizationId,
  request,
  locationId,
  prevImageUrl,
  prevThumbnailUrl,
}: {
  organizationId: Organization["id"];
  request: Request;
  locationId: Location["id"];
  prevImageUrl?: string | null;
  prevThumbnailUrl?: string | null;
}) {
  try {
    const fileData = await parseFileFormData({
      request,
      bucketName: PUBLIC_BUCKET,
      newFileName: getFileUploadPath({
        organizationId,
        type: "locations",
        typeId: locationId,
      }),
      resizeOptions: {
        width: 1200,
        withoutEnlargement: true,
      },
      generateThumbnail: true,
      thumbnailSize: 108,
      maxFileSize: DEFAULT_MAX_IMAGE_UPLOAD_SIZE,
    });

    const image = fileData.get("image") as string | null;
    if (!image) {
      return;
    }

    let imagePath: string;
    let thumbnailPath: string | null = null;

    try {
      const parsedImage = JSON.parse(image);
      if (parsedImage.originalPath) {
        imagePath = parsedImage.originalPath;
        thumbnailPath = parsedImage.thumbnailPath;
      } else {
        imagePath = image;
      }
    } catch (_error) {
      imagePath = image;
    }

    const {
      data: { publicUrl: imagePublicUrl },
    } = getSupabaseAdmin().storage.from(PUBLIC_BUCKET).getPublicUrl(imagePath);

    let thumbnailPublicUrl: string | undefined;
    if (thumbnailPath) {
      const {
        data: { publicUrl },
      } = getSupabaseAdmin()
        .storage.from(PUBLIC_BUCKET)
        .getPublicUrl(thumbnailPath);
      thumbnailPublicUrl = publicUrl;
    }

    const { error: updateImageError } = await sbDb
      .from("Location")
      .update({
        imageUrl: imagePublicUrl,
        ...(thumbnailPublicUrl ? { thumbnailUrl: thumbnailPublicUrl } : {}),
      })
      .eq("id", locationId)
      .eq("organizationId", organizationId);

    if (updateImageError) {
      throw new ShelfError({
        cause: updateImageError,
        message: "Something went wrong while updating the location image",
        additionalData: { locationId, organizationId },
        label,
      });
    }

    if (prevImageUrl) {
      await removePublicFile({ publicUrl: prevImageUrl });
    }

    if (prevThumbnailUrl) {
      await removePublicFile({ publicUrl: prevThumbnailUrl });
    }
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: isLikeShelfError(cause)
        ? cause.message
        : "Something went wrong while updating the location image.",
      additionalData: { locationId, field: "image" },
      label,
    });
  }
}

export async function generateLocationWithImages({
  organizationId,
  numberOfLocations,
  image,
  userId,
}: {
  userId: User["id"];
  organizationId: Organization["id"];
  numberOfLocations: number;
  image: File;
}) {
  try {
    for (let i = 1; i <= numberOfLocations; i++) {
      const { data: imageCreated, error: imageError } = await sbDb
        .from("Image")
        .insert({
          blob: Buffer.from(await image.arrayBuffer()).toString("base64"),
          contentType: image.type,
          ownerOrgId: organizationId,
          userId,
        })
        .select("id")
        .single();

      if (imageError || !imageCreated) {
        throw imageError || new Error("Failed to create image");
      }

      const { error: locError } = await sbDb.from("Location").insert({
        /**
         * We are using id() for names because location names are unique.
         * This location is going to be created for testing purposes only so the name in this case
         * doesn't matter.
         */
        name: id(),
        /**
         * This approach is @deprecated and will not be used in the future.
         * Instead, we will store images in supabase storage and use the public URL.
         */
        imageId: imageCreated.id,
        userId,
        organizationId,
      });

      if (locError) {
        throw locError;
      }
    }
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: isLikeShelfError(cause)
        ? cause.message
        : "Something went wrong while generating locations.",
      additionalData: { organizationId, numberOfLocations },
      label,
    });
  }
}

export async function getLocationKits(
  params: Pick<Location, "id"> & {
    organizationId: Organization["id"];
    /** Page number. Starts at 1 */
    page?: number;
    /** Assets to be loaded per page with the location */
    perPage?: number;
    search?: string | null;
    orderBy?: string;
    orderDirection?: "asc" | "desc";
    teamMemberIds?: string[] | null;
  }
) {
  const {
    organizationId,
    id,
    page = 1,
    perPage = 8,
    search,
    orderBy = "createdAt",
    orderDirection,
    teamMemberIds,
  } = params;

  try {
    const skip = page > 1 ? (page - 1) * perPage : 0;
    const take = perPage >= 1 ? perPage : 8; // min 1 and max 25 per page

    const kitWhere: Prisma.KitWhereInput = {
      organizationId,
      locationId: id,
    };

    if (teamMemberIds && teamMemberIds.length) {
      kitWhere.OR = [
        ...(kitWhere.OR ?? []),
        {
          custody: { custodianId: { in: teamMemberIds } },
        },
        {
          custody: { custodian: { userId: { in: teamMemberIds } } },
        },
        {
          assets: {
            some: {
              bookings: {
                some: {
                  custodianTeamMemberId: { in: teamMemberIds },
                  status: {
                    in: [BookingStatus.ONGOING, BookingStatus.OVERDUE],
                  },
                },
              },
            },
          },
        },
        {
          assets: {
            some: {
              bookings: {
                some: {
                  custodianUserId: { in: teamMemberIds },
                  status: {
                    in: [BookingStatus.ONGOING, BookingStatus.OVERDUE],
                  },
                },
              },
            },
          },
        },
        ...(teamMemberIds.includes("without-custody")
          ? [{ custody: null }]
          : []),
      ];
    }

    if (search) {
      kitWhere.name = {
        contains: search,
        mode: "insensitive",
      };
    }

    /**
     * KEPT AS PRISMA: `kitWhere` uses complex nested OR conditions that
     * PostgREST cannot express — specifically `assets.some.bookings.some`
     * (multi-level existence checks through relations) and
     * `custody.custodian.userId` (nested relation filtering). These
     * require Prisma's join-based query engine.
     */
    const [kits, totalKits] = await Promise.all([
      db.kit.findMany({
        where: kitWhere,
        include: {
          category: true,
          custody: {
            select: {
              custodian: {
                select: {
                  id: true,
                  name: true,
                  user: {
                    select: {
                      id: true,
                      firstName: true,
                      lastName: true,
                      profilePicture: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
        },
        skip,
        take,
        orderBy: { [orderBy]: orderDirection },
      }),
      db.kit.count({ where: kitWhere }),
    ]);

    return { kits, totalKits };
  } catch (cause) {
    throw new ShelfError({
      cause,
      title: "Something went wrong while fetching the location kits",
      message:
        "Something went wrong while fetching the location kits. Please try again or contact support.",
      label,
    });
  }
}

export async function createLocationChangeNote({
  currentLocation,
  newLocation,
  firstName,
  lastName,
  assetId,
  userId,
  isRemoving,
}: {
  currentLocation: Pick<Location, "id" | "name"> | null;
  newLocation: Pick<Location, "id" | "name"> | null;
  firstName: string;
  lastName: string;
  assetId: Asset["id"];
  userId: User["id"];
  isRemoving: boolean;
}) {
  try {
    const message = getLocationUpdateNoteContent({
      currentLocation,
      newLocation,
      userId,
      firstName,
      lastName,
      isRemoving,
    });

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
        "Something went wrong while creating a location change note. Please try again or contact support",
      additionalData: { userId, assetId },
      label,
    });
  }
}

async function createBulkLocationChangeNotes({
  modifiedAssets,
  assetIds,
  removedAssetIds,
  userId,
  location,
}: {
  modifiedAssets: Array<{
    title: string;
    id: string;
    location: { name: string; id: string } | null;
    user: {
      firstName: string | null;
      lastName: string | null;
      id: string;
    } | null;
  }>;
  assetIds: Asset["id"][];
  removedAssetIds: Asset["id"][];
  userId: User["id"];
  location: Pick<Location, "id" | "name">;
}) {
  try {
    const { data: user, error: userError } = await sbDb
      .from("User")
      .select("firstName, lastName")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      throw new ShelfError({
        cause: userError,
        message: "User not found",
        additionalData: { userId },
        label,
      });
    }

    const addedAssets: Array<{ id: string; title: string }> = [];
    const removedAssetsSummary: Array<{ id: string; title: string }> = [];

    // Iterate over the modified assets
    for (const asset of modifiedAssets) {
      const isRemoving = removedAssetIds.includes(asset.id);
      const isNew = assetIds.includes(asset.id);
      const newLocation = isRemoving ? null : location;
      const currentLocation = asset.location
        ? { name: asset.location.name, id: asset.location.id }
        : null;

      if (isNew || isRemoving) {
        await createLocationChangeNote({
          currentLocation,
          newLocation,
          firstName: user.firstName || "",
          lastName: user.lastName || "",
          assetId: asset.id,
          userId,
          isRemoving,
        });

        if (isNew && newLocation) {
          addedAssets.push({ id: asset.id, title: asset.title });
        }

        if (isRemoving && currentLocation) {
          removedAssetsSummary.push({ id: asset.id, title: asset.title });
        }
      }
    }

    // Create summary notes on the location's activity log
    const userLink = wrapUserLinkForNote({
      id: userId,
      firstName: user.firstName,
      lastName: user.lastName,
    });

    if (addedAssets.length > 0) {
      // Group added assets by their previous location for "Moved from" context
      const byPrevLoc = new Map<string, string>();
      for (const asset of modifiedAssets) {
        if (assetIds.includes(asset.id) && asset.location) {
          byPrevLoc.set(asset.location.id, asset.location.name);
        }
      }
      const prevLocLinks = [...byPrevLoc.entries()].map(([id, name]) =>
        wrapLinkForNote(`/locations/${id}`, name)
      );
      const movedFromSuffix =
        prevLocLinks.length > 0
          ? ` Moved from ${prevLocLinks.join(", ")}.`
          : "";

      const content = `${userLink} added ${buildAssetListMarkup(
        addedAssets,
        "added"
      )} to ${formatLocationLink(location)}.${movedFromSuffix}`;
      await createSystemLocationActivityNote({
        locationId: location.id,
        content,
        userId,
      });

      // Also create removal notes on previous locations
      const byPrevLocation = new Map<
        string,
        { name: string; assets: typeof addedAssets }
      >();
      for (const asset of modifiedAssets) {
        if (!assetIds.includes(asset.id) || !asset.location) continue;
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
      for (const [locId, { name, assets: locAssets }] of byPrevLocation) {
        const prevLocLink = wrapLinkForNote(`/locations/${locId}`, name);
        const assetMarkup = buildAssetListMarkup(locAssets, "removed");
        const movedTo = ` Moved to ${formatLocationLink(location)}.`;
        await createSystemLocationActivityNote({
          locationId: locId,
          content: `${userLink} removed ${assetMarkup} from ${prevLocLink}.${movedTo}`,
          userId,
        });
      }
    }

    if (removedAssetsSummary.length > 0) {
      const content = `${userLink} removed ${buildAssetListMarkup(
        removedAssetsSummary,
        "removed"
      )} from ${formatLocationLink(location)}.`;
      await createSystemLocationActivityNote({
        locationId: location.id,
        content,
        userId,
      });
    }
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while creating bulk location change notes",
      additionalData: { userId, assetIds, removedAssetIds },
      label,
    });
  }
}

export async function updateLocationAssets({
  assetIds,
  organizationId,
  locationId,
  userId,
  request,
  removedAssetIds,
}: {
  assetIds: Asset["id"][];
  organizationId: Location["organizationId"];
  locationId: Location["id"];
  userId: User["id"];
  request: Request;
  removedAssetIds: Asset["id"][];
}) {
  try {
    // Fetch the location
    const { data: locationRow, error: locFetchError } = await sbDb
      .from("Location")
      .select("id, name")
      .eq("id", locationId)
      .eq("organizationId", organizationId)
      .single();

    if (locFetchError || !locationRow) {
      throw new ShelfError({
        cause: locFetchError,
        message: "Location not found",
        additionalData: { locationId, userId, organizationId },
        status: 404,
        label: "Location",
      });
    }

    // Fetch assets currently at this location
    const { data: currentAssets, error: currentAssetsError } = await sbDb
      .from("Asset")
      .select("id")
      .eq("locationId", locationId);

    if (currentAssetsError) {
      throw new ShelfError({
        cause: currentAssetsError,
        message: "Failed to fetch current location assets",
        additionalData: { locationId },
        label: "Location",
      });
    }

    const location = {
      ...locationRow,
      assets: currentAssets ?? [],
    };

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

      const locationAssets = location.assets.map((asset) => asset.id);
      /**
       * New assets that needs to be added are
       * - Previously added assets
       * - All assets with applied filters
       */
      assetIds = [
        ...new Set([
          ...allAssetIds,
          ...locationAssets.filter((asset) => !removedAssetIds.includes(asset)),
        ]),
      ];
    }

    /**
     * Filter out assets already at this location - they don't need notes
     * since no actual change is happening for them.
     */
    const existingAssetIds = new Set(location.assets.map((a) => a.id));
    const actuallyNewAssetIds = assetIds.filter(
      (id) => !existingAssetIds.has(id)
    );

    /**
     * We need to query all the modified assets so we know their location before the change
     * That way we can later create notes for all the location changes
     */
    const modifiedAssetIds = [...actuallyNewAssetIds, ...removedAssetIds];
    let modifiedAssets: Array<{
      title: string;
      id: string;
      location: { name: string; id: string } | null;
      user: {
        firstName: string | null;
        lastName: string | null;
        id: string;
      } | null;
    }> = [];

    if (modifiedAssetIds.length > 0) {
      const { data: assetRows, error: assetFetchError } = await sbDb
        .from("Asset")
        .select("title, id, locationId, userId")
        .in("id", modifiedAssetIds)
        .eq("organizationId", organizationId);

      if (assetFetchError) {
        throw new ShelfError({
          cause: assetFetchError,
          message:
            "Something went wrong while fetching the assets. Please try again or contact support.",
          additionalData: { assetIds, removedAssetIds, userId, locationId },
          label: "Assets",
        });
      }

      // Fetch related locations and users
      const locIds = [
        ...new Set(
          (assetRows ?? [])
            .map((a) => a.locationId)
            .filter((lid): lid is string => !!lid)
        ),
      ];
      const userIds = [
        ...new Set(
          (assetRows ?? [])
            .map((a) => a.userId)
            .filter((uid): uid is string => !!uid)
        ),
      ];

      const [locResult, userResult] = await Promise.all([
        locIds.length > 0
          ? sbDb.from("Location").select("id, name").in("id", locIds)
          : { data: [], error: null },
        userIds.length > 0
          ? sbDb
              .from("User")
              .select("id, firstName, lastName")
              .in("id", userIds)
          : { data: [], error: null },
      ]);

      const locMap = new Map((locResult.data ?? []).map((l) => [l.id, l]));
      const userMap = new Map((userResult.data ?? []).map((u) => [u.id, u]));

      modifiedAssets = (assetRows ?? []).map((a) => ({
        title: a.title,
        id: a.id,
        location: a.locationId ? (locMap.get(a.locationId) ?? null) : null,
        user: a.userId ? (userMap.get(a.userId) ?? null) : null,
      }));
    }

    if (assetIds.length > 0) {
      /** We update the assets to set their locationId to this location */
      const { error: connectError } = await sbDb
        .from("Asset")
        .update({ locationId })
        .in("id", assetIds);

      if (connectError) {
        throw new ShelfError({
          cause: connectError,
          message:
            "Something went wrong while adding the assets to the location. Please try again or contact support.",
          additionalData: { assetIds, userId, locationId },
          label: "Location",
        });
      }
    }

    /** If some assets were removed, we also need to handle those */
    if (removedAssetIds.length > 0) {
      const { error: disconnectError } = await sbDb
        .from("Asset")
        .update({ locationId: null })
        .in("id", removedAssetIds);

      if (disconnectError) {
        throw new ShelfError({
          cause: disconnectError,
          message:
            "Something went wrong while removing the assets from the location. Please try again or contact support.",
          additionalData: { removedAssetIds, userId, locationId },
          label: "Location",
        });
      }
    }

    /** Creates the relevant notes for all the changed assets */
    await createBulkLocationChangeNotes({
      modifiedAssets,
      assetIds: actuallyNewAssetIds,
      removedAssetIds,
      userId,
      location,
    });
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while updating the location assets.",
      additionalData: { assetIds, organizationId, locationId },
      label,
    });
  }
}

export async function updateLocationKits({
  locationId,
  kitIds,
  removedKitIds,
  organizationId,
  userId,
  request,
}: {
  locationId: Location["id"];
  kitIds: Kit["id"][];
  removedKitIds: Kit["id"][];
  organizationId: Location["organizationId"];
  userId: User["id"];
  request: Request;
}) {
  try {
    // Fetch location
    const { data: locRow, error: locErr } = await sbDb
      .from("Location")
      .select("id, name")
      .eq("id", locationId)
      .eq("organizationId", organizationId)
      .single();

    if (locErr || !locRow) {
      throw new ShelfError({
        cause: locErr,
        message: "Location not found",
        additionalData: { locationId, userId, organizationId },
        status: 404,
        label: "Location",
      });
    }

    // Fetch kits currently at this location, with their asset IDs
    const { data: currentKitRows, error: kitsErr } = await sbDb
      .from("Kit")
      .select("id")
      .eq("locationId", locationId);

    if (kitsErr) {
      throw new ShelfError({
        cause: kitsErr,
        message: "Failed to fetch location kits",
        additionalData: { locationId },
        label: "Location",
      });
    }

    // Fetch asset IDs for those kits
    const currentKitIds = (currentKitRows ?? []).map((k) => k.id);
    let kitAssetsMap: Array<{ id: string; assets: Array<{ id: string }> }> = [];
    if (currentKitIds.length > 0) {
      const { data: kitAssetRows } = await sbDb
        .from("Asset")
        .select("id, kitId")
        .in("kitId", currentKitIds);

      // Group by kitId
      const grouped = new Map<string, Array<{ id: string }>>();
      for (const row of kitAssetRows ?? []) {
        if (!row.kitId) continue;
        const arr = grouped.get(row.kitId) ?? [];
        arr.push({ id: row.id });
        grouped.set(row.kitId, arr);
      }
      kitAssetsMap = currentKitIds.map((kid) => ({
        id: kid,
        assets: grouped.get(kid) ?? [],
      }));
    }

    const location = {
      ...locRow,
      kits: kitAssetsMap,
    };

    /**
     * If user has selected all kits, then we have to get ids of all those kits
     * with respect to the filters applied.
     * */
    const hasSelectedAll = kitIds.includes(ALL_SELECTED_KEY);
    if (hasSelectedAll) {
      const searchParams = getCurrentSearchParams(request);
      const currentSearchParams = searchParams.toString();
      const sp = new URLSearchParams(currentSearchParams);

      let kitQuery = sbDb
        .from("Kit")
        .select("id")
        .eq("organizationId", organizationId);

      const search = sp.get("s");
      const status = sp.get("status") === "ALL" ? null : sp.get("status");
      const teamMember = sp.get("teamMember");

      if (search) {
        kitQuery = kitQuery.ilike("name", `%${search.toLowerCase().trim()}%`);
      }
      if (status) {
        kitQuery = kitQuery.eq("status", status as KitStatus);
      }
      if (teamMember) {
        const { data: custodyRows } = await sbDb
          .from("KitCustody")
          .select("kitId")
          .eq("custodianId", teamMember);
        const custodyKitIds = (custodyRows ?? [])
          .map((r) => r.kitId)
          .filter(Boolean);
        if (custodyKitIds.length > 0) {
          kitQuery = kitQuery.in("id", custodyKitIds);
        } else {
          // No kits match the custodian filter
          kitQuery = kitQuery.in("id", []);
        }
      }

      const { data: allKitRows } = await kitQuery;
      const allKitIds = (allKitRows ?? []).map((k) => k.id);

      const locationKits = location.kits.map((kit) => kit.id);
      /**
       * New kits that needs to be added are
       * - Previously added kits
       * - All kits with applied filters
       */
      kitIds = [
        ...new Set([
          ...allKitIds,
          ...locationKits.filter((kit) => !removedKitIds.includes(kit)),
        ]),
      ];
    }

    /**
     * Filter out kits already at this location - they don't need notes
     * since no actual change is happening for them.
     */
    const existingKitIds = new Set(location.kits.map((k) => k.id));
    const actuallyNewKitIds = kitIds.filter((id) => !existingKitIds.has(id));

    /**
     * Also compute asset IDs that are already at this location via existing kits
     * so we don't create duplicate notes for them.
     */
    const existingKitAssetIds = new Set(
      location.kits.flatMap((kit) => kit.assets.map((a) => a.id))
    );

    if (kitIds.length > 0) {
      // Get all kits being added to this location
      const { data: kitRows, error: kitFetchErr } = await sbDb
        .from("Kit")
        .select("id, name, locationId")
        .in("id", kitIds)
        .eq("organizationId", organizationId);

      if (kitFetchErr) {
        throw new ShelfError({
          cause: kitFetchErr,
          message: "Failed to fetch kits",
          additionalData: { kitIds },
          label: "Location",
        });
      }

      // Fetch kit locations
      const kitLocIds = [
        ...new Set(
          (kitRows ?? [])
            .map((k) => k.locationId)
            .filter((lid): lid is string => !!lid)
        ),
      ];
      const { data: kitLocRows } =
        kitLocIds.length > 0
          ? await sbDb.from("Location").select("id, name").in("id", kitLocIds)
          : { data: [] };
      const kitLocMap = new Map((kitLocRows ?? []).map((l) => [l.id, l]));

      // Fetch assets belonging to these kits
      const { data: kitAssetRows } = await sbDb
        .from("Asset")
        .select("id, title, kitId, locationId")
        .in("kitId", kitIds);

      // Fetch asset locations
      const assetLocIds = [
        ...new Set(
          (kitAssetRows ?? [])
            .map((a) => a.locationId)
            .filter((lid): lid is string => !!lid)
        ),
      ];
      const { data: assetLocRows } =
        assetLocIds.length > 0
          ? await sbDb.from("Location").select("id, name").in("id", assetLocIds)
          : { data: [] };
      const assetLocMap = new Map((assetLocRows ?? []).map((l) => [l.id, l]));

      // Build kitsToAdd structure
      const assetsByKit = new Map<
        string,
        Array<{
          id: string;
          title: string;
          location: { id: string; name: string } | null;
        }>
      >();
      for (const a of kitAssetRows ?? []) {
        if (!a.kitId) continue;
        const arr = assetsByKit.get(a.kitId) ?? [];
        arr.push({
          id: a.id,
          title: a.title,
          location: a.locationId
            ? (assetLocMap.get(a.locationId) ?? null)
            : null,
        });
        assetsByKit.set(a.kitId, arr);
      }

      const kitsToAdd = (kitRows ?? []).map((k) => ({
        ...k,
        location: k.locationId ? (kitLocMap.get(k.locationId) ?? null) : null,
        assets: assetsByKit.get(k.id) ?? [],
      }));

      const assetIds = kitsToAdd.flatMap((kit) =>
        kit.assets.map((asset) => asset.id)
      );

      /** Update kits to point to this location */
      const { error: kitConnectErr } = await sbDb
        .from("Kit")
        .update({ locationId })
        .in("id", kitIds);

      if (kitConnectErr) {
        throw new ShelfError({
          cause: kitConnectErr,
          message:
            "Something went wrong while adding the kits to the location. Please try again or contact support.",
          additionalData: { kitIds, userId, locationId },
          label: "Location",
        });
      }

      /** Update assets to point to this location */
      if (assetIds.length > 0) {
        const { error: assetConnectErr } = await sbDb
          .from("Asset")
          .update({ locationId })
          .in("id", assetIds);

        if (assetConnectErr) {
          throw new ShelfError({
            cause: assetConnectErr,
            message:
              "Something went wrong while adding the kit assets to the location. Please try again or contact support.",
            additionalData: { assetIds, userId, locationId },
            label: "Location",
          });
        }
      }

      const user = await getUserByID(userId, {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        } satisfies Prisma.UserSelect,
      });

      // Only include actually new kits in the summary note
      const kitsSummary = kitsToAdd
        .filter((kit) => actuallyNewKitIds.includes(kit.id))
        .map((kit) => ({
          id: kit.id,
          name: kit.name ?? kit.id,
        }));

      if (kitsSummary.length > 0) {
        const userLink = wrapUserLinkForNote({
          id: userId,
          firstName: user?.firstName,
          lastName: user?.lastName,
        });

        // Build "Moved from" context for kits coming from other locations
        const actuallyNewKits = kitsToAdd.filter((kit) =>
          actuallyNewKitIds.includes(kit.id)
        );
        const prevLocLinks = [
          ...new Map(
            actuallyNewKits
              .filter((k) => k.locationId && k.locationId !== locationId)
              .map((k) => [
                k.locationId!,
                wrapLinkForNote(
                  `/locations/${k.locationId}`,
                  k.location?.name ?? "Unknown"
                ),
              ])
          ).values(),
        ];
        const movedFromSuffix =
          prevLocLinks.length > 0
            ? ` Moved from ${prevLocLinks.join(", ")}.`
            : "";

        await createSystemLocationActivityNote({
          locationId,
          content: `${userLink} added ${buildKitListMarkup(
            kitsSummary,
            "added"
          )} to ${formatLocationLink(location)}.${movedFromSuffix}`,
          userId,
        });

        // Create removal notes on previous locations
        const byPrevLoc = new Map<
          string,
          { name: string; kits: Array<{ id: string; name: string }> }
        >();
        for (const kit of actuallyNewKits) {
          if (!kit.locationId || kit.locationId === locationId) continue;
          const prevLocName = kit.location?.name ?? "Unknown";
          const existing = byPrevLoc.get(kit.locationId);
          if (existing) {
            existing.kits.push({ id: kit.id, name: kit.name ?? kit.id });
          } else {
            byPrevLoc.set(kit.locationId, {
              name: prevLocName,
              kits: [{ id: kit.id, name: kit.name ?? kit.id }],
            });
          }
        }
        for (const [locId, { name, kits }] of byPrevLoc) {
          const prevLocLink = wrapLinkForNote(`/locations/${locId}`, name);
          const kitMarkup = buildKitListMarkup(kits, "removed");
          const movedTo = ` Moved to ${formatLocationLink(location)}.`;
          await createSystemLocationActivityNote({
            locationId: locId,
            content: `${userLink} removed ${kitMarkup} from ${prevLocLink}.${movedTo}`,
            userId,
          });
        }
      }

      // Add notes to the assets that their location was updated via their parent kit
      // Only include assets not already at this location
      if (assetIds.length > 0) {
        const allAssets = kitsToAdd
          .flatMap((kit) => kit.assets)
          .filter((asset) => !existingKitAssetIds.has(asset.id));

        // Create individual notes for each asset
        await Promise.all(
          allAssets.map((asset) =>
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
    }

    /** If some kits were removed, we also need to handle those */
    if (removedKitIds.length > 0) {
      // Get kits being removed with their assets
      const { data: removedKitRows, error: removedKitErr } = await sbDb
        .from("Kit")
        .select("id, name")
        .in("id", removedKitIds)
        .eq("organizationId", organizationId);

      if (removedKitErr) {
        throw new ShelfError({
          cause: removedKitErr,
          message: "Failed to fetch kits being removed",
          additionalData: { removedKitIds },
          label: "Location",
        });
      }

      // Fetch assets belonging to removed kits
      const { data: removedKitAssetRows } = await sbDb
        .from("Asset")
        .select("id, title, kitId")
        .in("kitId", removedKitIds);

      // Group assets by kit
      const removedAssetsByKit = new Map<
        string,
        Array<{ id: string; title: string }>
      >();
      for (const a of removedKitAssetRows ?? []) {
        if (!a.kitId) continue;
        const arr = removedAssetsByKit.get(a.kitId) ?? [];
        arr.push({ id: a.id, title: a.title });
        removedAssetsByKit.set(a.kitId, arr);
      }

      const kitsBeingRemoved = (removedKitRows ?? []).map((k) => ({
        ...k,
        assets: removedAssetsByKit.get(k.id) ?? [],
      }));

      const removedAssetIds = kitsBeingRemoved.flatMap((kit) =>
        kit.assets.map((asset) => asset.id)
      );

      /** Disconnect kits from location */
      const { error: kitDisconnectErr } = await sbDb
        .from("Kit")
        .update({ locationId: null })
        .in("id", removedKitIds);

      if (kitDisconnectErr) {
        throw new ShelfError({
          cause: kitDisconnectErr,
          message:
            "Something went wrong while removing the kits from the location. Please try again or contact support.",
          additionalData: { removedKitIds, userId, locationId },
          label: "Location",
        });
      }

      /** Disconnect assets from location */
      if (removedAssetIds.length > 0) {
        const { error: assetDisconnectErr } = await sbDb
          .from("Asset")
          .update({ locationId: null })
          .in("id", removedAssetIds);

        if (assetDisconnectErr) {
          throw new ShelfError({
            cause: assetDisconnectErr,
            message:
              "Something went wrong while removing the kit assets from the location. Please try again or contact support.",
            additionalData: { removedAssetIds, userId, locationId },
            label: "Location",
          });
        }
      }

      // Add notes to the assets that their location was removed via their parent kit
      if (removedAssetIds.length > 0) {
        const user = await getUserByID(userId, {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          } satisfies Prisma.UserSelect,
        });
        const allRemovedAssets = kitsBeingRemoved.flatMap((kit) => kit.assets);

        // Create location activity note for removed kits
        const removedKitsSummary = kitsBeingRemoved.map((kit) => ({
          id: kit.id,
          name: kit.name ?? kit.id,
        }));

        if (removedKitsSummary.length > 0) {
          const userLink = wrapUserLinkForNote({
            id: userId,
            firstName: user?.firstName,
            lastName: user?.lastName,
          });

          await createSystemLocationActivityNote({
            locationId,
            content: `${userLink} removed ${buildKitListMarkup(
              removedKitsSummary,
              "removed"
            )} from ${formatLocationLink(location)}.`,
            userId,
          });
        }

        // Create individual notes for each asset
        await Promise.all(
          allRemovedAssets.map((asset) =>
            createNote({
              content: getKitLocationUpdateNoteContent({
                currentLocation: location,
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
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while updating the location kits.",
      additionalData: { locationId, kitIds },
      label,
    });
  }
}
