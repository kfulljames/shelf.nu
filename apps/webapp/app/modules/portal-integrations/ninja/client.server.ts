import { ShelfError } from "~/utils/error";
import {
  getVendedCredentials,
  invalidateVendedCredentials,
  type OAuth2VendedCredentials,
} from "../credentials.server";
import type { NormalizedDevice } from "../devices/mapper.server";

const SLUG = "ninja";

type CallerContext = {
  portalToken: string;
  tenantId: string;
};

export type NinjaListParams = {
  after?: number;
  pageSize?: number;
};

/**
 * NinjaRMM /devices response shape. Surfacing a minimal known subset;
 * anything else comes through in the NormalizedDevice metadata.
 */
export type NinjaDevice = {
  id: number;
  systemName?: string;
  displayName?: string;
  dnsName?: string;
  serialNumber?: string;
  system?: {
    manufacturer?: string;
    model?: string;
  };
  os?: {
    name?: string;
    version?: string;
  };
  nics?: Array<{ mac?: string }>;
  [extra: string]: unknown;
};

async function vendNinja(
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
      message: "Expected oauth2_token credentials for NinjaRMM",
      label: "Integration",
    });
  }
  return creds;
}

async function ninjaFetch(
  ctx: CallerContext,
  path: string,
  init?: RequestInit
): Promise<Response> {
  let creds = await vendNinja(ctx);
  const headers = (token: string): HeadersInit => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(init?.headers ?? {}),
  });

  let res = await fetch(`${creds.baseUrl}${path}`, {
    ...init,
    headers: headers(creds.accessToken),
  });

  if (res.status === 401) {
    invalidateVendedCredentials({ slug: SLUG, tenantId: ctx.tenantId });
    creds = await vendNinja(ctx, { forceRefresh: true });
    res = await fetch(`${creds.baseUrl}${path}`, {
      ...init,
      headers: headers(creds.accessToken),
    });
  }

  return res;
}

function buildQuery(params: NinjaListParams): string {
  const search = new URLSearchParams();
  if (params.after !== undefined) search.set("after", String(params.after));
  if (params.pageSize !== undefined) {
    search.set("pageSize", String(params.pageSize));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export async function listDevices(
  ctx: CallerContext,
  params: NinjaListParams = {}
): Promise<NinjaDevice[]> {
  const res = await ninjaFetch(ctx, `/devices${buildQuery(params)}`);
  if (!res.ok) {
    throw new ShelfError({
      cause: null,
      message: `NinjaRMM listDevices failed: ${res.status}`,
      additionalData: { status: res.status },
      label: "Integration",
    });
  }
  return (await res.json()) as NinjaDevice[];
}

/**
 * NinjaRMM uses cursor-style pagination via `?after=<lastId>&pageSize`.
 * We walk with an increasing `after` cursor until a short or empty
 * page is returned, with the same maxPages guardrail as the other
 * walkers.
 */
export async function listAllDevices(
  ctx: CallerContext,
  params: Omit<NinjaListParams, "after"> & { maxPages?: number } = {}
): Promise<NinjaDevice[]> {
  const pageSize = params.pageSize ?? 100;
  const maxPages = params.maxPages ?? 1000;
  const out: NinjaDevice[] = [];
  let after: number | undefined;

  for (let page = 0; page < maxPages; page++) {
    const batch = await listDevices(ctx, { pageSize, after });
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
    after = batch[batch.length - 1].id;
  }

  return out;
}

export function normalizeNinjaDevice(device: NinjaDevice): NormalizedDevice {
  if (device.id === undefined || device.id === null) {
    throw new Error("NinjaDevice.id is required for normalization");
  }

  const macAddresses = (device.nics ?? [])
    .map((n) => n?.mac?.trim())
    .filter((m): m is string => Boolean(m));

  const name =
    device.displayName?.trim() ||
    device.systemName?.trim() ||
    device.dnsName?.trim() ||
    String(device.id);

  const os = device.os
    ? [device.os.name, device.os.version].filter(Boolean).join(" ").trim() ||
      null
    : null;

  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(device)) {
    if (
      [
        "id",
        "systemName",
        "displayName",
        "dnsName",
        "serialNumber",
        "system",
        "os",
        "nics",
      ].includes(k)
    ) {
      continue;
    }
    metadata[k] = v;
  }

  return {
    source: SLUG,
    sourceRecordId: String(device.id),
    name,
    serialNumber: device.serialNumber ?? null,
    manufacturer: device.system?.manufacturer ?? null,
    model: device.system?.model ?? null,
    operatingSystem: os,
    macAddresses,
    metadata,
  };
}
