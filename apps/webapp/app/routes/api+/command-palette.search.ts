import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";

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

        // Audits (permission-gated) - Supabase
        hasAuditPermission
          ? (async () => {
              // For self-service/base users, pre-filter to assigned sessions
              let assignedSessionIds: string[] | null = null;
              if (isSelfServiceOrBase && userId) {
                const { data: assignments } = await sbDb
                  .from("AuditAssignment")
                  .select("auditSessionId")
                  .eq("userId", userId);
                assignedSessionIds = (assignments ?? []).map(
                  (a) => a.auditSessionId
                );
                if (assignedSessionIds.length === 0) {
                  return [];
                }
              }

              const auditSearchOr = searchTerms
                .flatMap((term) => [
                  `name.ilike.%${term}%`,
                  `description.ilike.%${term}%`,
                  `id.ilike.%${term}%`,
                ])
                .join(",");

              let auditQuery = sbDb
                .from("AuditSession")
                .select("id, name, description, status, dueDate")
                .eq("organizationId", organizationId)
                .or(auditSearchOr);

              if (assignedSessionIds !== null) {
                auditQuery = auditQuery.in("id", assignedSessionIds);
              }

              const { data: auditRows, error: auditError } = await auditQuery
                .order("updatedAt", { ascending: false })
                .order("name", { ascending: true })
                .limit(6);

              if (auditError) {
                throw new ShelfError({
                  cause: auditError,
                  message: "Failed to search audits",
                  label: "Audit",
                });
              }

              return auditRows ?? [];
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

        // Team members (permission-gated) - Supabase
        hasTeamMemberPermission
          ? (async () => {
              // Search users table for term matches on firstName/lastName/email
              const userSearchOr = searchTerms
                .flatMap((term) => [
                  `firstName.ilike.%${term}%`,
                  `lastName.ilike.%${term}%`,
                  `email.ilike.%${term}%`,
                ])
                .join(",");

              const { data: matchingUsers } = await sbDb
                .from("User")
                .select("id")
                .or(userSearchOr);
              const matchingUserIds = (matchingUsers ?? []).map((u) => u.id);

              // Build TM search: name/id ilike OR userId in matching users
              const tmOrParts = searchTerms.flatMap((term) => [
                `name.ilike.%${term}%`,
                `id.ilike.%${term}%`,
              ]);
              if (matchingUserIds.length > 0) {
                tmOrParts.push(`userId.in.(${matchingUserIds.join(",")})`);
              }

              let tmQuery = sbDb
                .from("TeamMember")
                .select("*, user:User(firstName, lastName, email)")
                .eq("organizationId", organizationId)
                .is("deletedAt", null)
                .or(tmOrParts.join(","));

              // BASE/SELF_SERVICE: restrict to own team member
              // The Prisma nested `custodies.some.custodian.userId`
              // simplifies to TM.userId since custodian IS the TM
              if (!canSeeAllCustody) {
                tmQuery = tmQuery.eq("userId", userId);
              }

              const { data: tmRows, error: tmError } = await tmQuery
                .order("updatedAt", { ascending: false })
                .order("name", { ascending: true })
                .limit(8);

              if (tmError) {
                throw new ShelfError({
                  cause: tmError,
                  message: "Failed to search team members",
                  label: "Team",
                });
              }

              return (tmRows ?? []).map((tm: any) => ({
                ...tm,
                user: Array.isArray(tm.user)
                  ? tm.user[0] ?? null
                  : tm.user ?? null,
              }));
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
