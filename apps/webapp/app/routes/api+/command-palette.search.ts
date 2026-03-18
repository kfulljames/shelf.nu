import { Prisma } from "@prisma/client";
import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";

import { db } from "~/database/db.server";
import { sbDb } from "~/database/supabase.server";
import { getAssets } from "~/modules/asset/service.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import { isPersonalOrg } from "~/utils/organization";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
});

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const url = new URL(request.url);
    const validated = querySchema.parse({
      q: url.searchParams.get("q") ?? undefined,
    });
    const query = validated.q?.trim() ?? "";

    if (!query) {
      return data(
        payload({
          query,
          assets: [],
          audits: [],
          kits: [],
          bookings: [],
          locations: [],
          teamMembers: [],
        })
      );
    }

    const {
      organizationId,
      role,
      canSeeAllBookings,
      canSeeAllCustody,
      isSelfServiceOrBase,
      currentOrganization,
    } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.commandPaletteSearch,
      action: PermissionAction.read,
    });

    const terms = query
      .split(/[\s,]+/)
      .map((term) => term.trim())
      .filter(Boolean)
      .slice(0, 5);

    const searchTerms = terms.length > 0 ? terms : [query];

    // Check if this is a personal workspace - they don't have bookings or team members
    const isPersonalWorkspace = isPersonalOrg(currentOrganization);

    // Check permissions for different entity types based on actual roles
    const hasKitPermission = ["OWNER", "ADMIN"].includes(role);
    const hasBookingPermission =
      !isPersonalWorkspace &&
      ["OWNER", "ADMIN", "SELF_SERVICE", "BASE"].includes(role);
    const hasLocationPermission = ["OWNER", "ADMIN"].includes(role);
    const hasTeamMemberPermission =
      !isPersonalWorkspace && ["OWNER", "ADMIN"].includes(role);
    const hasAuditPermission = true;

    // Build Supabase OR filter strings for multi-term ilike search
    const buildIlikeOr = (fields: string[], terms: string[]): string =>
      terms
        .flatMap((term) => fields.map((field) => `${field}.ilike.%${term}%`))
        .join(",");

    // Execute parallel searches
    const [assetResults, audits, kits, bookings, locations, teamMembers] =
      await Promise.all([
        // Assets (always allowed) - using enhanced search from asset service
        getAssets({
          search: query,
          organizationId,
          page: 1,
          orderBy: "title",
          orderDirection: "asc",
          perPage: 8,
          extraInclude: {
            barcodes: {
              select: { id: true, value: true, type: true },
            },
          },
        }),

        // Audits (permission-gated)
        // KEEP AS PRISMA: uses nested `some` filter on `assignments` relation
        hasAuditPermission
          ? (async () => {
              const auditSearchConditions: Prisma.AuditSessionWhereInput[] =
                searchTerms.map((term) => ({
                  OR: [
                    {
                      name: {
                        contains: term,
                        mode: Prisma.QueryMode.insensitive,
                      },
                    },
                    {
                      description: {
                        contains: term,
                        mode: Prisma.QueryMode.insensitive,
                      },
                    },
                    {
                      id: {
                        contains: term,
                        mode: Prisma.QueryMode.insensitive,
                      },
                    },
                  ],
                }));

              const auditWhere: Prisma.AuditSessionWhereInput = {
                organizationId,
                ...(auditSearchConditions.length
                  ? { OR: auditSearchConditions }
                  : {}),
                ...(isSelfServiceOrBase && userId
                  ? {
                      assignments: {
                        some: {
                          userId,
                        },
                      },
                    }
                  : {}),
              };

              return db.auditSession.findMany({
                where: auditWhere,
                take: 6,
                orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
                select: {
                  id: true,
                  name: true,
                  description: true,
                  status: true,
                  dueDate: true,
                },
              });
            })()
          : Promise.resolve([]),

        // Kits (permission-gated) - Supabase
        hasKitPermission
          ? (async () => {
              const kitOrFilter = buildIlikeOr(
                ["name", "description", "id"],
                searchTerms
              );

              const { data: kitRows, error: kitError } = await sbDb
                .from("Kit")
                .select("*")
                .eq("organizationId", organizationId)
                .or(kitOrFilter)
                .order("updatedAt", { ascending: false })
                .order("name", { ascending: true })
                .limit(6);

              if (kitError) {
                throw new ShelfError({
                  cause: kitError,
                  message: "Failed to search kits",
                  label: "Kit",
                });
              }

              // _count: query asset counts separately
              const kitIds = (kitRows ?? []).map((k) => k.id);
              let kitAssetCounts: Record<string, number> = {};

              if (kitIds.length > 0) {
                const { data: countRows, error: countError } = await sbDb
                  .from("Asset")
                  .select("kitId", { count: "exact", head: false })
                  .in("kitId", kitIds);

                if (!countError && countRows) {
                  kitAssetCounts = countRows.reduce(
                    (acc, row) => {
                      if (row.kitId) {
                        acc[row.kitId] = (acc[row.kitId] || 0) + 1;
                      }
                      return acc;
                    },
                    {} as Record<string, number>
                  );
                }
              }

              return (kitRows ?? []).map((kit) => ({
                ...kit,
                _count: { assets: kitAssetCounts[kit.id] || 0 },
              }));
            })()
          : Promise.resolve([]),

        // Bookings (permission-gated) - Supabase
        hasBookingPermission
          ? (async () => {
              const bookingOrFilter = buildIlikeOr(
                ["name", "description", "id"],
                searchTerms
              );

              let bookingQuery = sbDb
                .from("Booking")
                .select(
                  "*, custodianUser:User!custodianUserId(firstName, lastName, email), custodianTeamMember:TeamMember!custodianTeamMemberId(name)"
                )
                .eq("organizationId", organizationId)
                .or(bookingOrFilter);

              // BASE and SELF_SERVICE users can only see their own bookings unless org settings allow otherwise
              if (!canSeeAllBookings) {
                bookingQuery = bookingQuery.eq("custodianUserId", userId);
              }

              const { data: bookingRows, error: bookingError } =
                await bookingQuery
                  .order("updatedAt", { ascending: false })
                  .order("name", { ascending: true })
                  .limit(6);

              if (bookingError) {
                throw new ShelfError({
                  cause: bookingError,
                  message: "Failed to search bookings",
                  label: "Booking",
                });
              }

              return bookingRows ?? [];
            })()
          : Promise.resolve([]),

        // Locations (permission-gated) - Supabase
        hasLocationPermission
          ? (async () => {
              const locationOrFilter = buildIlikeOr(
                ["name", "description", "address", "id"],
                searchTerms
              );

              const { data: locationRows, error: locationError } = await sbDb
                .from("Location")
                .select("*")
                .eq("organizationId", organizationId)
                .or(locationOrFilter)
                .order("updatedAt", { ascending: false })
                .order("name", { ascending: true })
                .limit(6);

              if (locationError) {
                throw new ShelfError({
                  cause: locationError,
                  message: "Failed to search locations",
                  label: "Location",
                });
              }

              // _count: query asset counts separately
              const locationIds = (locationRows ?? []).map((l) => l.id);
              let locationAssetCounts: Record<string, number> = {};

              if (locationIds.length > 0) {
                const { data: countRows, error: countError } = await sbDb
                  .from("Asset")
                  .select("locationId")
                  .in("locationId", locationIds);

                if (!countError && countRows) {
                  locationAssetCounts = countRows.reduce(
                    (acc, row) => {
                      if (row.locationId) {
                        acc[row.locationId] = (acc[row.locationId] || 0) + 1;
                      }
                      return acc;
                    },
                    {} as Record<string, number>
                  );
                }
              }

              return (locationRows ?? []).map((loc) => ({
                ...loc,
                _count: { assets: locationAssetCounts[loc.id] || 0 },
              }));
            })()
          : Promise.resolve([]),

        // Team members (permission-gated)
        // KEEP AS PRISMA: uses nested `some` on `custodies`/`kitCustodies` relations
        // and nested `user` relation search with `contains`
        hasTeamMemberPermission
          ? (async () => {
              const createTextSearchConditions = (
                term: string,
                fields: string[]
              ) =>
                fields.map((field) => ({
                  [field]: {
                    contains: term,
                    mode: Prisma.QueryMode.insensitive,
                  },
                }));

              const teamMemberSearchConditions: Prisma.TeamMemberWhereInput[] =
                searchTerms.map((term) => ({
                  OR: [
                    {
                      name: {
                        contains: term,
                        mode: Prisma.QueryMode.insensitive,
                      },
                    },
                    {
                      id: {
                        contains: term,
                        mode: Prisma.QueryMode.insensitive,
                      },
                    },
                    {
                      user: {
                        OR: [
                          ...createTextSearchConditions(term, [
                            "firstName",
                            "lastName",
                            "email",
                          ]),
                        ],
                      },
                    },
                  ],
                }));

              const teamMemberWhere: Prisma.TeamMemberWhereInput = {
                organizationId,
                deletedAt: null,
                ...(teamMemberSearchConditions.length
                  ? { OR: teamMemberSearchConditions }
                  : {}),
                // BASE and SELF_SERVICE users can only see team members they have custody access to
                ...(canSeeAllCustody
                  ? {}
                  : {
                      OR: [
                        {
                          custodies: {
                            some: {
                              custodian: { userId },
                            },
                          },
                        },
                        {
                          kitCustodies: {
                            some: {
                              custodian: { userId },
                            },
                          },
                        },
                        { userId },
                      ],
                    }),
              };

              return db.teamMember.findMany({
                where: teamMemberWhere,
                take: 8,
                orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
                include: {
                  user: {
                    select: {
                      firstName: true,
                      lastName: true,
                      email: true,
                    },
                  },
                },
              });
            })()
          : Promise.resolve([]),
      ]);

    return data(
      payload({
        query,
        assets: assetResults.assets.map((asset) => ({
          id: asset.id,
          title: asset.title,
          sequentialId: asset.sequentialId,
          mainImage: asset.mainImage,
          mainImageExpiration: asset.mainImageExpiration?.toISOString() ?? null,
          locationName: asset.location?.name ?? null,
          description: asset.description,
          qrCodes: asset.qrCodes?.map((qr) => qr.id) ?? [],
          categoryName: asset.category?.name ?? null,
          tagNames: asset.tags?.map((tag) => tag.name) ?? [],
          custodianName: (asset.custody as any)?.custodian?.name ?? null,
          custodianUserName: (asset.custody as any)?.custodian?.user
            ? `${(asset.custody as any).custodian.user.firstName} ${
                (asset.custody as any).custodian.user.lastName
              }`.trim()
            : null,
          barcodes: asset.barcodes?.map((barcode) => barcode.value) ?? [],
          customFieldValues:
            asset.customFields
              ?.map((cf) => {
                const value = cf.value as any;
                const extractedValue = value?.raw ?? value ?? "";
                return String(extractedValue);
              })
              .filter(Boolean) ?? [],
        })),
        audits: audits.map((audit) => ({
          id: audit.id,
          name: audit.name,
          description: audit.description || null,
          status: audit.status,
          dueDate: audit.dueDate ? new Date(audit.dueDate).toISOString() : null,
        })),
        kits: kits.map((kit) => ({
          id: kit.id,
          name: kit.name,
          description: kit.description || null,
          status: kit.status,
          assetCount: kit._count?.assets || 0,
        })),
        bookings: bookings.map((booking: any) => ({
          id: booking.id,
          name: booking.name,
          description: booking.description || null,
          status: booking.status,
          custodianName: booking.custodianUser
            ? `${booking.custodianUser.firstName} ${booking.custodianUser.lastName}`.trim()
            : booking.custodianTeamMember?.name || null,
          from: booking.from ? new Date(booking.from).toISOString() : null,
          to: booking.to ? new Date(booking.to).toISOString() : null,
        })),
        locations: locations.map((location) => ({
          id: location.id,
          name: location.name,
          description: location.description || null,
          address: location.address || null,
          assetCount: location._count?.assets || 0,
        })),
        teamMembers: teamMembers.map((member) => ({
          id: member.id,
          name: member.name,
          email: member.user?.email || null,
          firstName: member.user?.firstName || null,
          lastName: member.user?.lastName || null,
          userId: member.userId,
        })),
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
