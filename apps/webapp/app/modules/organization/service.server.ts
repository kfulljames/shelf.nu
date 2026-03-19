import {
  AssetIndexMode,
  OrganizationRoles,
  OrganizationType,
  Roles,
} from "@prisma/client";
import type { Organization, Prisma, TierId, User } from "@prisma/client";
import type { Sb } from "@shelf/database";
import type Stripe from "stripe";

import { sbDb } from "~/database/supabase.server";
import { sendEmail } from "~/emails/mail.server";
import { DEFAULT_MAX_IMAGE_UPLOAD_SIZE } from "~/utils/constants";
import { ADMIN_EMAIL } from "~/utils/env";
import type { ErrorLabel } from "~/utils/error";
import { isLikeShelfError, ShelfError } from "~/utils/error";
import { id as generateId } from "~/utils/id/id.server";
import {
  createStripeCustomer,
  customerHasPaymentMethod,
  getUserActiveSubscription,
  getUserActiveSubscriptions,
  premiumIsEnabled,
  transferSubscriptionToCustomer,
} from "~/utils/stripe.server";
import { newOwnerEmailText, previousOwnerEmailText } from "./email";
import { defaultFields } from "../asset-index-settings/helpers";
import { defaultUserCategories } from "../category/default-categories";
import { updateUserTierId } from "../tier/service.server";
import { getDefaultWeeklySchedule } from "../working-hours/service.server";

const label: ErrorLabel = "Organization";

export async function getOrganizationById(id: Organization["id"]) {
  try {
    const { data, error } = await sbDb
      .from("Organization")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      throw error || new Error("No organization found");
    }

    return {
      ...data,
      createdAt: new Date(data.createdAt),
      updatedAt: new Date(data.updatedAt),
      barcodesEnabledAt: data.barcodesEnabledAt
        ? new Date(data.barcodesEnabledAt)
        : null,
      auditsEnabledAt: data.auditsEnabledAt
        ? new Date(data.auditsEnabledAt)
        : null,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "No organization found with this ID",
      additionalData: { id },
      label,
    });
  }
}

export const getOrganizationByUserId = async ({
  userId,
  orgType,
}: {
  userId: User["id"];
  orgType: OrganizationType;
}) => {
  try {
    const { data, error } = await sbDb
      .from("Organization")
      .select("id, name, type, currency")
      .eq("userId", userId)
      .eq("type", orgType as Sb.OrganizationType)
      .limit(1)
      .single();

    if (error || !data) {
      throw error || new Error("No organization found");
    }

    return data;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "No organization found for this user.",
      additionalData: {
        userId,
        orgType,
      },
      label,
    });
  }
};

/**
 * Gets organizations that use the email domain for SSO
 * Supports multiple domains per organization via comma-separated domain strings
 * @param emailDomain - Email domain to check
 * @returns Array of organizations that use this domain for SSO
 */
export async function getOrganizationsBySsoDomain(emailDomain: string) {
  try {
    if (!emailDomain) {
      throw new ShelfError({
        cause: null,
        message: "Email domain is required",
        additionalData: { emailDomain },
        label: "SSO",
      });
    }

    // Query for organizations where the domain field contains the email domain
    // Organization has ssoDetailsId FK → SsoDetails
    const { data: orgs, error: orgsError } = await sbDb
      .from("Organization")
      .select("*")
      .not("ssoDetailsId", "is", null);

    if (orgsError) throw orgsError;
    if (!orgs || orgs.length === 0) return [];

    // Fetch SsoDetails for these orgs
    const ssoDetailIds = orgs
      .map((o) => o.ssoDetailsId)
      .filter(Boolean) as string[];
    const { data: ssoDetails, error: ssoError } = await sbDb
      .from("SsoDetails")
      .select("*")
      .in("id", ssoDetailIds)
      .ilike("domain", `%${emailDomain}%`);

    if (ssoError) throw ssoError;
    if (!ssoDetails || ssoDetails.length === 0) return [];

    const ssoDetailMap = new Map(ssoDetails.map((s) => [s.id, s]));

    // Combine org + ssoDetails for downstream compatibility
    // Cast date strings to Date objects for Prisma type compatibility
    const organizations = orgs
      .filter((org) => org.ssoDetailsId && ssoDetailMap.has(org.ssoDetailsId))
      .map((org) => {
        const sso = ssoDetailMap.get(org.ssoDetailsId!) ?? null;
        return {
          ...org,
          createdAt: new Date(org.createdAt),
          updatedAt: new Date(org.updatedAt),
          barcodesEnabledAt: org.barcodesEnabledAt
            ? new Date(org.barcodesEnabledAt)
            : null,
          auditsEnabledAt: org.auditsEnabledAt
            ? new Date(org.auditsEnabledAt)
            : null,
          ssoDetails: sso
            ? {
                ...sso,
                createdAt: new Date(sso.createdAt),
                updatedAt: new Date(sso.updatedAt),
              }
            : null,
        };
      });

    // Filter to ensure exact domain matches
    return organizations.filter((org) =>
      org.ssoDetails?.domain
        ? emailMatchesDomains(emailDomain, org.ssoDetails.domain)
        : false
    );
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to get organizations by SSO domain",
      additionalData: { emailDomain },
      label: "SSO",
    });
  }
}

export async function createOrganization({
  name,
  userId,
  image,
  currency,
}: Pick<Organization, "name" | "currency"> & {
  userId: User["id"];
  image: File | null;
}) {
  try {
    const { data: owner, error: ownerError } = await sbDb
      .from("User")
      .select("id, firstName, lastName")
      .eq("id", userId)
      .single();

    if (ownerError || !owner) {
      throw new ShelfError({
        cause: ownerError,
        message: "User not found",
        additionalData: { userId },
        label,
      });
    }

    // Insert Organization
    const orgId = generateId();
    const { data: org, error: orgError } = await sbDb
      .from("Organization")
      .insert({
        id: orgId,
        name,
        currency,
        type: OrganizationType.TEAM as Sb.OrganizationType,
        hasSequentialIdsMigrated: true, // New organizations don't need migration
        userId, // owner FK
      })
      .select()
      .single();

    if (orgError || !org) {
      throw orgError || new Error("Failed to create organization");
    }

    // Insert default categories
    const categoryInserts = defaultUserCategories.map((c) => ({
      ...c,
      userId,
      organizationId: orgId,
    }));
    const { error: catError } = await sbDb
      .from("Category")
      .insert(categoryInserts);
    if (catError) throw catError;

    // Insert UserOrganization (owner association)
    const { error: userOrgError } = await sbDb.from("UserOrganization").insert({
      userId,
      organizationId: orgId,
      roles: [OrganizationRoles.OWNER] as Sb.OrganizationRoles[],
    });
    if (userOrgError) throw userOrgError;

    // Insert TeamMember for the owner
    const { error: memberError } = await sbDb.from("TeamMember").insert({
      name: `${owner.firstName} ${owner.lastName} (Owner)`,
      userId: owner.id,
      organizationId: orgId,
    });
    if (memberError) throw memberError;

    // Insert AssetIndexSettings
    const { error: aisError } = await sbDb.from("AssetIndexSettings").insert({
      mode: AssetIndexMode.ADVANCED as Sb.AssetIndexMode,
      columns: defaultFields as unknown,
      userId,
      organizationId: orgId,
    });
    if (aisError) throw aisError;

    // Insert WorkingHours
    const { error: whError } = await sbDb.from("WorkingHours").insert({
      enabled: false,
      weeklySchedule: getDefaultWeeklySchedule() as unknown,
      organizationId: orgId,
    });
    if (whError) throw whError;

    // Insert BookingSettings
    const { error: bsError } = await sbDb.from("BookingSettings").insert({
      bufferStartTime: 0,
      organizationId: orgId,
    });
    if (bsError) throw bsError;

    // Insert image if provided
    if (image?.size && image?.size > 0) {
      const { data: imageData, error: imageError } = await sbDb
        .from("Image")
        .insert({
          blob: Buffer.from(await image.arrayBuffer()).toString("base64"),
          contentType: image.type,
          ownerOrgId: orgId,
          userId,
        })
        .select("id")
        .single();

      if (imageError || !imageData) {
        throw imageError || new Error("Failed to create image");
      }

      // Link image to organization
      const { error: linkError } = await sbDb
        .from("Organization")
        .update({ imageId: imageData.id })
        .eq("id", orgId);
      if (linkError) throw linkError;
    }

    return {
      ...org,
      createdAt: new Date(org.createdAt),
      updatedAt: new Date(org.updatedAt),
      barcodesEnabledAt: org.barcodesEnabledAt
        ? new Date(org.barcodesEnabledAt)
        : null,
      auditsEnabledAt: org.auditsEnabledAt
        ? new Date(org.auditsEnabledAt)
        : null,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while creating the organization. Please try again or contact support.",
      additionalData: { name, userId },
      label,
    });
  }
}
export async function updateOrganization({
  id,
  name,
  image,
  userId,
  currency,
  ssoDetails,
  hasSequentialIdsMigrated,
  qrIdDisplayPreference,
  showShelfBranding,
  customEmailFooter,
}: Pick<Organization, "id"> & {
  currency?: Organization["currency"];
  name?: string;
  userId: User["id"];
  image?: File | null;
  ssoDetails?: {
    selfServiceGroupId: string;
    adminGroupId: string;
    baseUserGroupId: string;
  };
  hasSequentialIdsMigrated?: Organization["hasSequentialIdsMigrated"];
  qrIdDisplayPreference?: Organization["qrIdDisplayPreference"];
  showShelfBranding?: Organization["showShelfBranding"];
  customEmailFooter?: string | null;
}) {
  try {
    // Build flat update payload for Organization
    const orgUpdate: Record<string, unknown> = {};
    if (name !== undefined) orgUpdate.name = name;
    if (currency) orgUpdate.currency = currency;
    if (qrIdDisplayPreference) {
      orgUpdate.qrIdDisplayPreference = qrIdDisplayPreference;
    }
    if (hasSequentialIdsMigrated !== undefined) {
      orgUpdate.hasSequentialIdsMigrated = hasSequentialIdsMigrated;
    }
    if (typeof showShelfBranding === "boolean") {
      orgUpdate.showShelfBranding = showShelfBranding;
    }
    if (customEmailFooter !== undefined) {
      orgUpdate.customEmailFooter = customEmailFooter;
    }

    // Handle SSO details update separately
    if (ssoDetails) {
      // Get the org's ssoDetailsId first
      const { data: orgForSso, error: orgSsoErr } = await sbDb
        .from("Organization")
        .select("ssoDetailsId")
        .eq("id", id)
        .single();

      if (orgSsoErr) throw orgSsoErr;

      if (orgForSso?.ssoDetailsId) {
        const { error: ssoUpdateErr } = await sbDb
          .from("SsoDetails")
          .update(ssoDetails)
          .eq("id", orgForSso.ssoDetailsId);
        if (ssoUpdateErr) throw ssoUpdateErr;
      }
    }

    // Handle image upsert separately
    if (image?.size && image?.size > 0) {
      if (image.size > DEFAULT_MAX_IMAGE_UPLOAD_SIZE) {
        throw new ShelfError({
          cause: null,
          message: `Image size exceeds maximum allowed size of ${
            DEFAULT_MAX_IMAGE_UPLOAD_SIZE / (1024 * 1024)
          }MB`,
          additionalData: { id, userId, field: "image" },
          label,
          shouldBeCaptured: false,
          status: 400,
        });
      }

      const imageBlob = Buffer.from(await image.arrayBuffer()).toString(
        "base64"
      );

      // Check if org already has an image
      const { data: existingOrg, error: existingOrgErr } = await sbDb
        .from("Organization")
        .select("imageId")
        .eq("id", id)
        .single();

      if (existingOrgErr) throw existingOrgErr;

      if (existingOrg?.imageId) {
        // Update existing image
        const { error: imgUpdateErr } = await sbDb
          .from("Image")
          .update({
            blob: imageBlob,
            contentType: image.type,
            ownerOrgId: id,
            userId,
          })
          .eq("id", existingOrg.imageId);
        if (imgUpdateErr) throw imgUpdateErr;
      } else {
        // Create new image and link to org
        const { data: newImage, error: imgCreateErr } = await sbDb
          .from("Image")
          .insert({
            blob: imageBlob,
            contentType: image.type,
            ownerOrgId: id,
            userId,
          })
          .select("id")
          .single();

        if (imgCreateErr || !newImage) {
          throw imgCreateErr || new Error("Failed to create image");
        }

        orgUpdate.imageId = newImage.id;
      }
    }

    // Update Organization if there are fields to update
    if (Object.keys(orgUpdate).length > 0) {
      const { data: updated, error: updateErr } = await sbDb
        .from("Organization")
        .update(orgUpdate)
        .eq("id", id)
        .select()
        .single();

      if (updateErr) throw updateErr;

      return {
        ...updated,
        createdAt: new Date(updated.createdAt),
        updatedAt: new Date(updated.updatedAt),
        barcodesEnabledAt: updated.barcodesEnabledAt
          ? new Date(updated.barcodesEnabledAt)
          : null,
        auditsEnabledAt: updated.auditsEnabledAt
          ? new Date(updated.auditsEnabledAt)
          : null,
      };
    }

    // If no org fields to update, just return the current org
    const { data: current, error: currentErr } = await sbDb
      .from("Organization")
      .select("*")
      .eq("id", id)
      .single();

    if (currentErr || !current) {
      throw currentErr || new Error("Organization not found");
    }

    return {
      ...current,
      createdAt: new Date(current.createdAt),
      updatedAt: new Date(current.updatedAt),
      barcodesEnabledAt: current.barcodesEnabledAt
        ? new Date(current.barcodesEnabledAt)
        : null,
      auditsEnabledAt: current.auditsEnabledAt
        ? new Date(current.auditsEnabledAt)
        : null,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: isLikeShelfError(cause)
        ? cause.message
        : "Something went wrong while updating the organization. Please try again or contact support.",
      additionalData: { id, userId, name },
      label,
    });
  }
}

export type OrganizationFromUser = Prisma.OrganizationGetPayload<{
  select: {
    id: true;
    type: true;
    name: true;
    imageId: true;
    userId: true;
    updatedAt: true;
    currency: true;
    enabledSso: true;
    owner: { select: { id: true; email: true } };
    ssoDetails: true;
    workspaceDisabled: true;
    selfServiceCanSeeCustody: true;
    selfServiceCanSeeBookings: true;
    baseUserCanSeeCustody: true;
    baseUserCanSeeBookings: true;
    barcodesEnabled: true;
    auditsEnabled: true;
    usedAuditTrial: true;
    hasSequentialIdsMigrated: true;
    qrIdDisplayPreference: true;
    showShelfBranding: true;
    customEmailFooter: true;
  };
}>;

export async function getUserOrganizations({ userId }: { userId: string }) {
  try {
    // 1. Get user organizations
    const { data: userOrgs, error: userOrgsError } = await sbDb
      .from("UserOrganization")
      .select("organizationId, roles")
      .eq("userId", userId);

    if (userOrgsError) throw userOrgsError;
    if (!userOrgs || userOrgs.length === 0) return [];

    // 2. Get user's lastSelectedOrganizationId
    const { data: userData, error: userError } = await sbDb
      .from("User")
      .select("lastSelectedOrganizationId")
      .eq("id", userId)
      .single();

    if (userError) throw userError;

    const orgIds = userOrgs.map((uo) => uo.organizationId);

    // 3. Get organizations
    const { data: orgs, error: orgsError } = await sbDb
      .from("Organization")
      .select(
        "id, type, name, imageId, userId, updatedAt, currency, enabledSso, ssoDetailsId, workspaceDisabled, selfServiceCanSeeCustody, selfServiceCanSeeBookings, baseUserCanSeeCustody, baseUserCanSeeBookings, barcodesEnabled, auditsEnabled, usedAuditTrial, hasSequentialIdsMigrated, qrIdDisplayPreference, showShelfBranding, customEmailFooter"
      )
      .in("id", orgIds);

    if (orgsError) throw orgsError;

    // 4. Get owner users for each organization
    const ownerUserIds = [
      ...new Set((orgs ?? []).map((o) => o.userId).filter(Boolean)),
    ];
    const { data: ownerUsers, error: ownersError } = await sbDb
      .from("User")
      .select("id, email")
      .in("id", ownerUserIds);

    if (ownersError) throw ownersError;

    // 5. Get SsoDetails for organizations that have them
    const ssoDetailIds = (orgs ?? [])
      .map((o) => o.ssoDetailsId)
      .filter(Boolean) as string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ssoDetailsMap = new Map<string, any>();
    if (ssoDetailIds.length > 0) {
      const { data: ssoData, error: ssoError } = await sbDb
        .from("SsoDetails")
        .select("*")
        .in("id", ssoDetailIds);

      if (ssoError) throw ssoError;
      ssoDetailsMap = new Map((ssoData ?? []).map((s) => [s.id, s]));
    }

    const ownerMap = new Map(
      (ownerUsers ?? []).map((u) => [u.id, { id: u.id, email: u.email }])
    );
    const orgMap = new Map(
      (orgs ?? []).map((org) => {
        const sso = org.ssoDetailsId
          ? (ssoDetailsMap.get(org.ssoDetailsId) ?? null)
          : null;
        return [
          org.id,
          {
            ...org,
            updatedAt: new Date(org.updatedAt),
            owner: ownerMap.get(org.userId) ?? { id: org.userId, email: "" },
            ssoDetails: sso
              ? {
                  ...sso,
                  createdAt: new Date(sso.createdAt),
                  updatedAt: new Date(sso.updatedAt),
                }
              : null,
          },
        ];
      })
    );

    // 6. Reassemble to match original return shape
    return userOrgs
      .filter((uo) => orgMap.has(uo.organizationId))
      .map((uo) => ({
        organizationId: uo.organizationId,
        roles: uo.roles,
        organization: orgMap.get(uo.organizationId)!,
        user: {
          lastSelectedOrganizationId:
            userData?.lastSelectedOrganizationId ?? null,
        },
      }));
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while fetching user organizations. Please try again or contact support.",
      additionalData: { userId },
      label,
    });
  }
}

export async function getOrganizationAdminsEmails({
  organizationId,
}: {
  organizationId: string;
}) {
  try {
    const { data: adminOrgs, error: adminOrgsError } = await sbDb
      .from("UserOrganization")
      .select("userId")
      .eq("organizationId", organizationId)
      .overlaps("roles", [OrganizationRoles.OWNER, OrganizationRoles.ADMIN]);

    if (adminOrgsError) throw adminOrgsError;

    const adminUserIds = (adminOrgs ?? []).map((a) => a.userId);
    if (adminUserIds.length === 0) return [];

    const { data: users, error: usersError } = await sbDb
      .from("User")
      .select("email")
      .in("id", adminUserIds);

    if (usersError) throw usersError;

    return (users ?? []).map((u) => u.email);
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while fetching organization admins emails. Please try again or contact support.",
      additionalData: { organizationId },
      label,
    });
  }
}

export async function toggleOrganizationSso({
  organizationId,
  enabledSso,
}: {
  organizationId: string;
  enabledSso: boolean;
}) {
  try {
    const { data, error } = await sbDb
      .from("Organization")
      .update({ enabledSso })
      .eq("id", organizationId)
      .eq("type", "TEAM" as Sb.OrganizationType)
      .select()
      .single();

    if (error) throw error;

    return data;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while toggling organization SSO. Please try again or contact support.",
      additionalData: { organizationId, enabledSso },
      label,
    });
  }
}

export async function toggleWorkspaceDisabled({
  organizationId,
  workspaceDisabled,
}: {
  organizationId: string;
  workspaceDisabled: boolean;
}) {
  try {
    const { data, error } = await sbDb
      .from("Organization")
      .update({ workspaceDisabled })
      .eq("id", organizationId)
      .eq("type", "TEAM" as Sb.OrganizationType)
      .select()
      .single();

    if (error) throw error;

    return data;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while toggling workspace disabled. Please try again or contact support.",
      additionalData: { organizationId, workspaceDisabled },
      label,
    });
  }
}

export async function toggleBarcodeEnabled({
  organizationId,
  barcodesEnabled,
}: {
  organizationId: string;
  barcodesEnabled: boolean;
}) {
  try {
    const { data, error } = await sbDb
      .from("Organization")
      .update({
        barcodesEnabled,
        barcodesEnabledAt: barcodesEnabled ? new Date().toISOString() : null,
      })
      .eq("id", organizationId)
      .select()
      .single();

    if (error) throw error;

    return data;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while toggling barcode functionality. Please try again or contact support.",
      additionalData: { organizationId, barcodesEnabled },
      label,
    });
  }
}

export async function toggleAuditEnabled({
  organizationId,
  auditsEnabled,
}: {
  organizationId: string;
  auditsEnabled: boolean;
}) {
  try {
    const { data, error } = await sbDb
      .from("Organization")
      .update({
        auditsEnabled,
        auditsEnabledAt: auditsEnabled ? new Date().toISOString() : null,
      })
      .eq("id", organizationId)
      .select()
      .single();

    if (error) throw error;

    return data;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while toggling audit functionality. Please try again or contact support.",
      additionalData: { organizationId, auditsEnabled },
      label,
    });
  }
}

/**
 * Utility function to parse and validate domains from a comma-separated string
 * @param domainsString - Comma-separated string of domains
 * @returns Array of cleaned domain strings
 */
export function parseDomains(domainsString: string): string[] {
  return domainsString
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Checks if a given email matches any of the provided comma-separated domains
 * @param email - Email address to check
 * @param domainsString - Comma-separated string of domains
 * @returns boolean indicating if email matches any domain
 */
export function emailMatchesDomains(
  emailDomain: string,
  domainsString: string | null
): boolean {
  if (!emailDomain || !domainsString) return false;
  const domains = parseDomains(domainsString);
  return domains.includes(emailDomain.toLowerCase());
}

/** Permissions functions */

/**
 * Gets the permissions columns in the organization table
 * Columns:
 * - selfServiceCanSeeCustody
 * - selfServiceCanSeeBookings
 * - baseUserCanSeeCustody
 * - baseUserCanSeeBookings
 */
export async function getOrganizationPermissionColumns(id: string) {
  const { data, error } = await sbDb
    .from("Organization")
    .select(
      "selfServiceCanSeeCustody, selfServiceCanSeeBookings, baseUserCanSeeCustody, baseUserCanSeeBookings"
    )
    .eq("id", id)
    .single();

  if (error) throw error;

  return data;
}

/**
 * Updates the permissions columns in the organization table
 * Updated columns:
 * - selfServiceCanSeeCustody
 * - selfServiceCanSeeBookings
 * - baseUserCanSeeCustody
 * - baseUserCanSeeBookings
 */
export async function updateOrganizationPermissions({
  id,
  configuration,
}: {
  id: string;
  configuration: {
    selfServiceCanSeeCustody: boolean;
    selfServiceCanSeeBookings: boolean;
    baseUserCanSeeCustody: boolean;
    baseUserCanSeeBookings: boolean;
  };
}) {
  const { data, error } = await sbDb
    .from("Organization")
    .update(configuration)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;

  return data;
}

export async function getOrganizationAdmins({
  organizationId,
}: {
  organizationId: Organization["id"];
}) {
  try {
    /** Get all the admins in current organization */
    const { data: admins, error: adminsError } = await sbDb
      .from("UserOrganization")
      .select("userId")
      .eq("organizationId", organizationId)
      .contains("roles", [OrganizationRoles.ADMIN]);

    if (adminsError) throw adminsError;

    const adminUserIds = (admins ?? []).map((a) => a.userId);
    if (adminUserIds.length === 0) return [];

    const { data: users, error: usersError } = await sbDb
      .from("User")
      .select("id, firstName, lastName, email")
      .in("id", adminUserIds);

    if (usersError) throw usersError;

    return users ?? [];
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Something went wrong while fetching organization admins.",
      label,
    });
  }
}

export async function transferOwnership({
  currentOrganization,
  newOwnerId,
  userId,
  transferSubscription = false,
}: {
  currentOrganization: Pick<Organization, "id" | "name" | "type">;
  newOwnerId: User["id"];
  userId: User["id"];
  /** Whether to transfer the owner's subscription to the new owner */
  transferSubscription?: boolean;
}) {
  try {
    if (currentOrganization.type === OrganizationType.PERSONAL) {
      throw new ShelfError({
        cause: null,
        message: "Personal workspaces cannot be transferred.",
        label,
      });
    }

    // Fetch current user
    const { data: userData, error: userError } = await sbDb
      .from("User")
      .select("id")
      .eq("id", userId)
      .single();

    if (userError || !userData) {
      throw new ShelfError({
        cause: userError,
        message: "Something went wrong while fetching current user.",
        label,
      });
    }

    // Fetch user's roles via the _RoleToUser join table
    const { data: roleJoins, error: roleJoinError } = await sbDb
      .from("_RoleToUser")
      .select("A")
      .eq("B", userId);

    if (roleJoinError) {
      throw new ShelfError({
        cause: roleJoinError,
        message: "Something went wrong while fetching current user.",
        label,
      });
    }

    let isCurrentUserShelfAdmin = false;
    if (roleJoins && roleJoins.length > 0) {
      const roleIds = roleJoins.map((rj) => rj.A);
      const { data: roles, error: rolesError } = await sbDb
        .from("Role")
        .select("name")
        .in("id", roleIds);

      if (rolesError) throw rolesError;
      isCurrentUserShelfAdmin = (roles ?? []).some(
        (role) => role.name === Roles.ADMIN
      );
    }

    /**
     * To transfer ownership, we need to:
     * 1. Update the owner of the organization
     * 2. Update the role of both users in the current organization
     * 3. Optionally transfer the subscription
     */
    // Fetch UserOrganization rows matching: (orgId AND (userId = newOwnerId OR roles contains OWNER))
    const { data: allOrgMembers, error: orgMembersError } = await sbDb
      .from("UserOrganization")
      .select("id, userId, roles")
      .eq("organizationId", currentOrganization.id);

    if (orgMembersError) throw orgMembersError;

    // Filter to the two relevant rows: new owner + current owner
    const relevantMembers = (allOrgMembers ?? []).filter(
      (uo) =>
        uo.userId === newOwnerId ||
        (uo.roles as string[]).includes(OrganizationRoles.OWNER)
    );

    // Fetch user details for these members
    const memberUserIds = [...new Set(relevantMembers.map((uo) => uo.userId))];
    const { data: memberUsers, error: memberUsersError } = await sbDb
      .from("User")
      .select(
        "id, firstName, lastName, email, customerId, tierId, usedFreeTrial"
      )
      .in("id", memberUserIds);

    if (memberUsersError) throw memberUsersError;

    // Fetch roles for each member user via _RoleToUser
    const { data: memberRoleJoins, error: memberRoleJoinError } = await sbDb
      .from("_RoleToUser")
      .select("A, B")
      .in("B", memberUserIds);

    if (memberRoleJoinError) throw memberRoleJoinError;

    const memberRoleIds = [
      ...new Set((memberRoleJoins ?? []).map((rj) => rj.A)),
    ];
    let memberRolesMap = new Map<string, Array<{ id: string; name: string }>>();
    if (memberRoleIds.length > 0) {
      const { data: memberRolesData, error: memberRolesError } = await sbDb
        .from("Role")
        .select("id, name")
        .in("id", memberRoleIds);

      if (memberRolesError) throw memberRolesError;

      const roleById = new Map((memberRolesData ?? []).map((r) => [r.id, r]));

      // Group roles by user
      for (const join of memberRoleJoins ?? []) {
        const role = roleById.get(join.A);
        if (role) {
          const existing = memberRolesMap.get(join.B) ?? [];
          existing.push({ id: role.id, name: role.name });
          memberRolesMap.set(join.B, existing);
        }
      }
    }

    const memberUserMap = new Map(
      (memberUsers ?? []).map((u) => [
        u.id,
        {
          ...u,
          roles: memberRolesMap.get(u.id) ?? [],
        },
      ])
    );

    // Assemble the userOrganization array matching Prisma's shape
    const userOrganization = relevantMembers.map((uo) => ({
      id: uo.id,
      roles: uo.roles as OrganizationRoles[],
      user: memberUserMap.get(uo.userId)!,
    }));

    const currentOwnerUserOrg = userOrganization.find((userOrg) =>
      userOrg.roles.includes(OrganizationRoles.OWNER)
    );
    /** Validate if the current user is a member of the organization */
    if (!currentOwnerUserOrg) {
      throw new ShelfError({
        cause: null,
        message: "Current user is not a member of the organization.",
        label,
      });
    }

    /**
     * Validate if the current user is the owner of organization
     * or is a Shelf admin
     */
    if (
      !currentOwnerUserOrg.roles.includes(OrganizationRoles.OWNER) &&
      !isCurrentUserShelfAdmin
    ) {
      throw new ShelfError({
        cause: null,
        message: "Current user is not the owner of the organization.",
        label,
      });
    }

    const newOwnerUserOrg = userOrganization.find(
      (userOrg) => userOrg.user.id === newOwnerId
    );
    if (!newOwnerUserOrg) {
      throw new ShelfError({
        cause: null,
        message: "New owner is not a member of the organization.",
        label,
      });
    }

    /** Validate if the new owner is ADMIN in the current organization */
    if (!newOwnerUserOrg.roles.includes(OrganizationRoles.ADMIN)) {
      throw new ShelfError({
        cause: null,
        message: "New owner is not an admin of the organization.",
        label,
      });
    }

    // Check if new owner already has an active subscription (BLOCK transfer)
    // This applies regardless of whether subscription transfer is requested,
    // as we don't want two owners with separate active subscriptions
    if (premiumIsEnabled) {
      const newOwnerActiveSubscription =
        await getUserActiveSubscription(newOwnerId);
      if (newOwnerActiveSubscription) {
        throw new ShelfError({
          cause: null,
          message:
            "Cannot transfer ownership to a user who already has an active subscription.",
          label,
        });
      }
    }

    // Track subscription transfer info for emails
    let subscriptionTransferred = false;
    const currentOwnerTierId = currentOwnerUserOrg.user.tierId as TierId;

    const { error: rpcError } = await sbDb.rpc("shelf_org_transfer_ownership", {
      p_org_id: currentOrganization.id,
      p_new_owner_user_id: newOwnerUserOrg.user.id,
      p_current_owner_user_org_id: currentOwnerUserOrg.id,
      p_new_owner_user_org_id: newOwnerUserOrg.id,
    });
    if (rpcError) throw rpcError;

    // Handle subscription transfer AFTER the ownership transfer succeeds
    // Wrapped in try/catch to ensure ownership transfer completes even if subscription transfer fails
    let subscriptionTransferError: Error | null = null;
    if (premiumIsEnabled && transferSubscription) {
      try {
        const activeSubscriptions = await getUserActiveSubscriptions(
          currentOwnerUserOrg.user.id
        );

        // Filter to subscriptions relevant to this workspace:
        // - Tier subscriptions (always relevant)
        // - Addon subscriptions linked to THIS workspace
        const relevantSubscriptions = filterRelevantSubscriptions(
          activeSubscriptions,
          currentOrganization.id
        );

        if (relevantSubscriptions.length > 0) {
          // Ensure new owner has a Stripe customer ID (only once)
          let newOwnerCustomerId: string | null | undefined =
            newOwnerUserOrg.user.customerId;
          if (!newOwnerCustomerId) {
            newOwnerCustomerId = await createStripeCustomer({
              email: newOwnerUserOrg.user.email,
              name: `${newOwnerUserOrg.user.firstName} ${newOwnerUserOrg.user.lastName}`,
              userId: newOwnerId,
            });
          }

          if (newOwnerCustomerId) {
            // Transfer each relevant subscription
            for (const sub of relevantSubscriptions) {
              await transferSubscriptionToCustomer({
                subscriptionId: sub.id,
                newCustomerId: newOwnerCustomerId,
              });
            }

            // Update tier if a tier subscription was transferred
            const hasTierSubscription = relevantSubscriptions.some((sub) =>
              isTierSubscription(sub)
            );
            if (hasTierSubscription) {
              await updateUserTierId(newOwnerId, currentOwnerTierId);
              await updateUserTierId(currentOwnerUserOrg.user.id, "free");
            }

            subscriptionTransferred = true;

            // Transfer usedFreeTrial flag if original owner used it
            // This prevents the new owner from starting another trial
            if (currentOwnerUserOrg.user.usedFreeTrial) {
              await sbDb
                .from("User")
                .update({ usedFreeTrial: true })
                .eq("id", newOwnerId);
            }

            // Check if new owner has a payment method on their Stripe customer
            // If not, set the warning flag so they see the banner
            const hasPaymentMethod =
              await customerHasPaymentMethod(newOwnerCustomerId);
            if (!hasPaymentMethod) {
              await sbDb
                .from("User")
                .update({ warnForNoPaymentMethod: true })
                .eq("id", newOwnerId);
            }
          }
        }
      } catch (error) {
        // Capture the error but don't throw - ownership transfer should still succeed
        subscriptionTransferError = error as Error;
      }
    }

    /** Send email to new owner */
    sendEmail({
      subject: `🎉 You're now the Owner of ${currentOrganization.name} - Shelf`,
      to: newOwnerUserOrg.user.email,
      text: newOwnerEmailText({
        newOwnerName: `${newOwnerUserOrg.user.firstName} ${newOwnerUserOrg.user.lastName}`,
        workspaceName: currentOrganization.name,
        subscriptionTransferred,
      }),
    });

    /** Send email to previous owner */
    sendEmail({
      subject: `🔁 You've Transferred Ownership of ${currentOrganization.name}`,
      to: currentOwnerUserOrg.user.email,
      text: previousOwnerEmailText({
        previousOwnerName: `${currentOwnerUserOrg.user.firstName} ${currentOwnerUserOrg.user.lastName}`,
        newOwnerName: `${newOwnerUserOrg.user.firstName} ${newOwnerUserOrg.user.lastName}`,
        workspaceName: currentOrganization.name,
        subscriptionTransferred,
      }),
    });

    /** Send admin notification */
    if (ADMIN_EMAIL) {
      const subscriptionStatus = subscriptionTransferError
        ? `Failed - ${subscriptionTransferError.message}`
        : subscriptionTransferred
          ? "Yes"
          : "No (not requested)";

      sendEmail({
        subject: subscriptionTransferError
          ? `⚠️ Workspace transferred with errors: ${currentOrganization.name}`
          : `Workspace transferred: ${currentOrganization.name}`,
        to: ADMIN_EMAIL,
        text: `A workspace ownership transfer has occurred.

Workspace: ${currentOrganization.name}
Workspace ID: ${currentOrganization.id}

Previous Owner: ${currentOwnerUserOrg.user.firstName} ${
          currentOwnerUserOrg.user.lastName
        } (${currentOwnerUserOrg.user.email})
New Owner: ${newOwnerUserOrg.user.firstName} ${
          newOwnerUserOrg.user.lastName
        } (${newOwnerUserOrg.user.email})

Subscription transferred: ${subscriptionStatus}
${
  subscriptionTransferError
    ? `\nError details: ${
        subscriptionTransferError.stack || subscriptionTransferError.message
      }`
    : ""
}`,
      });
    }

    return {
      newOwner: newOwnerUserOrg.user,
      subscriptionTransferred,
      subscriptionTransferError: subscriptionTransferError?.message,
    };
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: isLikeShelfError(cause)
        ? cause.message
        : "Something went wrong while transferring ownership. Please try again or contact support.",
      additionalData: { currentOrganization, newOwnerId },
      label,
    });
  }
}

/**
 * Resets showShelfBranding to true for all personal workspaces owned by a user.
 * Called when Plus user downgrades to free tier.
 *
 * @param userId - The ID of the user whose personal workspaces should be reset
 * @returns Promise resolving to the update result
 */
export async function resetPersonalWorkspaceBranding(userId: string) {
  try {
    const { error } = await sbDb
      .from("Organization")
      .update({ showShelfBranding: true })
      .eq("userId", userId)
      .eq("type", "PERSONAL" as Sb.OrganizationType);

    if (error) throw error;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message:
        "Something went wrong while resetting personal workspace branding.",
      additionalData: { userId },
      label,
    });
  }
}

/**
 * Checks if a Stripe subscription is a tier subscription
 * by looking at its line-item product metadata.
 */
function isTierSubscription(sub: Stripe.Subscription): boolean {
  return sub.items.data.some((item) => {
    const product = item.price?.product;
    if (typeof product === "object" && product && "metadata" in product) {
      return !!(product as Stripe.Product).metadata?.shelf_tier;
    }
    return false;
  });
}

/**
 * Checks if a Stripe subscription is an addon linked to a specific workspace.
 */
function isAddonForOrganization(
  sub: Stripe.Subscription,
  organizationId: string
): boolean {
  const subOrgId = sub.metadata?.organizationId;
  if (subOrgId !== organizationId) return false;

  return sub.items.data.some((item) => {
    const product = item.price?.product;
    if (typeof product === "object" && product && "metadata" in product) {
      return (product as Stripe.Product).metadata?.product_type === "addon";
    }
    return false;
  });
}

/**
 * Filters subscriptions to those relevant to a workspace transfer:
 * - Tier subscriptions (always relevant)
 * - Addon subscriptions linked to the specific workspace
 */
function filterRelevantSubscriptions(
  subscriptions: Stripe.Subscription[],
  organizationId: string
): Stripe.Subscription[] {
  return subscriptions.filter(
    (sub) =>
      isTierSubscription(sub) || isAddonForOrganization(sub, organizationId)
  );
}
