import { data, type ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { createAssetsFromBackupImport } from "~/modules/asset/service.server";
import { csvDataFromRequest } from "~/utils/csv.server";
import { ShelfError, makeShelfError } from "~/utils/error";
import { payload, error, getParams } from "~/utils/http.server";
import { extractCSVDataFromBackupImport } from "~/utils/import.server";
import { requireAdmin } from "~/utils/roles.server";

export async function action({ context, request, params }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const { organizationId } = getParams(
    params,
    z.object({ organizationId: z.string() }),
    {
      additionalData: { userId },
    }
  );

  try {
    await requireAdmin(userId);

    const { data: organization, error: orgError } = await sbDb
      .from("Organization")
      .select("*, owner:User!ownerId(*)")
      .eq("id", organizationId)
      .single();

    if (orgError || !organization) {
      throw new ShelfError({
        cause: orgError,
        message: "No organization found",
        additionalData: { userId, organizationId },
        label: "Organization",
      });
    }

    const csvData = await csvDataFromRequest({ request });

    if (csvData.length < 2) {
      throw new ShelfError({
        cause: null,
        message: "CSV file is empty",
        label: "CSV",
      });
    }

    const backupData = extractCSVDataFromBackupImport(csvData);

    await createAssetsFromBackupImport({
      data: backupData,
      userId: (organization.owner as any).id,
      organizationId,
    });

    return data(payload({ success: true }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, organizationId });
    return data(error(reason), { status: reason.status });
  }
}
