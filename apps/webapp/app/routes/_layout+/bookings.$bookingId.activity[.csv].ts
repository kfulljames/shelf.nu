import { data, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { exportBookingNotesToCsv } from "~/utils/csv.server";
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

  const { bookingId } = getParams(params, z.object({ bookingId: z.string() }), {
    additionalData: { userId },
  });

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.read,
    });

    await requirePermission({
      userId,
      request,
      entity: PermissionEntity.bookingNote,
      action: PermissionAction.read,
    });

    const { data: booking, error: bookingError } = await sbDb
      .from("Booking")
      .select("name")
      .eq("id", bookingId)
      .eq("organizationId", organizationId)
      .single();

    if (bookingError) {
      throw new ShelfError({
        cause: bookingError,
        title: "Booking not found",
        message:
          "The booking you are trying to access does not exist or you do not have permission to access it.",
        additionalData: { userId, bookingId },
        status: 404,
        label: "Booking",
      });
    }

    const csv = await exportBookingNotesToCsv({
      request,
      bookingId,
      organizationId,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": buildContentDisposition(booking.name, {
          fallback: "booking",
          suffix: "-activity",
        }),
      },
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
