import { ShelfError } from "~/utils/error";
import {
  getVendedCredentials,
  invalidateVendedCredentials,
  type OAuth2VendedCredentials,
} from "../credentials.server";

const SLUG = "entra";

type CallerContext = {
  portalToken: string;
  tenantId: string;
};

/**
 * Minimal shape we consume from Microsoft Graph's /users payload.
 * `id` is Entra's stable `objectId`, preferred for matching.
 */
export type EntraUser = {
  id: string;
  userPrincipalName?: string;
  mail?: string | null;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
  accountEnabled?: boolean;
  [extra: string]: unknown;
};

type GraphListResponse = {
  value: EntraUser[];
  "@odata.nextLink"?: string;
};

async function vendEntra(
  ctx: CallerContext,
  options?: { forceRefresh?: boolean }
): Promise<OAuth2VendedCredentials> {
  const creds = await getVendedCredentials({
    slug: SLUG,
    portalToken: ctx.portalToken,
    tenantId: ctx.tenantId,
    forceRefresh: options?.forceRefresh,
  });
  if (creds.authMethod !== "oauth2_token") {
    throw new ShelfError({
      cause: null,
      message: "Expected oauth2_token credentials for Microsoft Entra",
      label: "Integration",
    });
  }
  return creds;
}

async function entraFetch(
  ctx: CallerContext,
  url: string,
  init?: RequestInit
): Promise<Response> {
  let creds = await vendEntra(ctx);
  const headers = (token: string): HeadersInit => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(init?.headers ?? {}),
  });

  let res = await fetch(url, { ...init, headers: headers(creds.accessToken) });

  if (res.status === 401) {
    invalidateVendedCredentials({ slug: SLUG, tenantId: ctx.tenantId });
    creds = await vendEntra(ctx, { forceRefresh: true });
    res = await fetch(url, { ...init, headers: headers(creds.accessToken) });
  }

  return res;
}

function resolveUrl(pathOrUrl: string, baseUrl: string): string {
  // Graph's @odata.nextLink is an absolute URL; relative paths use the
  // vended baseUrl.
  if (/^https?:/.test(pathOrUrl)) return pathOrUrl;
  return `${baseUrl}${pathOrUrl}`;
}

/** Fetch a single page of Graph /users. Pass a `nextLink` URL to
 * continue a prior walk; otherwise the walk starts from /users. */
export async function listUsersPage(
  ctx: CallerContext,
  options: { nextLink?: string; pageSize?: number } = {}
): Promise<GraphListResponse> {
  const creds = await vendEntra(ctx);
  const path = options.nextLink
    ? options.nextLink
    : `/users${options.pageSize ? `?$top=${options.pageSize}` : ""}`;

  const res = await entraFetch(ctx, resolveUrl(path, creds.baseUrl));
  if (!res.ok) {
    throw new ShelfError({
      cause: null,
      message: `Entra listUsersPage failed: ${res.status}`,
      additionalData: { status: res.status },
      label: "Integration",
    });
  }
  return (await res.json()) as GraphListResponse;
}

/** Walk /users following `@odata.nextLink` until it's absent. Capped
 * at `maxPages` (default 1000). */
export async function listAllUsers(
  ctx: CallerContext,
  params: { pageSize?: number; maxPages?: number } = {}
): Promise<EntraUser[]> {
  const maxPages = params.maxPages ?? 1000;
  const out: EntraUser[] = [];
  let nextLink: string | undefined;

  for (let i = 0; i < maxPages; i++) {
    const page: GraphListResponse = await listUsersPage(ctx, {
      nextLink,
      pageSize: nextLink ? undefined : params.pageSize,
    });
    out.push(...page.value);
    if (!page["@odata.nextLink"]) break;
    nextLink = page["@odata.nextLink"];
  }

  return out;
}

/** Canonical Shelf-facing shape extracted from an EntraUser. Returns
 * null when the user lacks any usable contact email. */
export type NormalizedEntraUser = {
  entraObjectId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  accountEnabled: boolean;
};

export function normalizeEntraUser(
  user: EntraUser
): NormalizedEntraUser | null {
  const email = (user.mail ?? user.userPrincipalName ?? "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) return null;

  return {
    entraObjectId: user.id,
    email,
    firstName: user.givenName?.trim() || null,
    lastName: user.surname?.trim() || null,
    accountEnabled: user.accountEnabled ?? true,
  };
}
