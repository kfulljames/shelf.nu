import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, getParams } from "~/utils/http.server";
import { requireAdmin } from "~/utils/roles.server";
import { createQrCodesZip } from "~/utils/zip-qr-codes";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
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

    const url = new URL(request.url);
    const onlyOrphaned = url.searchParams.get("orphaned");

    let query;
    if (onlyOrphaned) {
      query = sbDb
        .from("Qr")
        .select("*")
        .eq("organizationId", organizationId)
        .is("assetId", null)
        .is("kitId", null);
    } else {
      query = sbDb
        .from("Qr")
        .select("*")
        .eq("organizationId", organizationId)
        .or("assetId.not.is.null,kitId.not.is.null");
    }

    const { data: codes, error: qrError } = await query;

    if (qrError) {
      throw new ShelfError({
        cause: qrError,
        message: "Something went wrong fetching the QR codes.",
        additionalData: { userId, organizationId },
        label: "QR",
      });
    }

    const zipBlob = await createQrCodesZip(codes || []);

    return new Response(zipBlob, {
      headers: { "content-type": "application/zip" },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
