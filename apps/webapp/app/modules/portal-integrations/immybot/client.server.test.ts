// @vitest-environment node

import { rest } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "~/../test/mocks";
import { ShelfError } from "~/utils/error";
import { __resetVendedCredentialsCacheForTest } from "../credentials.server";
import {
  listAllComputers,
  listComputers,
  normalizeImmyBotComputer,
} from "./client.server";

const PORTAL_URL = "https://portal.test";
const IMMY_BASE = "https://acme.immy.bot/api/v1";

function registerVending(overrides?: {
  accessToken?: string;
  status?: number;
}) {
  server.use(
    rest.get(
      `${PORTAL_URL}/api/v1/integrations/immybot/credentials`,
      (_req, res, ctx) =>
        res(
          ctx.status(overrides?.status ?? 200),
          ctx.json({
            credentials: {
              authMethod: "oauth2_token",
              baseUrl: IMMY_BASE,
              accessToken: overrides?.accessToken ?? "immy-token-1",
              expiresIn: 3600,
            },
          })
        )
    )
  );
}

beforeEach(() => {
  __resetVendedCredentialsCacheForTest();
});

afterEach(() => {
  server.resetHandlers();
});

describe("listComputers", () => {
  it("sends a Bearer token and returns the parsed computer array", async () => {
    registerVending();
    server.use(
      rest.get(`${IMMY_BASE}/computers`, (req, res, ctx) => {
        expect(req.headers.get("authorization")).toBe("Bearer immy-token-1");
        expect(req.headers.get("accept")).toBe("application/json");
        return res(
          ctx.status(200),
          ctx.json([
            { computerId: "c-1", computerName: "DESKTOP-1" },
            { computerId: "c-2", computerName: "DESKTOP-2" },
          ])
        );
      })
    );

    const computers = await listComputers({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    expect(computers).toHaveLength(2);
    expect(computers[0].computerName).toBe("DESKTOP-1");
  });

  it("throws when the portal returns the wrong auth method", async () => {
    server.use(
      rest.get(
        `${PORTAL_URL}/api/v1/integrations/immybot/credentials`,
        (_req, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              credentials: {
                authMethod: "api_key",
                baseUrl: IMMY_BASE,
                apiCredentials: {},
              },
            })
          )
      )
    );

    await expect(
      listComputers({ portalToken: "jwt", tenantId: "tenant-1" })
    ).rejects.toThrow(/Expected oauth2_token/);
  });

  it("wraps non-2xx responses in a ShelfError", async () => {
    registerVending();
    server.use(
      rest.get(`${IMMY_BASE}/computers`, (_req, res, ctx) =>
        res(ctx.status(503), ctx.json({ error: "immybot down" }))
      )
    );
    await expect(
      listComputers({ portalToken: "jwt", tenantId: "tenant-1" })
    ).rejects.toThrow(ShelfError);
  });

  it("retries once with a freshly vended token on 401", async () => {
    let vendCalls = 0;
    server.use(
      rest.get(
        `${PORTAL_URL}/api/v1/integrations/immybot/credentials`,
        (_req, res, ctx) => {
          vendCalls += 1;
          return res(
            ctx.status(200),
            ctx.json({
              credentials: {
                authMethod: "oauth2_token",
                baseUrl: IMMY_BASE,
                accessToken: vendCalls === 1 ? "stale" : "fresh",
                expiresIn: 3600,
              },
            })
          );
        }
      )
    );
    server.use(
      rest.get(`${IMMY_BASE}/computers`, (req, res, ctx) => {
        if (req.headers.get("authorization") === "Bearer stale") {
          return res(ctx.status(401), ctx.json({ error: "expired" }));
        }
        return res(ctx.status(200), ctx.json([{ computerId: "ok" }]));
      })
    );

    const computers = await listComputers({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(vendCalls).toBe(2);
    expect(computers[0].computerId).toBe("ok");
  });
});

describe("listAllComputers", () => {
  it("walks pages until a short page is returned", async () => {
    registerVending();
    server.use(
      rest.get(`${IMMY_BASE}/computers`, (req, res, ctx) => {
        const page = Number(req.url.searchParams.get("page"));
        if (page === 1) {
          return res(
            ctx.status(200),
            ctx.json(
              Array.from({ length: 100 }, (_, i) => ({
                computerId: `c-${i + 1}`,
              }))
            )
          );
        }
        return res(ctx.status(200), ctx.json([{ computerId: "c-101" }]));
      })
    );

    const computers = await listAllComputers({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    expect(computers).toHaveLength(101);
  });

  it("respects maxPages", async () => {
    registerVending();
    server.use(
      rest.get(`${IMMY_BASE}/computers`, (req, res, ctx) => {
        const page = Number(req.url.searchParams.get("page"));
        return res(
          ctx.status(200),
          ctx.json([
            { computerId: `p-${page}-a` },
            { computerId: `p-${page}-b` },
          ])
        );
      })
    );

    const computers = await listAllComputers(
      { portalToken: "jwt", tenantId: "tenant-1" },
      { pageSize: 2, maxPages: 2 }
    );
    expect(computers).toHaveLength(4);
  });
});

describe("normalizeImmyBotComputer", () => {
  it("projects known fields and flattens network adapters into MACs", () => {
    const normalized = normalizeImmyBotComputer({
      computerId: "c-1",
      computerName: "DESKTOP-ACME-1",
      serialNumber: "SN-1",
      manufacturer: "Dell",
      model: "Latitude 7430",
      operatingSystem: "Windows 11 Pro",
      networkAdapters: [
        { macAddress: "00:11:22:33:44:55" },
        { macAddress: " AA:BB:CC:DD:EE:FF " },
        { macAddress: "" },
        {},
      ],
    });

    expect(normalized.source).toBe("immybot");
    expect(normalized.sourceRecordId).toBe("c-1");
    expect(normalized.name).toBe("DESKTOP-ACME-1");
    expect(normalized.serialNumber).toBe("SN-1");
    expect(normalized.manufacturer).toBe("Dell");
    expect(normalized.model).toBe("Latitude 7430");
    expect(normalized.operatingSystem).toBe("Windows 11 Pro");
    expect(normalized.macAddresses).toEqual([
      "00:11:22:33:44:55",
      "AA:BB:CC:DD:EE:FF",
    ]);
  });

  it("falls back to computerId when computerName is missing", () => {
    const normalized = normalizeImmyBotComputer({ computerId: "c-7" });
    expect(normalized.name).toBe("c-7");
  });

  it("preserves unknown fields in metadata", () => {
    const normalized = normalizeImmyBotComputer({
      computerId: "c-9",
      computerName: "Host",
      domain: "acme.local",
      lastSeenAt: "2026-04-25T00:00:00Z",
    });

    expect(normalized.metadata).toEqual({
      domain: "acme.local",
      lastSeenAt: "2026-04-25T00:00:00Z",
    });
  });
});
