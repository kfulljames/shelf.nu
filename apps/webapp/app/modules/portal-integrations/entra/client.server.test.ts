// @vitest-environment node

import { rest } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "~/../test/mocks";
import { ShelfError } from "~/utils/error";
import { __resetVendedCredentialsCacheForTest } from "../credentials.server";
import {
  listAllUsers,
  listUsersPage,
  normalizeEntraUser,
} from "./client.server";

const PORTAL_URL = "https://portal.test";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function registerVending(overrides?: { accessToken?: string }) {
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
              accessToken: overrides?.accessToken ?? "graph-token",
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

describe("listUsersPage", () => {
  it("returns the Graph response verbatim on success", async () => {
    registerVending();
    server.use(
      rest.get(`${GRAPH_BASE}/users`, (req, res, ctx) => {
        expect(req.headers.get("authorization")).toBe("Bearer graph-token");
        return res(
          ctx.status(200),
          ctx.json({
            value: [{ id: "u-1", userPrincipalName: "a@acme.com" }],
            "@odata.nextLink": `${GRAPH_BASE}/users?$skiptoken=xyz`,
          })
        );
      })
    );

    const page = await listUsersPage({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    expect(page.value).toHaveLength(1);
    expect(page["@odata.nextLink"]).toContain("skiptoken");
  });

  it("forwards $top when a pageSize is supplied", async () => {
    registerVending();
    server.use(
      rest.get(`${GRAPH_BASE}/users`, (req, res, ctx) => {
        expect(req.url.searchParams.get("$top")).toBe("25");
        return res(ctx.status(200), ctx.json({ value: [] }));
      })
    );
    await listUsersPage(
      { portalToken: "jwt", tenantId: "tenant-1" },
      { pageSize: 25 }
    );
  });

  it("fetches directly from the absolute @odata.nextLink when given", async () => {
    registerVending();
    const nextLink = `${GRAPH_BASE}/users?$skiptoken=xyz`;
    server.use(
      rest.get(`${GRAPH_BASE}/users`, (req, res, ctx) => {
        expect(req.url.searchParams.get("$skiptoken")).toBe("xyz");
        return res(
          ctx.status(200),
          ctx.json({ value: [{ id: "u-2", userPrincipalName: "b@acme.com" }] })
        );
      })
    );
    const page = await listUsersPage(
      { portalToken: "jwt", tenantId: "tenant-1" },
      { nextLink }
    );
    expect(page.value[0].id).toBe("u-2");
  });

  it("wraps non-2xx in ShelfError", async () => {
    registerVending();
    server.use(
      rest.get(`${GRAPH_BASE}/users`, (_req, res, ctx) =>
        res(ctx.status(500), ctx.json({ error: { message: "boom" } }))
      )
    );
    await expect(
      listUsersPage({ portalToken: "jwt", tenantId: "tenant-1" })
    ).rejects.toThrow(ShelfError);
  });

  it("rejects non-oauth2 credentials", async () => {
    server.use(
      rest.get(
        `${PORTAL_URL}/api/v1/integrations/entra/credentials`,
        (_req, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              credentials: {
                authMethod: "api_key",
                baseUrl: GRAPH_BASE,
                apiCredentials: {},
              },
            })
          )
      )
    );
    await expect(
      listUsersPage({ portalToken: "jwt", tenantId: "tenant-1" })
    ).rejects.toThrow(/Expected oauth2_token/);
  });

  it("retries once with a fresh token on 401", async () => {
    let vendCalls = 0;
    server.use(
      rest.get(
        `${PORTAL_URL}/api/v1/integrations/entra/credentials`,
        (_req, res, ctx) => {
          vendCalls += 1;
          return res(
            ctx.status(200),
            ctx.json({
              credentials: {
                authMethod: "oauth2_token",
                baseUrl: GRAPH_BASE,
                accessToken: vendCalls === 1 ? "stale" : "fresh",
                expiresIn: 3600,
              },
            })
          );
        }
      )
    );
    server.use(
      rest.get(`${GRAPH_BASE}/users`, (req, res, ctx) => {
        if (req.headers.get("authorization") === "Bearer stale") {
          return res(ctx.status(401));
        }
        return res(ctx.status(200), ctx.json({ value: [{ id: "ok" }] }));
      })
    );
    const page = await listUsersPage({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    expect(vendCalls).toBeGreaterThanOrEqual(2);
    expect(page.value[0].id).toBe("ok");
  });
});

describe("listAllUsers", () => {
  it("follows @odata.nextLink across pages until it's absent", async () => {
    registerVending();
    let seenNext = false;
    server.use(
      rest.get(`${GRAPH_BASE}/users`, (req, res, ctx) => {
        if (req.url.searchParams.get("$skiptoken") === "p2") {
          seenNext = true;
          return res(
            ctx.status(200),
            ctx.json({ value: [{ id: "u-3" }, { id: "u-4" }] })
          );
        }
        return res(
          ctx.status(200),
          ctx.json({
            value: [{ id: "u-1" }, { id: "u-2" }],
            "@odata.nextLink": `${GRAPH_BASE}/users?$skiptoken=p2`,
          })
        );
      })
    );

    const users = await listAllUsers({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(seenNext).toBe(true);
    expect(users.map((u) => u.id)).toEqual(["u-1", "u-2", "u-3", "u-4"]);
  });

  it("respects maxPages", async () => {
    registerVending();
    server.use(
      rest.get(`${GRAPH_BASE}/users`, (_req, res, ctx) =>
        res(
          ctx.status(200),
          ctx.json({
            value: [{ id: "u-x" }],
            "@odata.nextLink": `${GRAPH_BASE}/users?$skiptoken=loop`,
          })
        )
      )
    );
    const users = await listAllUsers(
      { portalToken: "jwt", tenantId: "tenant-1" },
      { maxPages: 3 }
    );
    expect(users).toHaveLength(3);
  });
});

describe("normalizeEntraUser", () => {
  it("uses `mail` when present, lowercased and trimmed", () => {
    expect(
      normalizeEntraUser({
        id: "u-1",
        mail: "  Jane.Doe@Acme.Com ",
        userPrincipalName: "jdoe@acme.onmicrosoft.com",
        givenName: "Jane",
        surname: "Doe",
      })
    ).toEqual({
      entraObjectId: "u-1",
      email: "jane.doe@acme.com",
      firstName: "Jane",
      lastName: "Doe",
      accountEnabled: true,
    });
  });

  it("falls back to userPrincipalName when `mail` is null", () => {
    const normalized = normalizeEntraUser({
      id: "u-2",
      mail: null,
      userPrincipalName: "JDoe@acme.onmicrosoft.com",
    });
    expect(normalized?.email).toBe("jdoe@acme.onmicrosoft.com");
  });

  it("returns null when no usable email is available", () => {
    expect(
      normalizeEntraUser({ id: "u-3", mail: null, userPrincipalName: "" })
    ).toBeNull();
    expect(
      normalizeEntraUser({ id: "u-4", userPrincipalName: "not-an-email" })
    ).toBeNull();
  });

  it("reads accountEnabled when set, defaulting to true", () => {
    expect(
      normalizeEntraUser({
        id: "u-5",
        mail: "a@b.com",
        accountEnabled: false,
      })?.accountEnabled
    ).toBe(false);
    expect(
      normalizeEntraUser({ id: "u-6", mail: "a@b.com" })?.accountEnabled
    ).toBe(true);
  });
});
