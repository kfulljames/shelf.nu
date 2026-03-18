import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { makeShelfError } from "~/utils/error";
import { error, getParams, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.teamMember,
      action: PermissionAction.changeRole,
    });

    const url = new URL(request.url);
    const { userId: targetUserId } = getParams(
      Object.fromEntries(url.searchParams),
      z.object({ userId: z.string() }),
      { additionalData: { userId, organizationId } }
    );

    const [
      assetResult,
      categoryResult,
      tagResult,
      locationResult,
      customFieldResult,
      bookingResult,
      kitResult,
      assetReminderResult,
      imageResult,
    ] = await Promise.all([
      sbDb
        .from("Asset")
        .select("*", { count: "exact", head: true })
        .eq("userId", targetUserId)
        .eq("organizationId", organizationId),
      sbDb
        .from("Category")
        .select("*", { count: "exact", head: true })
        .eq("userId", targetUserId)
        .eq("organizationId", organizationId),
      sbDb
        .from("Tag")
        .select("*", { count: "exact", head: true })
        .eq("userId", targetUserId)
        .eq("organizationId", organizationId),
      sbDb
        .from("Location")
        .select("*", { count: "exact", head: true })
        .eq("userId", targetUserId)
        .eq("organizationId", organizationId),
      sbDb
        .from("CustomField")
        .select("*", { count: "exact", head: true })
        .eq("userId", targetUserId)
        .eq("organizationId", organizationId)
        .is("deletedAt", null),
      sbDb
        .from("Booking")
        .select("*", { count: "exact", head: true })
        .eq("creatorId", targetUserId)
        .eq("organizationId", organizationId),
      sbDb
        .from("Kit")
        .select("*", { count: "exact", head: true })
        .eq("createdById", targetUserId)
        .eq("organizationId", organizationId),
      sbDb
        .from("AssetReminder")
        .select("*", { count: "exact", head: true })
        .eq("createdById", targetUserId)
        .eq("organizationId", organizationId),
      sbDb
        .from("Image")
        .select("*", { count: "exact", head: true })
        .eq("userId", targetUserId)
        .eq("ownerOrgId", organizationId),
    ]);

    const assets = assetResult.count ?? 0;
    const categories = categoryResult.count ?? 0;
    const tags = tagResult.count ?? 0;
    const locations = locationResult.count ?? 0;
    const customFields = customFieldResult.count ?? 0;
    const bookings = bookingResult.count ?? 0;
    const kits = kitResult.count ?? 0;
    const assetReminders = assetReminderResult.count ?? 0;
    const images = imageResult.count ?? 0;

    const total =
      assets +
      categories +
      tags +
      locations +
      customFields +
      bookings +
      kits +
      assetReminders +
      images;

    return data(
      payload({
        assets,
        categories,
        tags,
        locations,
        customFields,
        bookings,
        kits,
        assetReminders,
        images,
        total,
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
