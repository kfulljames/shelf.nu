// @vitest-environment node

import { rest } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "~/../test/mocks";

const linkFindUnique = vi.fn();
const linkCreate = vi.fn();
const linkUpdate = vi.fn();
const assetCreate = vi.fn();
const assetUpdate = vi.fn();
const transactionMock = vi.fn((cb: (tx: unknown) => unknown) =>
  Promise.resolve(
    cb({
      asset: { create: assetCreate, update: assetUpdate },
      externalAssetLink: { create: linkCreate, update: linkUpdate },
    })
  )
);

// why: the sync service upserts through Prisma; mocking keeps this a
// unit test and lets us assert the exact Prisma arguments.
vi.mock("~/database/db.server", () => ({
  db: {
    externalAssetLink: {
      findUnique: linkFindUnique,
      create: linkCreate,
      update: linkUpdate,
    },
    asset: { create: assetCreate, update: assetUpdate },
    $transaction: transactionMock,
  },
}));

// why: silence structured logs and verify errors are routed through
// the logger rather than thrown up the call stack.
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { syncNinjaDevices } = await import("./sync.server");
const { __resetVendedCredentialsCacheForTest } = await import(
  "../credentials.server"
);

const PORTAL_URL = "https://portal.test";
const NINJA_BASE = "https://acme.rmmservice.com/api/v2";

const ORG = "org-acme";
const USER = "user-42";

function registerVending() {
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
              accessToken: "ninja-token",
              expiresIn: 3600,
            },
          })
        )
    )
  );
}

function registerDevicesCursor(pages: Array<Array<unknown>>) {
  server.use(
    rest.get(`${NINJA_BASE}/devices`, (req, res, ctx) => {
      const after = Number(req.url.searchParams.get("after") ?? "0");
      const index =
        after === 0
          ? 0
          : pages.findIndex((_p, i) => {
              const prev = pages[i - 1];
              if (!prev || prev.length === 0) return false;
              const prevLast = prev[prev.length - 1] as { id?: number };
              return prevLast?.id === after;
            });
      if (index < 0) return res(ctx.status(200), ctx.json([]));
      return res(ctx.status(200), ctx.json(pages[index]));
    })
  );
}

beforeEach(() => {
  __resetVendedCredentialsCacheForTest();
  linkFindUnique.mockReset();
  linkCreate.mockReset();
  linkUpdate.mockReset();
  assetCreate.mockReset();
  assetUpdate.mockReset();
  transactionMock.mockClear();
  assetCreate.mockResolvedValue({ id: "new-asset" });
});

afterEach(() => {
  server.resetHandlers();
});

describe("syncNinjaDevices", () => {
  it("creates an Asset + ExternalAssetLink on first sight", async () => {
    registerVending();
    registerDevicesCursor([[{ id: 1, displayName: "DEV-1" }], []]);
    linkFindUnique.mockResolvedValue(null);

    const result = await syncNinjaDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
      organizationId: ORG,
      userId: USER,
    });

    expect(result).toMatchObject({ fetched: 1, created: 1, failed: 0 });
    expect(assetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "DEV-1",
          userId: USER,
          organizationId: ORG,
        }),
      })
    );
    expect(linkCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          goldenRecordId: "ninja:1",
          sourceName: "ninja",
          sourceRecordId: "1",
        }),
      })
    );
  });

  it("updates drift but honors lockedFields", async () => {
    registerVending();
    registerDevicesCursor([[{ id: 1, displayName: "RENAMED" }], []]);
    linkFindUnique.mockResolvedValue({
      id: "link-1",
      assetId: "asset-1",
      lockedFields: ["title"],
      asset: { id: "asset-1", title: "User pick", description: null },
    });

    const result = await syncNinjaDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
      organizationId: ORG,
      userId: USER,
    });

    // Title locked => asset.update not called, skipped counter bumps.
    expect(assetUpdate).not.toHaveBeenCalled();
    expect(linkUpdate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      fetched: 1,
      created: 0,
      updated: 0,
      skipped: 1,
    });
  });

  it("counts normalization failures without a DB call", async () => {
    registerVending();
    server.use(
      rest.get(`${NINJA_BASE}/devices`, (req, res, ctx) => {
        const after = Number(req.url.searchParams.get("after") ?? "0");
        if (after === 0) {
          return res(
            ctx.status(200),
            ctx.json([
              // Missing id triggers normalizeNinjaDevice to throw.
              { displayName: "broken" },
              { id: 2, displayName: "ok" },
            ])
          );
        }
        return res(ctx.status(200), ctx.json([]));
      })
    );
    linkFindUnique.mockResolvedValue(null);

    const result = await syncNinjaDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
      organizationId: ORG,
      userId: USER,
    });

    expect(result).toMatchObject({
      fetched: 2,
      created: 1,
      failed: 1,
    });
    // DB call happens for the good device only.
    expect(linkFindUnique).toHaveBeenCalledTimes(1);
  });

  it("counts upsert failures and keeps going", async () => {
    registerVending();
    server.use(
      rest.get(`${NINJA_BASE}/devices`, (req, res, ctx) => {
        const after = Number(req.url.searchParams.get("after") ?? "0");
        if (after === 0) {
          return res(
            ctx.status(200),
            ctx.json([
              { id: 1, displayName: "D1" },
              { id: 2, displayName: "D2" },
            ])
          );
        }
        return res(ctx.status(200), ctx.json([]));
      })
    );
    linkFindUnique
      .mockRejectedValueOnce(new Error("DB blip"))
      .mockResolvedValueOnce(null);

    const result = await syncNinjaDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
      organizationId: ORG,
      userId: USER,
    });

    expect(result).toMatchObject({
      fetched: 2,
      created: 1,
      failed: 1,
    });
  });
});
