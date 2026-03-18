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
 * API route to fetch audit images by IDs for display in completion notes
 * Used by AuditImagesComponent to show image thumbnails with preview
 */
export async function loader({ request, context }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const { organizationId } = await requirePermission({
      request,
      userId,
      entity: PermissionEntity.audit,
      action: PermissionAction.read,
    });

    const url = new URL(request.url);
    const idsParam = url.searchParams.get("ids");

    if (!idsParam) {
      return data(payload({ images: [] }));
    }

    const imageIds = idsParam.split(",").filter(Boolean);

    if (imageIds.length === 0) {
      return data(payload({ images: [] }));
    }

    const { data: images, error: imgError } = await sbDb
      .from("AuditImage")
      .select("id, imageUrl, thumbnailUrl, description, createdAt")
      .in("id", imageIds)
      .eq("organizationId", organizationId)
      .order("createdAt", { ascending: true });

    if (imgError) {
      throw imgError;
    }

    return data(payload({ images: images ?? [] }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
