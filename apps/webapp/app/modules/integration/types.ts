import { z } from "zod";

/**
 * Schema for a single golden record pushed by AssetMesh.
 *
 * The golden record is a normalized, deduplicated, enriched
 * representation of an asset from one or more RMM/PSA sources.
 */
export const goldenRecordSchema = z.object({
  /** Stable unique ID from AssetMesh */
  goldenRecordId: z.string().min(1),
  /** Source system name, e.g. "connectwise", "ninjarmm" */
  sourceName: z.string().min(1),
  /** Original record ID in the source system */
  sourceRecordId: z.string().min(1),

  // ── Core asset fields ──────────────────────────────────────────
  title: z.string().min(1),
  description: z.string().optional(),
  /** Category name – will be matched or created in Shelf */
  categoryName: z.string().optional(),
  /** Location name – will be matched or created in Shelf */
  locationName: z.string().optional(),

  // ── Extended fields stored as custom fields ────────────────────
  /** Key–value pairs mapped to Shelf custom fields (read-only) */
  customFields: z.record(z.string(), z.string()).optional(),

  // ── Field locking ──────────────────────────────────────────────
  /** Field names that should be locked from editing in Shelf */
  lockedFields: z.array(z.string()).optional(),

  // ── Metadata blob ──────────────────────────────────────────────
  /** Unmapped source data, stored as JSON for reference */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type GoldenRecord = z.infer<typeof goldenRecordSchema>;

/**
 * Schema for the full ingestion request payload.
 */
export const ingestionRequestSchema = z.object({
  records: z.array(goldenRecordSchema).min(1).max(500),
});

export type IngestionRequest = z.infer<typeof ingestionRequestSchema>;

/**
 * Result for a single record in the ingestion response.
 */
export type IngestionRecordResult = {
  goldenRecordId: string;
  assetId: string | null;
  status: "created" | "updated" | "failed";
  error?: string;
};

/**
 * Full ingestion response.
 */
export type IngestionResponse = {
  syncLogId: string;
  results: IngestionRecordResult[];
  summary: {
    created: number;
    updated: number;
    failed: number;
  };
};

/**
 * Schema for the delta sync completion request.
 * Called by AssetMesh after a full delta push to indicate which
 * golden records are still active. Records not in this list
 * will be archived.
 */
export const deltaSyncCompleteSchema = z.object({
  /** All golden record IDs that are currently active in the source */
  activeGoldenRecordIds: z.array(z.string().min(1)),
  /** Source name for scoping (e.g. "connectwise") */
  sourceName: z.string().min(1),
});

export type DeltaSyncCompleteRequest = z.infer<typeof deltaSyncCompleteSchema>;

/**
 * Write-back job status type.
 */
export type WriteBackStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "conflict";

// ─── Phase 4: Contact Import Schema ────────────────────────────────

export const contactImportSchema = z.object({
  contacts: z
    .array(
      z.object({
        externalId: z.string(),
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        contactType: z.string().default("general"),
        sourceName: z.string(),
        shouldCreateUser: z.boolean().default(false),
      })
    )
    .min(1)
    .max(1000),
});

export type ContactImportRequest = z.infer<typeof contactImportSchema>;

// ─── Phase 4: Location Sync Schema ─────────────────────────────────

export const locationSyncSchema = z.object({
  locations: z
    .array(
      z.object({
        externalId: z.string(),
        name: z.string().min(1),
        address: z.string().optional(),
        sourceName: z.string(),
      })
    )
    .min(1)
    .max(500),
});

export type LocationSyncRequest = z.infer<typeof locationSyncSchema>;

// ─── Phase 4: Microsoft OAuth Config ────────────────────────────────

/**
 * Configuration for Microsoft OAuth integration.
 * Stored in IntegrationSource.config when sourceName is "microsoft".
 *
 * The actual OAuth flow is handled by Supabase Auth —
 * these types define the configuration that MSP admins set up.
 */
export type MicrosoftOAuthConfig = {
  /** Azure AD tenant ID */
  tenantId: string;
  /** Azure AD application (client) ID */
  clientId: string;
  /** Allowed email domains for SSO */
  allowedDomains: string[];
  /** Whether to auto-provision users on first login */
  autoProvision: boolean;
  /** Default role for auto-provisioned users */
  defaultRole: "BASE" | "SELF_SERVICE";
};

export const microsoftOAuthConfigSchema = z.object({
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  allowedDomains: z.array(z.string().min(1)),
  autoProvision: z.boolean().default(false),
  defaultRole: z.enum(["BASE", "SELF_SERVICE"]).default("SELF_SERVICE"),
});

// ─── Phase 5: Service Request Schema ────────────────────────────────

export const createServiceRequestSchema = z.object({
  assetId: z.string().min(1),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  assignedToId: z.string().optional(),
});

export type CreateServiceRequestInput = z.infer<
  typeof createServiceRequestSchema
>;
