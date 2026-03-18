import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { exportAssetNotesToCsv } from "~/utils/csv.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { buildContentDisposition, error, getParams } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  const { assetId } = getParams(params, z.object({ assetId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.read,
    });

    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.note,
      action: PermissionAction.read,
    });

    const { data: asset, error: assetError } = await sbDb
      .from("Asset")
      .select("title")
      .eq("id", assetId)
      .eq("organizationId", organizationId)
      .single();

    if (assetError) {
      throw new ShelfError({
        cause: assetError,
        title: "Asset not found",
        message:
          "The asset you are trying to access does not exist or you do not have permission to access it.",
        additionalData: { userId, assetId },
        status: 404,
        label: "Assets",
      });
    }

    const csv = await exportAssetNotesToCsv({
      request,
      assetId,
      organizationId,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": buildContentDisposition(asset.title, {
          fallback: "asset",
          suffix: "-activity",
        }),
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
