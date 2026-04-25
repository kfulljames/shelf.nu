import { ShelfError } from "~/utils/error";
import {
  getVendedCredentials,
  invalidateVendedCredentials,
  type ApiKeyVendedCredentials,
} from "../credentials.server";
import type { ConnectWiseCompany, ConnectWiseListParams } from "./types";

const SLUG = "connectwise";

type CallerContext = {
  portalToken: string;
  tenantId: string;
};

type ConnectWiseApiCredentials = {
  companyId: string;
  publicKey: string;
  privateKey: string;
  clientId: string;
};

function assertConnectWiseCredentials(
  creds: ApiKeyVendedCredentials
): asserts creds is ApiKeyVendedCredentials & {
  apiCredentials: ConnectWiseApiCredentials;
} {
  const required = ["companyId", "publicKey", "privateKey", "clientId"];
  for (const key of required) {
    if (typeof creds.apiCredentials?.[key] !== "string") {
      throw new ShelfError({
        cause: null,
        message: `ConnectWise credentials missing required field: ${key}`,
        label: "Integration",
      });
    }
  }
}

function buildHeaders(
  creds: ApiKeyVendedCredentials & {
    apiCredentials: ConnectWiseApiCredentials;
  }
): HeadersInit {
  const { companyId, publicKey, privateKey, clientId } = creds.apiCredentials;
  const basicAuth = Buffer.from(
    `${companyId}+${publicKey}:${privateKey}`
  ).toString("base64");
  return {
    Authorization: `Basic ${basicAuth}`,
    clientId,
    Accept: "application/json",
  };
}

async function vendConnectWise(
  ctx: CallerContext,
  options?: { forceRefresh?: boolean }
): Promise<
  ApiKeyVendedCredentials & { apiCredentials: ConnectWiseApiCredentials }
> {
  const creds = await getVendedCredentials({
    slug: SLUG,
    portalToken: ctx.portalToken,
    tenantId: ctx.tenantId,
    forceRefresh: options?.forceRefresh,
  });
  if (creds.authMethod !== "api_key") {
    throw new ShelfError({
      cause: null,
      message: "Expected api_key credentials for ConnectWise",
      label: "Integration",
    });
  }
  assertConnectWiseCredentials(creds);
  return creds;
}

async function connectWiseFetch(
  ctx: CallerContext,
  path: string,
  init?: RequestInit
): Promise<Response> {
  let creds = await vendConnectWise(ctx);
  let res = await fetch(`${creds.baseUrl}${path}`, {
    ...init,
    headers: { ...buildHeaders(creds), ...(init?.headers ?? {}) },
  });

  if (res.status === 401) {
    // Portal may have rotated keys or the cached ones are stale.
    invalidateVendedCredentials({ slug: SLUG, tenantId: ctx.tenantId });
    creds = await vendConnectWise(ctx, { forceRefresh: true });
    res = await fetch(`${creds.baseUrl}${path}`, {
      ...init,
      headers: { ...buildHeaders(creds), ...(init?.headers ?? {}) },
    });
  }

  return res;
}

function buildQuery(params: ConnectWiseListParams): string {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.pageSize !== undefined) {
    search.set("pageSize", String(params.pageSize));
  }
  if (params.conditions) search.set("conditions", params.conditions);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Fetch a single page of ConnectWise companies. */
export async function listCompanies(
  ctx: CallerContext,
  params: ConnectWiseListParams = {}
): Promise<ConnectWiseCompany[]> {
  const pageSize = params.pageSize ?? 100;
  const query = buildQuery({ ...params, pageSize });
  const res = await connectWiseFetch(ctx, `/company/companies${query}`);

  if (!res.ok) {
    throw new ShelfError({
      cause: null,
      message: `ConnectWise listCompanies failed: ${res.status}`,
      additionalData: { status: res.status },
      label: "Integration",
    });
  }

  return (await res.json()) as ConnectWiseCompany[];
}

/** Walk every page of `/company/companies` until ConnectWise returns an
 * empty page. Hard-capped at `maxPages` to protect against runaway sync
 * jobs. Default cap is 1000 pages × 100/page = 100k companies. */
export async function listAllCompanies(
  ctx: CallerContext,
  params: Omit<ConnectWiseListParams, "page"> & { maxPages?: number } = {}
): Promise<ConnectWiseCompany[]> {
  const pageSize = params.pageSize ?? 100;
  const maxPages = params.maxPages ?? 1000;
  const out: ConnectWiseCompany[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await listCompanies(ctx, { ...params, page, pageSize });
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

export async function getCompany(
  ctx: CallerContext,
  id: number
): Promise<ConnectWiseCompany> {
  const res = await connectWiseFetch(ctx, `/company/companies/${id}`);
  if (!res.ok) {
    throw new ShelfError({
      cause: null,
      message: `ConnectWise getCompany failed: ${res.status}`,
      additionalData: { status: res.status, companyId: id },
      label: "Integration",
    });
  }
  return (await res.json()) as ConnectWiseCompany;
}
