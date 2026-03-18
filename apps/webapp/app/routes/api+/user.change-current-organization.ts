import { type ActionFunctionArgs, redirect, data } from "react-router";
import { z } from "zod";
import { sbDb } from "~/database/supabase.server";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
import { setCookie } from "~/utils/cookies.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, parseData, safeRedirect } from "~/utils/http.server";
import { Logger } from "~/utils/logger";

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { organizationId, redirectTo } = parseData(
      await request.formData(),
      z.object({
        organizationId: z.string(),
        redirectTo: z.string().optional(),
      })
    );

    // Verify the user is a member of the target organization
    const { data: membership, error: membershipError } = await sbDb
      .from("UserOrganization")
      .select("id")
      .eq("userId", userId)
      .eq("organizationId", organizationId)
      .single();

    if (membershipError || !membership) {
      throw new ShelfError({
        cause: membershipError,
        message: "You are not a member of this organization.",
        status: 403,
        label: "Organization",
      });
    }

    // Best-effort persist to database for cross-device workspace persistence.
    // Supabase .update() only touches specified fields, so updatedAt is not bumped.
    try {
      await sbDb
        .from("User")
        .update({ lastSelectedOrganizationId: organizationId })
        .eq("id", userId);
    } catch (cause) {
      Logger.warn(
        "Failed to persist lastSelectedOrganizationId",
        userId,
        organizationId,
        cause
      );
    }

    return redirect(safeRedirect(redirectTo), {
      headers: [
        setCookie(await setSelectedOrganizationIdCookie(organizationId)),
      ],
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
