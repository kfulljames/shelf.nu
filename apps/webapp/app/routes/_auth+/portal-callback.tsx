import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
import { provisionUserFromPortal } from "~/modules/user/portal-provisioning.server";
import { setCookie } from "~/utils/cookies.server";
import { Logger } from "~/utils/logger";
import {
  exchangeAuthCode,
  verifyPortalToken,
  mapPortalRoleToShelfRole,
  getPortalLaunchUrl,
} from "~/utils/portal-auth.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    // No code = redirect to portal for auth
    return redirect(getPortalLaunchUrl());
  }

  // 1. Exchange auth code for module-scoped JWT
  const { token } = await exchangeAuthCode(code);

  // 2. Verify and decode the JWT
  const claims = await verifyPortalToken(token);

  // 3. Check module access
  if (
    !claims.modules.includes("shelf") &&
    claims.role !== "superadmin" &&
    claims.role !== "superadmin_readonly"
  ) {
    throw new Response("Module access denied", { status: 403 });
  }

  // 4. Log breakglass sessions prominently (MANDATORY per MODULE_RBAC_GUIDE)
  if (claims.breakglass) {
    Logger.warn({
      event: "portal.breakglass_login",
      portalUserId: claims.sub,
      email: claims.email,
      tenantId: claims.tenantId,
      breakglass: true,
      breakglassExpires: claims.breakglassExpires ?? null,
      isReadonly: claims.isReadonly ?? false,
      impersonatedBy: claims.impersonatedBy ?? null,
    });
  }

  // 5. Auto-provision user + org in Shelf DB
  const { user, organization } = await provisionUserFromPortal(claims, token);

  // 6. Map portal role to shelf role (considers permissions + groups)
  const shelfRole = mapPortalRoleToShelfRole(
    claims.role,
    claims.permissions,
    claims.groups
  );

  // 7. Create local session
  context.setSession({
    portalToken: token,
    userId: user.id,
    portalUserId: claims.sub,
    email: claims.email,
    name: claims.name,
    role: claims.role,
    shelfRole,
    tenantId: claims.tenantId,
    tenantSlug: claims.tenantSlug,
    modules: claims.modules,
    groups: claims.groups,
    permissions: claims.permissions,
    isReadonly: claims.isReadonly || false,
    impersonatedBy: claims.impersonatedBy || null,
    breakglass: claims.breakglass || false,
    breakglassExpires: claims.breakglassExpires || null,
    expiresAt: claims.exp,
  });

  // 8. Redirect to assets (strip ?code= from URL)
  return redirect("/assets", {
    headers: [
      setCookie(await setSelectedOrganizationIdCookie(organization.id)),
    ],
  });
}
