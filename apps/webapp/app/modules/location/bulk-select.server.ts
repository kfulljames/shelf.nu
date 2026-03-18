import type { KitStatus } from "@prisma/client";
import { sbDb } from "~/database/supabase.server";
import { getFilteredAssetIds } from "~/modules/asset/utils.server";
import { ShelfError } from "~/utils/error";
import { getCurrentSearchParams } from "~/utils/http.server";
import { ALL_SELECTED_KEY } from "~/utils/list";

/**
 * Resolves asset IDs for bulk location operations.
 * Handles ALL_SELECTED_KEY expansion using asset filters + locationId.
 */
export async function resolveLocationAssetIds({
  ids,
  organizationId,
  locationId,
  request,
}: {
  ids: string[];
  organizationId: string;
  locationId: string;
  request: Request;
}): Promise<string[]> {
  if (!ids.includes(ALL_SELECTED_KEY)) {
    return ids;
  }

  const searchParams = getCurrentSearchParams(request);
  const filteredIds = await getFilteredAssetIds({
    organizationId,
    currentSearchParams: searchParams.toString(),
  });

  if (filteredIds.length === 0) {
    return [];
  }

  const { data: assets, error } = await sbDb
    .from("Asset")
    .select("id")
    .in("id", filteredIds)
    .eq("locationId", locationId);

  if (error) {
    throw new ShelfError({
      cause: error,
      message: "Failed to resolve location asset IDs",
      label: "Assets",
    });
  }

  return (assets ?? []).map((a) => a.id);
}

/**
 * Resolves kit IDs for bulk location operations.
 * Handles ALL_SELECTED_KEY expansion using kit filters + locationId.
 */
export async function resolveLocationKitIds({
  ids,
  organizationId,
  locationId,
  request,
}: {
  ids: string[];
  organizationId: string;
  locationId: string;
  request: Request;
}): Promise<string[]> {
  if (!ids.includes(ALL_SELECTED_KEY)) {
    return ids;
  }

  const searchParams = getCurrentSearchParams(request);
  const currentSearchParams = searchParams.toString();
  const sp = new URLSearchParams(currentSearchParams);

  let query = sbDb
    .from("Kit")
    .select("id")
    .eq("organizationId", organizationId)
    .eq("locationId", locationId);

  const search = sp.get("s");
  const status = sp.get("status") === "ALL" ? null : sp.get("status");
  const teamMember = sp.get("teamMember");

  if (search) {
    query = query.ilike("name", `%${search.toLowerCase().trim()}%`);
  }
  if (status) {
    query = query.eq("status", status as KitStatus);
  }
  if (teamMember) {
    const { data: custodyRows } = await sbDb
      .from("KitCustody")
      .select("kitId")
      .eq("custodianId", teamMember);
    const custodyKitIds = (custodyRows ?? [])
      .map((r) => r.kitId)
      .filter(Boolean);
    if (custodyKitIds.length === 0) {
      return [];
    }
    query = query.in("id", custodyKitIds);
  }

  const { data: kits, error } = await query;

  if (error) {
    throw new ShelfError({
      cause: error,
      message: "Failed to resolve location kit IDs",
      label: "Kit",
    });
  }

  return (kits ?? []).map((k) => k.id);
}
