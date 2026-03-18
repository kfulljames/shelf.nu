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
 * API route to fetch kits by IDs for popover display
 * Used by KitsListComponent to show kit details
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId } = await requirePermission({
      request,
      userId,
      entity: PermissionEntity.kit,
      action: PermissionAction.read,
    });

    const url = new URL(request.url);
    const idsParam = url.searchParams.get("ids");

    if (!idsParam) {
      return data(payload({ kits: [] }));
    }

    const kitIds = idsParam.split(",").filter(Boolean);

    if (kitIds.length === 0) {
      return data(payload({ kits: [] }));
    }

    // Fetch kits
    const { data: kitRows, error: kitError } = await sbDb
      .from("Kit")
      .select("id, name, image, imageExpiration")
      .in("id", kitIds)
      .eq("organizationId", organizationId)
      .order("name", { ascending: true });

    if (kitError) {
      throw kitError;
    }

    // Fetch assets for kits with category
    const { data: assetRows } = await sbDb
      .from("Asset")
      .select(
        "id, title, mainImage, mainImageExpiration, kitId, category:Category!categoryId(name)"
      )
      .in("kitId", kitIds)
      .order("title", { ascending: true });

    // Group assets by kit and build _count
    const kits = (kitRows ?? []).map((kit) => {
      const kitAssets = (assetRows ?? []).filter(
        (a: any) => a.kitId === kit.id
      );
      return {
        ...kit,
        assets: kitAssets.map(({ kitId: _kitId, ...rest }) => rest),
        _count: { assets: kitAssets.length },
      };
    });

    return data(payload({ kits: kits as any }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
