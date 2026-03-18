import { data, redirect } from "react-router";
import type { ActionFunctionArgs } from "react-router";
import { sbDb } from "~/database/supabase.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import {
  createBillingPortalSession,
  getOrCreateCustomerId,
} from "~/utils/stripe.server";

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requirePermission({
      userId: authSession.userId,
      request,
      entity: PermissionEntity.subscription,
      action: PermissionAction.update,
    });

    const { data: user, error: userError } = await sbDb
      .from("User")
      .select("email, firstName, lastName, customerId")
      .eq("id", authSession.userId)
      .single();

    if (userError || !user) {
      throw new ShelfError({
        cause: userError,
        message:
          "Something went wrong fetching the user. Please try again or contact support.",
        additionalData: { userId },
        label: "Subscription",
      });
    }

    const customerId = await getOrCreateCustomerId({
      id: userId,
      ...user,
    });

    const { url } = await createBillingPortalSession({
      customerId,
    });

    return redirect(url);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
