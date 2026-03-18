import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { requireAuditAssigneeForBaseSelfService } from "~/modules/audit/service.server";
import { exportAuditNotesToCsv } from "~/utils/csv.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, getParams } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const buildFilename = (name: string | null | undefined) => {
  const fallback = "audit";
  const source = name && name.trim().length > 0 ? name : fallback;
  const sanitizedName = source
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const base = sanitizedName.length > 0 ? sanitizedName : fallback;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  return `${base}-activity-${timestamp}.csv`;
};

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  const { auditId } = getParams(params, z.object({ auditId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const permissionResult = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.audit,
      action: PermissionAction.read,
    });

    const { organizationId, isSelfServiceOrBase } = permissionResult;

    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.auditNote,
      action: PermissionAction.read,
    });

    const { data: audit, error: auditError } = await sbDb
      .from("AuditSession")
      .select("name")
      .eq("id", auditId)
      .eq("organizationId", organizationId)
      .single();

    if (auditError) {
      throw new ShelfError({
        cause: auditError,
        title: "Audit not found",
        message:
          "The audit you are trying to access does not exist or you do not have permission to access it.",
        additionalData: { userId, auditId },
        status: 404,
        label: "Audit",
      });
    }

    const { data: assignments } = await sbDb
      .from("AuditAssignment")
      .select("userId")
      .eq("auditSessionId", auditId);

    // Reconstruct the shape expected by requireAuditAssigneeForBaseSelfService
    const auditWithAssignments = {
      ...audit,
      assignments: assignments || [],
    };

    requireAuditAssigneeForBaseSelfService({
      audit: auditWithAssignments,
      userId,
      isSelfServiceOrBase,
      auditId,
    });

    const csv = await exportAuditNotesToCsv({
      request,
      auditId,
      organizationId,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="${buildFilename(
          audit.name
        )}"`,
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
