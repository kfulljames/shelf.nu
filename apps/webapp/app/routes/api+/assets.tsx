import { data, type LoaderFunctionArgs } from "react-router";
import { sbDb } from "~/database/supabase.server";
import { makeShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

/**
 * API route to fetch assets by IDs for popover display
 * Used by AssetsListComponent to show asset details
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId } = await requirePermission({
      request,
      userId,
      entity: PermissionEntity.asset,
      action: PermissionAction.read,
    });

    const url = new URL(request.url);
    const idsParam = url.searchParams.get("ids");

    if (!idsParam) {
      return data(payload({ assets: [] }));
    }

    const assetIds = idsParam.split(",").filter(Boolean);

    if (assetIds.length === 0) {
      return data(payload({ assets: [] }));
    }

    const { data: assets, error: assetError } = await sbDb
      .from("Asset")
      .select("id, title, mainImage")
      .in("id", assetIds)
      .eq("organizationId", organizationId)
      .order("title", { ascending: true });

    if (assetError) {
      throw assetError;
    }

    return data(payload({ assets: assets ?? [] }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
