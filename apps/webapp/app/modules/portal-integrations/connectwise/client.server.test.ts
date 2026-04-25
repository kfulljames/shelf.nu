// @vitest-environment node

import { rest } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "~/../test/mocks";
import { ShelfError } from "~/utils/error";
import { __resetVendedCredentialsCacheForTest } from "../credentials.server";
import { getCompany, listAllCompanies, listCompanies } from "./client.server";

const PORTAL_URL = "https://portal.test";
const CW_BASE = "https://acme.myconnectwise.net/v4_6_release/apis/3.0";

const API_CREDENTIALS = {
  companyId: "acme",
  publicKey: "pub",
  privateKey: "priv",
  clientId: "client-uuid",
};

function expectedBasicAuth(): string {
  return "Basic " + Buffer.from("acme+pub:priv").toString("base64");
}

function registerVending(
  overrides: { status?: number; credentials?: unknown } = {}
) {
  server.use(
    rest.get(
      `${PORTAL_URL}/api/v1/integrations/connectwise/credentials`,
      (_req, res, ctx) =>
        res(
          ctx.status(overrides.status ?? 200),
          ctx.json({
            credentials: overrides.credentials ?? {
              authMethod: "api_key",
              baseUrl: CW_BASE,
              apiCredentials: API_CREDENTIALS,
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

describe("listCompanies", () => {
  it("sends Basic auth + clientId header and returns the parsed page", async () => {
    registerVending();
    server.use(
      rest.get(`${CW_BASE}/company/companies`, (req, res, ctx) => {
        expect(req.headers.get("authorization")).toBe(expectedBasicAuth());
        expect(req.headers.get("clientid")).toBe("client-uuid");
        expect(req.url.searchParams.get("page")).toBe("1");
        expect(req.url.searchParams.get("pageSize")).toBe("50");
        return res(
          ctx.status(200),
          ctx.json([{ id: 1, identifier: "acme-co", name: "Acme Co" }])
        );
      })
    );

    const companies = await listCompanies(
      { portalToken: "jwt", tenantId: "tenant-1" },
      { page: 1, pageSize: 50 }
    );

    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({ id: 1, name: "Acme Co" });
  });

  it("forwards the conditions query param when supplied", async () => {
    registerVending();
    server.use(
      rest.get(`${CW_BASE}/company/companies`, (req, res, ctx) => {
        expect(req.url.searchParams.get("conditions")).toBe(
          'status/name="Active"'
        );
        return res(ctx.status(200), ctx.json([]));
      })
    );

    await listCompanies(
      { portalToken: "jwt", tenantId: "tenant-1" },
      { conditions: 'status/name="Active"' }
    );
  });

  it("throws a ShelfError when ConnectWise returns a non-2xx", async () => {
    registerVending();
    server.use(
      rest.get(`${CW_BASE}/company/companies`, (_req, res, ctx) =>
        res(ctx.status(500), ctx.json({ code: "Error", message: "boom" }))
      )
    );

    await expect(
      listCompanies({ portalToken: "jwt", tenantId: "tenant-1" })
    ).rejects.toThrow(ShelfError);
  });

  it("rejects when the vended credentials are missing required fields", async () => {
    registerVending({
      credentials: {
        authMethod: "api_key",
        baseUrl: CW_BASE,
        apiCredentials: { companyId: "acme" }, // missing keys
      },
    });

    await expect(
      listCompanies({ portalToken: "jwt", tenantId: "tenant-1" })
    ).rejects.toThrow(/missing required field/);
  });

  it("rejects when the portal returns the wrong auth method", async () => {
    registerVending({
      credentials: {
        authMethod: "oauth2_token",
        baseUrl: CW_BASE,
        accessToken: "nope",
        expiresIn: 3600,
      },
    });

    await expect(
      listCompanies({ portalToken: "jwt", tenantId: "tenant-1" })
    ).rejects.toThrow(/Expected api_key credentials/);
  });
});

describe("listCompanies 401 retry", () => {
  it("invalidates the vended credentials cache and retries once on 401", async () => {
    let vendCalls = 0;
    let apiCalls = 0;

    server.use(
      rest.get(
        `${PORTAL_URL}/api/v1/integrations/connectwise/credentials`,
        (_req, res, ctx) => {
          vendCalls += 1;
          return res(
            ctx.status(200),
            ctx.json({
              credentials: {
                authMethod: "api_key",
                baseUrl: CW_BASE,
                apiCredentials: {
                  ...API_CREDENTIALS,
                  // Rotate the key between vendings so the assertion
                  // proves the retry used the refreshed credentials.
                  privateKey: vendCalls === 1 ? "priv-stale" : "priv-fresh",
                },
              },
            })
          );
        }
      )
    );

    server.use(
      rest.get(`${CW_BASE}/company/companies`, (req, res, ctx) => {
        apiCalls += 1;
        const auth = req.headers.get("authorization") ?? "";
        if (
          auth.includes(Buffer.from("acme+pub:priv-stale").toString("base64"))
        ) {
          return res(ctx.status(401), ctx.json({ message: "expired" }));
        }
        return res(ctx.status(200), ctx.json([{ id: 1, name: "Acme" }]));
      })
    );

    const companies = await listCompanies({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(vendCalls).toBe(2);
    expect(apiCalls).toBe(2);
    expect(companies).toHaveLength(1);
  });
});

describe("listAllCompanies", () => {
  it("walks pages until an empty (or short) page is returned", async () => {
    registerVending();
    server.use(
      rest.get(`${CW_BASE}/company/companies`, (req, res, ctx) => {
        const page = Number(req.url.searchParams.get("page"));
        if (page === 1) {
          return res(
            ctx.status(200),
            ctx.json(
              Array.from({ length: 100 }, (_, i) => ({
                id: i + 1,
                identifier: `co-${i + 1}`,
                name: `Company ${i + 1}`,
              }))
            )
          );
        }
        if (page === 2) {
          // Short page — signals the last batch.
          return res(
            ctx.status(200),
            ctx.json([{ id: 101, identifier: "co-101", name: "Company 101" }])
          );
        }
        return res(ctx.status(200), ctx.json([]));
      })
    );

    const companies = await listAllCompanies({
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(companies).toHaveLength(101);
    expect(companies[0].id).toBe(1);
    expect(companies[100].id).toBe(101);
  });

  it("stops at maxPages even if the vendor keeps returning full pages", async () => {
    registerVending();
    server.use(
      rest.get(`${CW_BASE}/company/companies`, (req, res, ctx) => {
        const page = Number(req.url.searchParams.get("page"));
        // Always return a full page of 2 items — would loop forever
        // without the maxPages guard.
        return res(
          ctx.status(200),
          ctx.json([
            { id: page * 10, identifier: `p${page}-a`, name: `P${page}A` },
            { id: page * 10 + 1, identifier: `p${page}-b`, name: `P${page}B` },
          ])
        );
      })
    );

    const companies = await listAllCompanies(
      { portalToken: "jwt", tenantId: "tenant-1" },
      { pageSize: 2, maxPages: 3 }
    );

    expect(companies).toHaveLength(6);
  });
});

describe("getCompany", () => {
  it("fetches a single company by id", async () => {
    registerVending();
    server.use(
      rest.get(`${CW_BASE}/company/companies/42`, (_req, res, ctx) =>
        res(
          ctx.status(200),
          ctx.json({ id: 42, identifier: "acme", name: "Acme" })
        )
      )
    );

    const company = await getCompany(
      { portalToken: "jwt", tenantId: "tenant-1" },
      42
    );
    expect(company.name).toBe("Acme");
  });

  it("throws when the company is not found", async () => {
    registerVending();
    server.use(
      rest.get(`${CW_BASE}/company/companies/999`, (_req, res, ctx) =>
        res(ctx.status(404), ctx.json({ message: "not found" }))
      )
    );

    await expect(
      getCompany({ portalToken: "jwt", tenantId: "tenant-1" }, 999)
    ).rejects.toThrow(/getCompany failed: 404/);
  });
});
