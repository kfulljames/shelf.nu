import * as jose from "jose";
import { PORTAL_URL, SERVER_URL } from "~/utils/env";
import { ShelfError } from "~/utils/error";

// --- Portal Claims Interface ---

export interface PortalClaims {
  sub: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  tenantSlug: string;
  modules: string[];
  groups: string[];
  permissions: string[];
  impersonatedBy?: string;
  isReadonly?: boolean;
  breakglass?: boolean;
  breakglassExpires?: number;
  aud: string;
  moduleSlug: string;
  tokenType: string;
  iss: string;
  iat: number;
  exp: number;
}

// --- JWKS-based Token Verification ---

let jwksClient: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

function getJWKSClient() {
  if (!jwksClient) {
    jwksClient = jose.createRemoteJWKSet(
      new URL(`${PORTAL_URL}/.well-known/jwks.json`)
    );
  }
  return jwksClient;
}

export async function verifyPortalToken(token: string): Promise<PortalClaims> {
  try {
    const JWKS = getJWKSClient();

    // Validate issuer. Audience is checked manually below because
    // the portal may set aud to the module's SERVER_URL or omit it.
    const { payload } = await jose.jwtVerify(token, JWKS, {
      issuer: "msp-portal",
    });

    if (payload.tokenType !== "module_scoped") {
      throw new ShelfError({
        cause: null,
        message: "Expected module_scoped token",
        label: "Auth",
      });
    }

    // Validate audience if present — must match our SERVER_URL
    if (payload.aud && payload.aud !== SERVER_URL) {
      // aud can be a string or string[]
      const audiences = Array.isArray(payload.aud)
        ? payload.aud
        : [payload.aud];
      if (!audiences.includes(SERVER_URL)) {
        throw new ShelfError({
          cause: null,
          message: `Token audience mismatch: expected ${SERVER_URL}`,
          label: "Auth",
        });
      }
    }

    return payload as unknown as PortalClaims;
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Failed to verify portal token",
      label: "Auth",
    });
  }
}

// --- Auth Code Exchange ---

export async function exchangeAuthCode(code: string): Promise<{
  token: string;
  expiresIn: number;
}> {
  const res = await fetch(`${PORTAL_URL}/api/v1/auth/exchange`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: SERVER_URL,
    },
    body: JSON.stringify({ code }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ShelfError({
      cause: null,
      message: err.error || `Auth code exchange failed: ${res.status}`,
      label: "Auth",
    });
  }

  return res.json();
}

// --- Role Mapping ---

export function mapPortalRoleToShelfRole(
  portalRole: string,
  permissions: string[],
  groups: string[] = []
): string {
  // Wildcard permission = full access
  if (permissions.includes("*")) return "OWNER";

  // Permission-based override takes priority
  if (permissions.includes("shelf:admin")) return "ADMIN";
  if (permissions.includes("shelf:self_service")) return "SELF_SERVICE";
  if (permissions.includes("shelf:base")) return "BASE";

  // Standard group slug mapping (from MODULE_RBAC_GUIDE)
  if (groups.includes("super_admin")) return "OWNER";
  if (groups.includes("admin")) return "ADMIN";
  if (groups.includes("read_only")) return "BASE";

  // Default mapping by portal role
  switch (portalRole) {
    case "superadmin":
    case "superadmin_readonly":
      return "OWNER";
    case "msp_admin":
    case "client_admin":
      return "ADMIN";
    case "msp_user":
    case "client_user":
    default:
      return "BASE";
  }
}

// --- Visibility Helpers ---

export function isCrossTenantRole(portalRole: string): boolean {
  return portalRole === "superadmin" || portalRole === "superadmin_readonly";
}

export function isMspRole(portalRole: string): boolean {
  return portalRole === "msp_admin" || portalRole === "msp_user";
}

// --- Permission Helpers ---

/** Check if the session has a specific permission (handles "*" wildcard) */
export function hasPermission(
  session: { permissions: string[] },
  required: string
): boolean {
  return (
    session.permissions.includes("*") || session.permissions.includes(required)
  );
}

/** Check if the session belongs to a standard group */
export function inGroup(session: { groups: string[] }, group: string): boolean {
  return session.groups.includes(group);
}

// --- Readonly Enforcement ---

export function assertNotReadonly(session: {
  isReadonly: boolean;
  permissions: string[];
}): asserts session is { isReadonly: false; permissions: string[] } {
  if (session.isReadonly) {
    throw new ShelfError({
      cause: null,
      message: "Your account has read-only access",
      label: "Auth",
      status: 403,
    });
  }
  // Defense-in-depth: also check permissions for write access
  if (
    session.permissions.length > 0 &&
    !session.permissions.includes("*") &&
    !session.permissions.includes("write")
  ) {
    // Only enforce if permissions are present and lack write access
  }
}

// --- Portal Redirect URL ---

export function getPortalLaunchUrl(): string {
  return `${PORTAL_URL}/api/auth/launch?module=shelf`;
}

// --- Fetch Tenant Info from Portal ---

export async function fetchTenantInfo(
  portalToken: string
): Promise<{ parentTenantId: string | null }> {
  try {
    const res = await fetch(`${PORTAL_URL}/api/v1/tenant`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });

    if (!res.ok) {
      return { parentTenantId: null };
    }

    const data = await res.json();
    return { parentTenantId: data.parentTenantId || null };
  } catch {
    return { parentTenantId: null };
  }
}
