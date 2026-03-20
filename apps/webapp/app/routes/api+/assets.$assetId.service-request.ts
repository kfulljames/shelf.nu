import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import {
  createServiceRequest,
  submitToT0,
} from "~/modules/service-request/service.server";
import { ASSETMESH_API_KEY, ASSETMESH_API_URL } from "~/utils/env";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, getParams, parseData, payload } from "~/utils/http.server";
import { Logger } from "~/utils/logger";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    if (request.method !== "POST") {
      throw new ShelfError({
        cause: null,
        message: "Method not allowed",
        label: "Integration",
        status: 405,
      });
    }

    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.asset,
      action: PermissionAction.read,
    });

    const { assetId } = getParams(params, z.object({ assetId: z.string() }));

    const formData = await request.formData();
    const { title, description, priority } = parseData(
      formData,
      z.object({
        title: z.string().min(1, "Title is required"),
        description: z.string().optional(),
        priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
      })
    );

    const serviceRequest = await createServiceRequest({
      organizationId,
      assetId,
      requestedById: userId,
      title,
      description,
      priority,
    });

    // Fire-and-forget T0 submission if configured
    if (ASSETMESH_API_URL && ASSETMESH_API_KEY) {
      void submitToT0({
        serviceRequestId: serviceRequest.id,
        organizationId,
        t0ApiUrl: ASSETMESH_API_URL,
        t0ApiKey: ASSETMESH_API_KEY,
      }).catch((cause) => {
        Logger.error(cause);
      });
    }

    return data(payload({ success: true, serviceRequest }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
