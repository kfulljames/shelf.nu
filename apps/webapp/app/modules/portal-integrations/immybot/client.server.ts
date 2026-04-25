import { ShelfError } from "~/utils/error";
import {
  getVendedCredentials,
  invalidateVendedCredentials,
  type OAuth2VendedCredentials,
} from "../credentials.server";
import type { NormalizedDevice } from "../devices/mapper.server";

const SLUG = "immybot";

type CallerContext = {
  portalToken: string;
  tenantId: string;
};

export type ImmyBotListParams = {
  page?: number;
  pageSize?: number;
};

/**
 * ImmyBot returns a lot of fields per computer that we don't need to
 * model exhaustively — the adapter just surfaces the ones we know how
 * to consume and passes everything else through in `metadata`.
 */
export type ImmyBotComputer = {
  computerId: string;
  computerName?: string;
  serialNumber?: string;
  manufacturer?: string;
  model?: string;
  operatingSystem?: string;
  networkAdapters?: Array<{ macAddress?: string }>;
  [extra: string]: unknown;
};

async function vendImmyBot(
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
      message: "Expected oauth2_token credentials for ImmyBot",
      label: "Integration",
    });
  }
  return creds;
}

async function immyBotFetch(
  ctx: CallerContext,
  path: string,
  init?: RequestInit
): Promise<Response> {
  let creds = await vendImmyBot(ctx);
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
    creds = await vendImmyBot(ctx, { forceRefresh: true });
    res = await fetch(`${creds.baseUrl}${path}`, {
      ...init,
      headers: headers(creds.accessToken),
    });
  }

  return res;
}

function buildQuery(params: ImmyBotListParams): string {
  const search = new URLSearchParams();
  if (params.page !== undefined) search.set("page", String(params.page));
  if (params.pageSize !== undefined) {
    search.set("pageSize", String(params.pageSize));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export async function listComputers(
  ctx: CallerContext,
  params: ImmyBotListParams = {}
): Promise<ImmyBotComputer[]> {
  const query = buildQuery(params);
  const res = await immyBotFetch(ctx, `/computers${query}`);
  if (!res.ok) {
    throw new ShelfError({
      cause: null,
      message: `ImmyBot listComputers failed: ${res.status}`,
      additionalData: { status: res.status },
      label: "Integration",
    });
  }
  return (await res.json()) as ImmyBotComputer[];
}

/** Paginate until a short or empty page returns. Same guardrails as
 * the ConnectWise walker. */
export async function listAllComputers(
  ctx: CallerContext,
  params: Omit<ImmyBotListParams, "page"> & { maxPages?: number } = {}
): Promise<ImmyBotComputer[]> {
  const pageSize = params.pageSize ?? 100;
  const maxPages = params.maxPages ?? 1000;
  const out: ImmyBotComputer[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await listComputers(ctx, { page, pageSize });
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

/**
 * Convert an ImmyBot computer into the vendor-agnostic
 * NormalizedDevice shape consumed by the device->asset mapper.
 */
export function normalizeImmyBotComputer(
  computer: ImmyBotComputer
): NormalizedDevice {
  const macAddresses = (computer.networkAdapters ?? [])
    .map((a) => a?.macAddress?.trim())
    .filter((m): m is string => Boolean(m));

  const name = computer.computerName?.trim() || computer.computerId;

  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(computer)) {
    if (
      [
        "computerId",
        "computerName",
        "serialNumber",
        "manufacturer",
        "model",
        "operatingSystem",
        "networkAdapters",
      ].includes(k)
    ) {
      continue;
    }
    metadata[k] = v;
  }

  return {
    source: SLUG,
    sourceRecordId: computer.computerId,
    name,
    serialNumber: computer.serialNumber ?? null,
    manufacturer: computer.manufacturer ?? null,
    model: computer.model ?? null,
    operatingSystem: computer.operatingSystem ?? null,
    macAddresses,
    metadata,
  };
}
