import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { assertIsPost } from "~/utils/http.server";
import { getPortalLaunchUrl } from "~/utils/portal-auth.server";

export function action({ context, request }: ActionFunctionArgs) {
  assertIsPost(request);

  context.destroySession();
  return redirect(getPortalLaunchUrl());
}

export function loader() {
  return redirect("/");
}
