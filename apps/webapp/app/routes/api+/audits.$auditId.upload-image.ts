import { data } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { createAuditAssetImagesAddedNote } from "~/modules/audit/helpers.server";
import { uploadAuditImage } from "~/modules/audit/image.service.server";
import { requireAuditAssigneeForBaseSelfService } from "~/modules/audit/service.server";
import { sendNotification } from "~/utils/emitter/send-notification.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { getParams, payload, error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function action({ request, params, context }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, isSelfServiceOrBase } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.audit,
      action: PermissionAction.update,
    });

    const { auditId } = getParams(params, z.object({ auditId: z.string() }), {
      additionalData: { userId },
    });

    // Enforce assignee access for BASE/SELF_SERVICE roles on audit mutations.
    const { data: auditData } = await sbDb
      .from("AuditSession")
      .select("id, organizationId")
      .eq("id", auditId)
      .single();

    // Fetch assignments separately
    const { data: assignments } = await sbDb
      .from("AuditAssignment")
      .select("userId")
      .eq("auditSessionId", auditId);

    const audit = auditData
      ? { ...auditData, assignments: assignments ?? [] }
      : null;

    if (!audit || audit.organizationId !== organizationId) {
      throw new ShelfError({
        cause: null,
        message: "Audit not found or access denied",
        additionalData: { userId, auditId },
        label: "Audit",
        status: 404,
      });
    }

    requireAuditAssigneeForBaseSelfService({
      audit,
      userId,
      isSelfServiceOrBase,
      auditId,
    });

    // Parse form data to extract auditAssetId if present
    const formData = await request.clone().formData();
    const auditAssetId = formData.get("auditAssetId") as string | null;

    const result = await uploadAuditImage({
      request,
      auditSessionId: auditId,
      organizationId,
      uploadedById: userId,
      auditAssetId: auditAssetId || undefined,
    });

    if (auditAssetId && result?.id) {
      // Create an automatic activity note for the image upload
      await createAuditAssetImagesAddedNote({
        auditSessionId: auditId,
        auditAssetId,
        userId,
        imageIds: [result.id],
      });
    }

    sendNotification({
      title: "Image uploaded",
      message: "Your audit image has been uploaded",
      icon: { name: "success", variant: "success" },
      senderId: authSession.userId,
    });

    return data(payload({ success: true, image: result }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
