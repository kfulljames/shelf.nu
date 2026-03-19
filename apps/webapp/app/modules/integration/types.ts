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
