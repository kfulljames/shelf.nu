import { PORTAL_URL } from "~/utils/env";
import { ShelfError } from "~/utils/error";

/**
 * Response shape returned by the MSP Portal's credential vending endpoint
 * (`GET /api/v1/integrations/{slug}/credentials`). Mirrors the contract
 * described in MODULE_INTEGRATION.md.
 */
export type OAuth2VendedCredentials = {
  authMethod: "oauth2_token";
  baseUrl: string;
  /** Short-lived bearer token to use against the vendor API directly. */
  accessToken: string;
  /** Seconds until `accessToken` expires (typically ~3600). */
  expiresIn: number;
};

export type ApiKeyVendedCredentials = {
  authMethod: "api_key";
  baseUrl: string;
  apiCredentials: Record<string, string>;
};

export type VendedCredentials =
  | OAuth2VendedCredentials
  | ApiKeyVendedCredentials;

type CacheEntry = {
  /** Unix ms when this cache entry should no longer be used. */
  expiresAt: number;
  creds: OAuth2VendedCredentials;
};

// Cache is intentionally per-process and per-tenant. API-key credentials
// are never cached — they carry no expiry and refreshing is essentially
// free (just the portal round-trip), so we always fetch fresh.
const cache = new Map<string, CacheEntry>();

/** Safety margin: treat tokens as expired this many seconds before their
 * actual expiry so in-flight requests don't race the portal's clock. */
const EXPIRY_SAFETY_SECONDS = 60;

function cacheKey(tenantId: string, slug: string): string {
  return `${tenantId}:${slug}`;
}

function mapErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return "Integration does not support credential vending";
    case 401:
      return "Portal rejected the module JWT";
    case 403:
      return "User has no tenant assigned";
    case 404:
      return "Integration not found or not configured for this tenant";
    case 502:
      return "Portal could not exchange credentials with the vendor";
    default:
      return `Credential vending failed: ${status}`;
  }
}

type ShelfErrorStatus = 400 | 401 | 403 | 404 | 500 | 503;

function mapErrorStatus(httpStatus: number): ShelfErrorStatus {
  switch (httpStatus) {
    case 400:
    case 401:
    case 403:
    case 404:
      return httpStatus;
    case 502:
      // Portal → vendor upstream failure maps to service-unavailable in
      // our allowed status set, since ShelfError does not model 502.
      return 503;
    default:
      return 500;
  }
}

export async function getVendedCredentials(params: {
  slug: string;
  portalToken: string;
  tenantId: string;
  forceRefresh?: boolean;
}): Promise<VendedCredentials> {
  const { slug, portalToken, tenantId, forceRefresh = false } = params;
  const key = cacheKey(tenantId, slug);

  if (!forceRefresh) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.creds;
    }
  }

  let res: Response;
  try {
    res = await fetch(
      `${PORTAL_URL}/api/v1/integrations/${encodeURIComponent(
        slug
      )}/credentials`,
      { headers: { Authorization: `Bearer ${portalToken}` } }
    );
  } catch (cause) {
    throw new ShelfError({
      cause,
      message: "Network error calling the portal credential-vending endpoint",
      additionalData: { slug, tenantId },
      label: "Integration",
    });
  }

  if (!res.ok) {
    let portalError: { error?: string } = {};
    try {
      portalError = await res.json();
    } catch {
      // Body might not be JSON; fall back to the generic message.
    }

    throw new ShelfError({
      cause: null,
      status: mapErrorStatus(res.status),
      message: portalError.error ?? mapErrorMessage(res.status),
      additionalData: { slug, tenantId, status: res.status },
      label: "Integration",
    });
  }

  const body = (await res.json()) as { credentials: VendedCredentials };
  const creds = body.credentials;

  if (creds.authMethod === "oauth2_token") {
    const ttlMs = Math.max(0, (creds.expiresIn - EXPIRY_SAFETY_SECONDS) * 1000);
    cache.set(key, {
      creds,
      expiresAt: Date.now() + ttlMs,
    });
  }

  return creds;
}

/**
 * Drop any cached OAuth2 token for the given tenant/slug pair. Call this
 * when a vendor API returns 401 so the next request re-vends a fresh
 * token.
 */
export function invalidateVendedCredentials(params: {
  slug: string;
  tenantId: string;
}): void {
  cache.delete(cacheKey(params.tenantId, params.slug));
}

/**
 * Test-only: wipe the in-memory cache. Prevents cross-test leakage in
 * Vitest where the module is loaded once but multiple test cases assert
 * on the cache behaviour.
 */
export function __resetVendedCredentialsCacheForTest(): void {
  cache.clear();
}
