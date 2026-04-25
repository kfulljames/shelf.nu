import { db } from "~/database/db.server";
import { ShelfError } from "~/utils/error";
import { Logger } from "~/utils/logger";
import { listAllCompanies } from "./client.server";
import type { ConnectWiseCompany } from "./types";

export type CompanySyncContext = {
  portalToken: string;
  tenantId: string;
};

export type CompanySyncResult = {
  fetched: number;
  updated: number;
  unmatched: number;
  skipped: number;
};

type OrganizationForSync = {
  id: string;
  name: string;
  portalTenantId: string | null;
  portalTenantSlug: string | null;
};

type CompanyUpdate = {
  name: string;
};

function normalizeIdentifier(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Turn a ConnectWise company payload into the minimal Shelf
 * Organization update. Kept deliberately small for Stage 4 — only name
 * is surfaced to users today. Add fields here when the UI needs them.
 */
function buildUpdateFromCompany(
  company: ConnectWiseCompany
): CompanyUpdate | null {
  if (company.deletedFlag) return null;
  if (!company.name) return null;
  return { name: company.name };
}

function indexCompaniesByIdentifier(
  companies: ConnectWiseCompany[]
): Map<string, ConnectWiseCompany> {
  const map = new Map<string, ConnectWiseCompany>();
  for (const c of companies) {
    const key = normalizeIdentifier(c.identifier);
    if (key) map.set(key, c);
  }
  return map;
}

/**
 * Pull every ConnectWise company the MSP manages (through the portal)
 * and upsert matching Shelf organizations by `portalTenantSlug`
 * (matched case-insensitively against CW's `identifier` field).
 *
 * Organizations with no `portalTenantSlug` or with a slug that doesn't
 * match any CW company are left untouched — they'll simply miss this
 * sync pass.
 */
export async function syncAllCompanies(
  ctx: CompanySyncContext
): Promise<CompanySyncResult> {
  const companies = await listAllCompanies(ctx);
  const byIdentifier = indexCompaniesByIdentifier(companies);

  const organizations = (await db.organization.findMany({
    where: { portalTenantId: { not: null } },
    select: {
      id: true,
      name: true,
      portalTenantId: true,
      portalTenantSlug: true,
    },
  })) as OrganizationForSync[];

  let updated = 0;
  let unmatched = 0;
  let skipped = 0;

  for (const org of organizations) {
    const slug = normalizeIdentifier(org.portalTenantSlug);
    if (!slug) {
      skipped += 1;
      continue;
    }

    const match = byIdentifier.get(slug);
    if (!match) {
      unmatched += 1;
      continue;
    }

    const patch = buildUpdateFromCompany(match);
    if (!patch || patch.name === org.name) {
      skipped += 1;
      continue;
    }

    try {
      await db.organization.update({
        where: { id: org.id },
        data: patch,
      });
      updated += 1;
    } catch (cause) {
      Logger.error(
        new ShelfError({
          cause,
          message: "Failed to apply ConnectWise sync update to organization",
          additionalData: { organizationId: org.id },
          label: "Integration",
        })
      );
    }
  }

  Logger.info(
    `[connectwise-sync] fetched=${companies.length} ` +
      `orgs=${organizations.length} updated=${updated} ` +
      `unmatched=${unmatched} skipped=${skipped}`
  );

  return {
    fetched: companies.length,
    updated,
    unmatched,
    skipped,
  };
}

/**
 * Called during portal first-launch provisioning for a single
 * organization. Same matching logic as `syncAllCompanies` but scoped
 * to one Org — avoids fetching the whole company list when only one
 * tenant is being provisioned.
 *
 * Returns the ConnectWise company identifier that matched, or `null`
 * if no match was found.
 */
export async function syncCompanyForOrganization(
  ctx: CompanySyncContext,
  org: OrganizationForSync
): Promise<string | null> {
  const slug = normalizeIdentifier(org.portalTenantSlug);
  if (!slug) return null;

  // For first-launch use we can afford to walk all companies — the
  // caller already accepted a portal round-trip. When the portal
  // exposes a direct `connectwiseCompanyId` per tenant this will
  // collapse to a single `getCompany()` call.
  const companies = await listAllCompanies(ctx);
  const match = indexCompaniesByIdentifier(companies).get(slug);
  if (!match) return null;

  const patch = buildUpdateFromCompany(match);
  if (!patch || patch.name === org.name) return match.identifier;

  await db.organization.update({
    where: { id: org.id },
    data: patch,
  });

  return match.identifier;
}
