// @vitest-environment node

import { rest } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "~/../test/mocks";

const userFindUnique = vi.fn();
const userCreate = vi.fn();

// why: sync hits Prisma; mocking keeps it a unit test.
vi.mock("~/database/db.server", () => ({
  db: {
    user: { findUnique: userFindUnique, create: userCreate },
  },
}));

// why: silence info/error logs, verify errors are logged (not thrown).
vi.mock("~/utils/logger", () => ({
  Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const { syncEntraUsers } = await import("./sync.server");
const { __resetVendedCredentialsCacheForTest } = await import(
  "../credentials.server"
);

const PORTAL_URL = "https://portal.test";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function registerVending() {
  server.use(
    rest.get(
      `${PORTAL_URL}/api/v1/integrations/entra/credentials`,
      (_req, res, ctx) =>
        res(
          ctx.status(200),
          ctx.json({
            credentials: {
              authMethod: "oauth2_token",
              baseUrl: GRAPH_BASE,
              accessToken: "graph-token",
              expiresIn: 3600,
            },
          })
        )
    )
  );
}

function registerUsers(body: {
  value: Array<unknown>;
  "@odata.nextLink"?: string;
}) {
  server.use(
    rest.get(`${GRAPH_BASE}/users`, (_req, res, ctx) =>
      res(ctx.status(200), ctx.json(body))
    )
  );
}

beforeEach(() => {
  __resetVendedCredentialsCacheForTest();
  userFindUnique.mockReset();
  userCreate.mockReset();
  userCreate.mockResolvedValue({});
});

afterEach(() => {
  server.resetHandlers();
});

describe("syncEntraUsers", () => {
  it("creates Shelf users that don't yet exist by email", async () => {
    registerVending();
    registerUsers({
      value: [
        {
          id: "u-1",
          mail: "alice@acme.com",
          givenName: "Alice",
          surname: "Smith",
        },
        {
          id: "u-2",
          mail: "bob@acme.com",
          givenName: "Bob",
          surname: "Jones",
        },
      ],
    });
    userFindUnique
      .mockResolvedValueOnce(null) // alice doesn't exist
      .mockResolvedValueOnce({ id: "existing-bob" }); // bob already in Shelf

    const result = await syncEntraUsers({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(result).toEqual({
      fetched: 2,
      created: 1,
      existing: 1,
      skipped: 0,
      failed: 0,
    });
    expect(userCreate).toHaveBeenCalledTimes(1);
    expect(userCreate).toHaveBeenCalledWith({
      data: {
        email: "alice@acme.com",
        firstName: "Alice",
        lastName: "Smith",
      },
    });
  });

  it("skips Entra users with no usable email", async () => {
    registerVending();
    registerUsers({
      value: [
        { id: "u-1", mail: null, userPrincipalName: "" },
        { id: "u-2", userPrincipalName: "not-an-email" },
        {
          id: "u-3",
          userPrincipalName: "valid@acme.onmicrosoft.com",
        },
      ],
    });
    userFindUnique.mockResolvedValue(null);

    const result = await syncEntraUsers({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(result).toMatchObject({
      fetched: 3,
      skipped: 2,
      created: 1,
    });
    expect(userFindUnique).toHaveBeenCalledTimes(1);
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { email: "valid@acme.onmicrosoft.com" },
      select: { id: true },
    });
  });

  it("counts DB failures and keeps processing the rest", async () => {
    registerVending();
    registerUsers({
      value: [
        { id: "u-1", mail: "one@acme.com" },
        { id: "u-2", mail: "two@acme.com" },
      ],
    });
    userFindUnique
      .mockRejectedValueOnce(new Error("DB down"))
      .mockResolvedValueOnce(null);

    const result = await syncEntraUsers({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(result).toMatchObject({
      fetched: 2,
      failed: 1,
      created: 1,
    });
    expect(userCreate).toHaveBeenCalledTimes(1);
  });

  it("lowercases and trims emails before lookup", async () => {
    registerVending();
    registerUsers({
      value: [{ id: "u-1", mail: "  Jane@ACME.COM  " }],
    });
    userFindUnique.mockResolvedValue(null);

    await syncEntraUsers({ portalToken: "jwt", tenantId: "tenant-1" });

    expect(userFindUnique).toHaveBeenCalledWith({
      where: { email: "jane@acme.com" },
      select: { id: true },
    });
    expect(userCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: "jane@acme.com" }),
    });
  });
});
