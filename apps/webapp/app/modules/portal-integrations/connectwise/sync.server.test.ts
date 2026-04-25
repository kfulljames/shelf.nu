// @vitest-environment node

import { rest } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "~/../test/mocks";

const findManyMock = vi.fn();
const updateMock = vi.fn();

// why: sync service upserts into Prisma; mocking the client keeps the
// test in pure unit-test territory without a live database.
vi.mock("~/database/db.server", () => ({
  db: {
    organization: {
      findMany: findManyMock,
      update: updateMock,
    },
  },
}));

// why: the sync service emits structured log lines; suppressing keeps
// test output clean and lets us assert on side-effects explicitly.
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { syncAllCompanies, syncCompanyForOrganization } = await import(
  "./sync.server"
);
const { __resetVendedCredentialsCacheForTest } = await import(
  "../credentials.server"
);

const PORTAL_URL = "https://portal.test";
const CW_BASE = "https://acme.myconnectwise.net/v4_6_release/apis/3.0";

function registerVending() {
  server.use(
    rest.get(
      `${PORTAL_URL}/api/v1/integrations/connectwise/credentials`,
      (_req, res, ctx) =>
        res(
          ctx.status(200),
          ctx.json({
            credentials: {
              authMethod: "api_key",
              baseUrl: CW_BASE,
              apiCredentials: {
                companyId: "acme",
                publicKey: "pub",
                privateKey: "priv",
                clientId: "client-uuid",
              },
            },
          })
        )
    )
  );
}

function registerCompanies(pages: Array<Array<unknown>>) {
  server.use(
    rest.get(`${CW_BASE}/company/companies`, (req, res, ctx) => {
      const page = Number(req.url.searchParams.get("page") ?? "1");
      const body = pages[page - 1] ?? [];
      return res(ctx.status(200), ctx.json(body));
    })
  );
}

beforeEach(() => {
  __resetVendedCredentialsCacheForTest();
  findManyMock.mockReset();
  updateMock.mockReset();
});

afterEach(() => {
  server.resetHandlers();
});

describe("syncAllCompanies", () => {
  it("matches orgs to CW companies by identifier and updates only changed names", async () => {
    registerVending();
    registerCompanies([
      [
        { id: 1, identifier: "acme", name: "Acme Updated" },
        { id: 2, identifier: "beta", name: "Beta Co" },
        { id: 3, identifier: "gamma", name: "Gamma Inc." },
      ],
      [],
    ]);

    findManyMock.mockResolvedValueOnce([
      {
        id: "org-1",
        name: "Acme Corp",
        portalTenantId: "tenant-1",
        portalTenantSlug: "acme",
      },
      {
        id: "org-2",
        name: "Beta Co",
        portalTenantId: "tenant-2",
        portalTenantSlug: "beta",
      }, // already matches — should be skipped
      {
        id: "org-3",
        name: "Gamma",
        portalTenantId: "tenant-3",
        portalTenantSlug: "delta",
      }, // slug doesn't exist in CW — unmatched
      {
        id: "org-4",
        name: "Unlinked",
        portalTenantId: "tenant-4",
        portalTenantSlug: null,
      }, // no slug — skipped
    ]);

    const result = await syncAllCompanies({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(result).toEqual({
      fetched: 3,
      updated: 1,
      unmatched: 1,
      skipped: 2,
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { name: "Acme Updated" },
    });
  });

  it("skips CW companies flagged as deleted", async () => {
    registerVending();
    registerCompanies([
      [
        {
          id: 1,
          identifier: "acme",
          name: "Acme Renamed",
          deletedFlag: true,
        },
      ],
      [],
    ]);
    findManyMock.mockResolvedValueOnce([
      {
        id: "org-1",
        name: "Acme",
        portalTenantId: "tenant-1",
        portalTenantSlug: "acme",
      },
    ]);

    const result = await syncAllCompanies({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(result.updated).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("matches identifiers case-insensitively", async () => {
    registerVending();
    registerCompanies([
      [{ id: 1, identifier: "ACME", name: "Acme Updated" }],
      [],
    ]);
    findManyMock.mockResolvedValueOnce([
      {
        id: "org-1",
        name: "Acme",
        portalTenantId: "tenant-1",
        portalTenantSlug: "acme",
      },
    ]);

    const result = await syncAllCompanies({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    expect(result.updated).toBe(1);
  });

  it("logs and continues when a single org update fails", async () => {
    registerVending();
    registerCompanies([
      [
        { id: 1, identifier: "acme", name: "Acme Updated" },
        { id: 2, identifier: "beta", name: "Beta Updated" },
      ],
      [],
    ]);
    findManyMock.mockResolvedValueOnce([
      {
        id: "org-1",
        name: "Acme",
        portalTenantId: "t1",
        portalTenantSlug: "acme",
      },
      {
        id: "org-2",
        name: "Beta",
        portalTenantId: "t2",
        portalTenantSlug: "beta",
      },
    ]);
    updateMock
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({});

    const result = await syncAllCompanies({
      portalToken: "jwt",
      tenantId: "t1",
    });

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(result.updated).toBe(1);
  });
});

describe("syncCompanyForOrganization", () => {
  it("returns the matched identifier and applies an update", async () => {
    registerVending();
    registerCompanies([
      [{ id: 1, identifier: "acme", name: "Acme Updated" }],
      [],
    ]);

    const matched = await syncCompanyForOrganization(
      { portalToken: "jwt", tenantId: "t1" },
      {
        id: "org-1",
        name: "Acme",
        portalTenantId: "t1",
        portalTenantSlug: "acme",
      }
    );

    expect(matched).toBe("acme");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { name: "Acme Updated" },
    });
  });

  it("returns null when the org has no portalTenantSlug", async () => {
    const matched = await syncCompanyForOrganization(
      { portalToken: "jwt", tenantId: "t1" },
      {
        id: "org-1",
        name: "Acme",
        portalTenantId: "t1",
        portalTenantSlug: null,
      }
    );
    expect(matched).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns null when no CW company has the same identifier", async () => {
    registerVending();
    registerCompanies([[{ id: 1, identifier: "other", name: "Other Co" }], []]);

    const matched = await syncCompanyForOrganization(
      { portalToken: "jwt", tenantId: "t1" },
      {
        id: "org-1",
        name: "Acme",
        portalTenantId: "t1",
        portalTenantSlug: "acme",
      }
    );

    expect(matched).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns the identifier without updating when the name already matches", async () => {
    registerVending();
    registerCompanies([[{ id: 1, identifier: "acme", name: "Acme" }], []]);

    const matched = await syncCompanyForOrganization(
      { portalToken: "jwt", tenantId: "t1" },
      {
        id: "org-1",
        name: "Acme",
        portalTenantId: "t1",
        portalTenantSlug: "acme",
      }
    );

    expect(matched).toBe("acme");
    expect(updateMock).not.toHaveBeenCalled();
  });
});
