// @vitest-environment node

import { rest } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "~/../test/mocks";
import { ShelfError } from "~/utils/error";
import { __resetVendedCredentialsCacheForTest } from "../credentials.server";
import {
  listAllDevices,
  listDevices,
  normalizeNinjaDevice,
} from "./client.server";

const PORTAL_URL = "https://portal.test";
const NINJA_BASE = "https://acme.rmmservice.com/api/v2";

function registerVending(overrides?: { accessToken?: string }) {
  server.use(
    rest.get(
      `${PORTAL_URL}/api/v1/integrations/ninja/credentials`,
      (_req, res, ctx) =>
        res(
          ctx.status(200),
          ctx.json({
            credentials: {
              authMethod: "oauth2_token",
              baseUrl: NINJA_BASE,
              accessToken: overrides?.accessToken ?? "ninja-token",
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

describe("listDevices", () => {
  it("sends bearer auth and returns the parsed devices", async () => {
    registerVending();
    server.use(
      rest.get(`${NINJA_BASE}/devices`, (req, res, ctx) => {
        expect(req.headers.get("authorization")).toBe("Bearer ninja-token");
        return res(
          ctx.status(200),
          ctx.json([
            { id: 1, displayName: "DEV-1" },
            { id: 2, displayName: "DEV-2" },
          ])
        );
      })
    );
    const devices = await listDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    expect(devices).toHaveLength(2);
  });

  it("wraps non-2xx in ShelfError", async () => {
    registerVending();
    server.use(
      rest.get(`${NINJA_BASE}/devices`, (_req, res, ctx) =>
        res(ctx.status(500), ctx.json({ error: "boom" }))
      )
    );
    await expect(
      listDevices({ portalToken: "jwt", tenantId: "tenant-1" })
    ).rejects.toThrow(ShelfError);
  });

  it("rejects non-oauth2 credentials", async () => {
    server.use(
      rest.get(
        `${PORTAL_URL}/api/v1/integrations/ninja/credentials`,
        (_req, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              credentials: {
                authMethod: "api_key",
                baseUrl: NINJA_BASE,
                apiCredentials: {},
              },
            })
          )
      )
    );
    await expect(
      listDevices({ portalToken: "jwt", tenantId: "tenant-1" })
    ).rejects.toThrow(/Expected oauth2_token/);
  });

  it("retries once with a fresh token on 401", async () => {
    let vendCalls = 0;
    server.use(
      rest.get(
        `${PORTAL_URL}/api/v1/integrations/ninja/credentials`,
        (_req, res, ctx) => {
          vendCalls += 1;
          return res(
            ctx.status(200),
            ctx.json({
              credentials: {
                authMethod: "oauth2_token",
                baseUrl: NINJA_BASE,
                accessToken: vendCalls === 1 ? "stale" : "fresh",
                expiresIn: 3600,
              },
            })
          );
        }
      )
    );
    server.use(
      rest.get(`${NINJA_BASE}/devices`, (req, res, ctx) => {
        if (req.headers.get("authorization") === "Bearer stale") {
          return res(ctx.status(401));
        }
        return res(ctx.status(200), ctx.json([{ id: 1 }]));
      })
    );
    const devices = await listDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    expect(vendCalls).toBe(2);
    expect(devices[0].id).toBe(1);
  });
});

describe("listAllDevices", () => {
  it("walks forward using the last id as the `after` cursor", async () => {
    registerVending();
    const seenCursors: Array<string | null> = [];
    server.use(
      rest.get(`${NINJA_BASE}/devices`, (req, res, ctx) => {
        seenCursors.push(req.url.searchParams.get("after"));
        const after = Number(req.url.searchParams.get("after") ?? "0");
        if (after === 0) {
          return res(
            ctx.status(200),
            ctx.json(Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })))
          );
        }
        if (after === 100) {
          // Short page => end.
          return res(ctx.status(200), ctx.json([{ id: 101 }]));
        }
        return res(ctx.status(200), ctx.json([]));
      })
    );
    const devices = await listAllDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    expect(devices).toHaveLength(101);
    expect(seenCursors).toEqual([null, "100"]);
  });

  it("respects maxPages even when the vendor keeps returning full pages", async () => {
    registerVending();
    server.use(
      rest.get(`${NINJA_BASE}/devices`, (req, res, ctx) => {
        const after = Number(req.url.searchParams.get("after") ?? "0");
        return res(
          ctx.status(200),
          ctx.json([{ id: after + 1 }, { id: after + 2 }])
        );
      })
    );
    const devices = await listAllDevices(
      { portalToken: "jwt", tenantId: "tenant-1" },
      { pageSize: 2, maxPages: 3 }
    );
    expect(devices).toHaveLength(6);
  });
});

describe("normalizeNinjaDevice", () => {
  it("prefers displayName, then systemName, then dnsName, then id", () => {
    expect(
      normalizeNinjaDevice({ id: 1, displayName: "A", systemName: "B" }).name
    ).toBe("A");
    expect(
      normalizeNinjaDevice({ id: 1, systemName: "B", dnsName: "C" }).name
    ).toBe("B");
    expect(normalizeNinjaDevice({ id: 1, dnsName: "C" }).name).toBe("C");
    expect(normalizeNinjaDevice({ id: 7 }).name).toBe("7");
  });

  it("throws when id is missing", () => {
    expect(() =>
      normalizeNinjaDevice({ displayName: "x" } as unknown as never)
    ).toThrow(/id is required/);
  });

  it("flattens nested system and os into canonical slots", () => {
    const normalized = normalizeNinjaDevice({
      id: 1,
      displayName: "DEV-1",
      serialNumber: "SN-1",
      system: { manufacturer: "Dell", model: "Latitude" },
      os: { name: "Windows 11", version: "22H2" },
    });
    expect(normalized.manufacturer).toBe("Dell");
    expect(normalized.model).toBe("Latitude");
    expect(normalized.operatingSystem).toBe("Windows 11 22H2");
    expect(normalized.serialNumber).toBe("SN-1");
  });

  it("collects NIC MAC addresses and preserves unknown fields in metadata", () => {
    const normalized = normalizeNinjaDevice({
      id: 1,
      displayName: "DEV",
      nics: [{ mac: "00:00:00:00:00:01" }, { mac: " 00:00:00:00:00:02 " }, {}],
      organizationId: 42,
      lastContact: "2026-04-25T00:00:00Z",
    });
    expect(normalized.macAddresses).toEqual([
      "00:00:00:00:00:01",
      "00:00:00:00:00:02",
    ]);
    expect(normalized.metadata).toEqual({
      organizationId: 42,
      lastContact: "2026-04-25T00:00:00Z",
    });
  });

  it("converts the numeric id into a string for sourceRecordId", () => {
    expect(normalizeNinjaDevice({ id: 99 }).sourceRecordId).toBe("99");
  });
});
