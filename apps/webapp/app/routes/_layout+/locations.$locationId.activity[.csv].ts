import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { exportLocationNotesToCsv } from "~/utils/csv.server";
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

  const { locationId } = getParams(
    params,
    z.object({ locationId: z.string() }),
    {
      additionalData: { userId },
    }
  );

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.location,
      action: PermissionAction.read,
    });

    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.locationNote,
      action: PermissionAction.read,
    });

    const { data: location, error: locationError } = await sbDb
      .from("Location")
      .select("name")
      .eq("id", locationId)
      .eq("organizationId", organizationId)
      .single();

    if (locationError) {
      throw new ShelfError({
        cause: locationError,
        title: "Location not found",
        message:
          "The location you are trying to access does not exist or you do not have permission to access it.",
        additionalData: { userId, locationId },
        status: 404,
        label: "Location",
      });
    }

    const csv = await exportLocationNotesToCsv({
      request,
      locationId,
      organizationId,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": buildContentDisposition(location.name, {
          fallback: "location",
          suffix: "-activity",
        }),
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
