// @vitest-environment node

import { rest } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "~/../test/mocks";

// why: the sync service upserts through Prisma; mocking keeps this a
// pure unit test and lets us assert on the exact Prisma arguments.
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

// why: the sync service emits log lines; silence to keep test output
// clean and to assert that errors are routed through the logger.
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { syncImmyBotDevices } = await import("./sync.server");
const { __resetVendedCredentialsCacheForTest } = await import(
  "../credentials.server"
);

const PORTAL_URL = "https://portal.test";
const IMMY_BASE = "https://acme.immy.bot/api/v1";

const ORG = "org-acme";
const USER = "user-42";

function registerVending() {
  server.use(
    rest.get(
      `${PORTAL_URL}/api/v1/integrations/immybot/credentials`,
      (_req, res, ctx) =>
        res(
          ctx.status(200),
          ctx.json({
            credentials: {
              authMethod: "oauth2_token",
              baseUrl: IMMY_BASE,
              accessToken: "immy-token",
              expiresIn: 3600,
            },
          })
        )
    )
  );
}

function registerComputers(pages: Array<Array<unknown>>) {
  server.use(
    rest.get(`${IMMY_BASE}/computers`, (req, res, ctx) => {
      const page = Number(req.url.searchParams.get("page") ?? "1");
      return res(ctx.status(200), ctx.json(pages[page - 1] ?? []));
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

describe("syncImmyBotDevices", () => {
  it("creates an Asset + ExternalAssetLink the first time a device is seen", async () => {
    registerVending();
    registerComputers([
      [
        {
          computerId: "c-1",
          computerName: "DESKTOP-ACME-01",
          serialNumber: "SN-1",
        },
      ],
      [],
    ]);
    linkFindUnique.mockResolvedValue(null);

    const result = await syncImmyBotDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
      organizationId: ORG,
      userId: USER,
    });

    expect(result).toEqual({
      fetched: 1,
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
    });
    expect(assetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "DESKTOP-ACME-01",
          userId: USER,
          organizationId: ORG,
        }),
      })
    );
    expect(linkCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: "new-asset",
          organizationId: ORG,
          goldenRecordId: "immybot:c-1",
          sourceName: "immybot",
          sourceRecordId: "c-1",
          syncStatus: "synced",
        }),
      })
    );
  });

  it("updates the Asset when unlocked fields have drifted", async () => {
    registerVending();
    registerComputers([
      [
        {
          computerId: "c-1",
          computerName: "RENAMED",
          serialNumber: "SN-2",
        },
      ],
      [],
    ]);
    linkFindUnique.mockResolvedValue({
      id: "link-1",
      assetId: "asset-1",
      lockedFields: [],
      asset: {
        id: "asset-1",
        title: "OLD-NAME",
        description: null,
      },
    });

    const result = await syncImmyBotDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
      organizationId: ORG,
      userId: USER,
    });

    expect(result.updated).toBe(1);
    expect(assetUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "asset-1" },
        data: expect.objectContaining({ title: "RENAMED" }),
      })
    );
    expect(linkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "link-1" },
        data: expect.objectContaining({ syncStatus: "synced" }),
      })
    );
  });

  it("honors lockedFields and does not overwrite user edits", async () => {
    registerVending();
    registerComputers([[{ computerId: "c-1", computerName: "RENAMED" }], []]);
    linkFindUnique.mockResolvedValue({
      id: "link-1",
      assetId: "asset-1",
      lockedFields: ["title"],
      asset: {
        id: "asset-1",
        title: "User-picked name",
        description: null,
      },
    });

    const result = await syncImmyBotDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
      organizationId: ORG,
      userId: USER,
    });

    // Title is locked => asset.update is NOT called for this device.
    expect(assetUpdate).not.toHaveBeenCalled();
    // But the ExternalAssetLink sync stamp still refreshes.
    expect(linkUpdate).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
  });

  it("counts devices whose upsert throws as failed and keeps going", async () => {
    registerVending();
    registerComputers([
      [
        { computerId: "c-1", computerName: "NAME-1" },
        { computerId: "c-2", computerName: "NAME-2" },
      ],
      [],
    ]);
    linkFindUnique
      .mockRejectedValueOnce(new Error("DB blip"))
      .mockResolvedValueOnce(null);

    const result = await syncImmyBotDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
      organizationId: ORG,
      userId: USER,
    });

    expect(result).toEqual({
      fetched: 2,
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 1,
    });
  });

  it("counts devices whose normalization throws as failed without hitting the DB", async () => {
    registerVending();
    registerComputers([
      [
        // Missing computerId => normalizeImmyBotComputer fails.
        { computerName: "broken" },
        { computerId: "c-ok", computerName: "ok" },
      ],
      [],
    ]);
    linkFindUnique.mockResolvedValue(null);

    const result = await syncImmyBotDevices({
      portalToken: "jwt",
      tenantId: "tenant-1",
      organizationId: ORG,
      userId: USER,
    });

    expect(result).toEqual({
      fetched: 2,
      created: 1,
      updated: 0,
      skipped: 0,
      failed: 1,
    });
    // DB call happens for the good device only.
    expect(linkFindUnique).toHaveBeenCalledTimes(1);
  });
});
