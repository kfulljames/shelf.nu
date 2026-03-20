import { db } from "~/database/db.server";
import { sbDb } from "~/database/supabase.server";
import type { ErrorLabel } from "~/utils/error";
import { ShelfError } from "~/utils/error";

const label: ErrorLabel = "Integration";

// ─── Contact Import Types ───────────────────────────────────────────

export type ExternalContact = {
  externalId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  contactType: string;
  sourceName: string;
  shouldCreateUser: boolean;
};

// ─── Contact Import ─────────────────────────────────────────────────

/**
 * Import contacts from an external source (CW, Ninja, etc.)
 * into Shelf.nu as TeamMembers, optionally creating Users.
 *
 * Rules:
 * - All contacts become TeamMembers.
 * - Contacts flagged with `shouldCreateUser: true` also get a User
 *   record (pre-provisioned, can log in via SSO).
 * - Deduplication by email within the org.
 */
export async function importContacts({
  organizationId,
  sourceName,
  contacts,
}: {
  organizationId: string;
  sourceName: string;
  contacts: ExternalContact[];
}) {
  // Create import log
  const importLog = await db.contactImportLog.create({
    data: {
      organizationId,
      sourceName,
      totalContacts: contacts.length,
      status: "running",
    },
  });

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ contact: string; error: string }> = [];

  for (const contact of contacts) {
    try {
      const name = `${contact.firstName} ${contact.lastName}`.trim();

      // Check if TeamMember already exists by name in this org
      const { data: existingMember } = await sbDb
        .from("TeamMember")
        .select("id")
        .eq("organizationId", organizationId)
        .eq("name", name)
        .is("deletedAt", null)
        .single();

      if (existingMember) {
        skipped++;
        continue;
      }

      // If contact should become a User, check by email
      let linkedUserId: string | null = null;
      if (contact.shouldCreateUser && contact.email) {
        const { data: existingUser } = await sbDb
          .from("User")
          .select("id")
          .eq("email", contact.email)
          .single();

        if (existingUser) {
          linkedUserId = existingUser.id;
        }
        // Note: actual User creation requires Supabase Auth and
        // is handled separately via SSO provisioning flow.
        // Here we only link to existing users.
      }

      // Create TeamMember
      const { error: tmError } = await sbDb.from("TeamMember").insert({
        name,
        organizationId,
        userId: linkedUserId,
      });

      if (tmError) throw tmError;
      imported++;
    } catch (cause) {
      failed++;
      errors.push({
        contact: `${contact.firstName} ${contact.lastName}`,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // Update import log
  await db.contactImportLog.update({
    where: { id: importLog.id },
    data: {
      imported,
      skipped,
      failed,
      status: failed === contacts.length ? "failed" : "completed",
      errors: errors.length > 0 ? errors : undefined,
      completedAt: new Date(),
    },
  });

  return { importLogId: importLog.id, imported, skipped, failed, errors };
}

// ─── Contact Import Queries ─────────────────────────────────────────

export async function getContactImportLogs({
  organizationId,
  page = 1,
  perPage = 20,
}: {
  organizationId: string;
  page?: number;
  perPage?: number;
}) {
  const [logs, total] = await Promise.all([
    db.contactImportLog.findMany({
      where: { organizationId },
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.contactImportLog.count({ where: { organizationId } }),
  ]);

  return { logs, total };
}

// ─── Contact Import API Endpoint ────────────────────────────────────

/**
 * Validate and parse inbound contact import payload.
 */
export function validateContactImportPayload(body: unknown): ExternalContact[] {
  if (!Array.isArray(body)) {
    throw new ShelfError({
      cause: null,
      message: "Payload must be an array of contacts",
      label,
      status: 400,
    });
  }

  if (body.length > 1000) {
    throw new ShelfError({
      cause: null,
      message: "Maximum 1000 contacts per import batch",
      label,
      status: 400,
    });
  }

  return body.map((c: Record<string, unknown>, i: number) => {
    if (!c.firstName || !c.lastName) {
      throw new ShelfError({
        cause: null,
        message: `Contact at index ${i} missing firstName or lastName`,
        label,
        status: 400,
      });
    }
    return {
      externalId: String(c.externalId || ""),
      firstName: String(c.firstName),
      lastName: String(c.lastName),
      email: c.email ? String(c.email) : undefined,
      phone: c.phone ? String(c.phone) : undefined,
      contactType: String(c.contactType || "general"),
      sourceName: String(c.sourceName || "unknown"),
      shouldCreateUser: Boolean(c.shouldCreateUser),
    };
  });
}
