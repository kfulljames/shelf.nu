import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { getPortalLaunchUrl } from "~/utils/portal-auth.server";

export const meta = () => [{ title: appendToMetaTitle("Home") }];

export const loader = ({ context }: LoaderFunctionArgs) => {
  if (context.isAuthenticated) {
    return redirect("/assets");
  }

  // No login page — redirect to portal for authentication
  return redirect(getPortalLaunchUrl());
};

export default function Route() {
  return null;
}
