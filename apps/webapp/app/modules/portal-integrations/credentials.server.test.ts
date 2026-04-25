// @vitest-environment node

import { rest } from "msw";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vitest,
} from "vitest";
import { server } from "~/../test/mocks";
import { ShelfError } from "~/utils/error";
import {
  __resetVendedCredentialsCacheForTest,
  getVendedCredentials,
  invalidateVendedCredentials,
} from "./credentials.server";

const PORTAL_URL = "https://portal.test";

let requestCount = 0;

function registerHandler(
  response: {
    status?: number;
    body?: unknown;
    bodyRaw?: string;
  } = {}
) {
  server.use(
    rest.get(
      `${PORTAL_URL}/api/v1/integrations/:slug/credentials`,
      (req, res, ctx) => {
        requestCount += 1;
        const status = response.status ?? 200;
        const handlers = [ctx.status(status)];
        if (response.bodyRaw !== undefined) {
          handlers.push(ctx.body(response.bodyRaw));
        } else if (response.body !== undefined) {
          handlers.push(ctx.json(response.body));
        }
        // Assert the bearer is forwarded exactly as provided.
        expect(req.headers.get("authorization")).toMatch(/^Bearer /);
        return res(...handlers);
      }
    )
  );
}

beforeAll(() => {
  // Keep the default JWKS handler from other test files out of scope;
  // this file does not exercise JWKS, but we must allow resetHandlers to
  // clean up between tests without re-registering anything.
});

beforeEach(() => {
  requestCount = 0;
  __resetVendedCredentialsCacheForTest();
});

afterEach(() => {
  server.resetHandlers();
  vitest.useRealTimers();
});

describe("getVendedCredentials (oauth2)", () => {
  it("returns the vended token on a 200 response", async () => {
    registerHandler({
      body: {
        credentials: {
          authMethod: "oauth2_token",
          baseUrl: "https://acme.immy.bot/api/v1",
          accessToken: "short-lived",
          expiresIn: 3600,
        },
      },
    });

    const creds = await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt-abc",
      tenantId: "tenant-1",
    });

    expect(creds.authMethod).toBe("oauth2_token");
    expect(creds.baseUrl).toBe("https://acme.immy.bot/api/v1");
    if (creds.authMethod === "oauth2_token") {
      expect(creds.accessToken).toBe("short-lived");
      expect(creds.expiresIn).toBe(3600);
    }
  });

  it("caches oauth2 tokens within their safety-adjusted TTL", async () => {
    registerHandler({
      body: {
        credentials: {
          authMethod: "oauth2_token",
          baseUrl: "https://acme.immy.bot/api/v1",
          accessToken: "short-lived",
          expiresIn: 3600,
        },
      },
    });

    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(requestCount).toBe(1);
  });

  it("caches per tenant — two tenants each trigger their own fetch", async () => {
    registerHandler({
      body: {
        credentials: {
          authMethod: "oauth2_token",
          baseUrl: "https://acme.immy.bot/api/v1",
          accessToken: "short-lived",
          expiresIn: 3600,
        },
      },
    });

    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-2",
    });

    expect(requestCount).toBe(2);
  });

  it("re-fetches once the cached token passes its safety-adjusted expiry", async () => {
    vitest.useFakeTimers();
    vitest.setSystemTime(new Date("2026-04-25T12:00:00Z"));

    registerHandler({
      body: {
        credentials: {
          authMethod: "oauth2_token",
          baseUrl: "https://acme.immy.bot/api/v1",
          accessToken: "short-lived",
          expiresIn: 60, // 60s - 60s safety = 0 TTL, so next call refetches.
        },
      },
    });

    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    vitest.setSystemTime(new Date("2026-04-25T12:00:01Z"));

    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(requestCount).toBe(2);
  });

  it("forceRefresh bypasses the cache", async () => {
    registerHandler({
      body: {
        credentials: {
          authMethod: "oauth2_token",
          baseUrl: "https://acme.immy.bot/api/v1",
          accessToken: "short-lived",
          expiresIn: 3600,
        },
      },
    });

    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-1",
      forceRefresh: true,
    });

    expect(requestCount).toBe(2);
  });

  it("invalidateVendedCredentials forces the next call to re-fetch", async () => {
    registerHandler({
      body: {
        credentials: {
          authMethod: "oauth2_token",
          baseUrl: "https://acme.immy.bot/api/v1",
          accessToken: "short-lived",
          expiresIn: 3600,
        },
      },
    });

    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    invalidateVendedCredentials({ slug: "immybot", tenantId: "tenant-1" });
    await getVendedCredentials({
      slug: "immybot",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(requestCount).toBe(2);
  });
});

describe("getVendedCredentials (api_key)", () => {
  it("returns raw API credentials without caching", async () => {
    registerHandler({
      body: {
        credentials: {
          authMethod: "api_key",
          baseUrl: "https://na.myconnectwise.net/v4_6_release/apis/3.0",
          apiCredentials: {
            companyId: "acme",
            clientId: "uuid",
            publicKey: "abc123",
            privateKey: "xyz789",
          },
        },
      },
    });

    const first = await getVendedCredentials({
      slug: "connectwise",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });
    const second = await getVendedCredentials({
      slug: "connectwise",
      portalToken: "jwt",
      tenantId: "tenant-1",
    });

    expect(first.authMethod).toBe("api_key");
    if (first.authMethod === "api_key") {
      expect(first.apiCredentials.privateKey).toBe("xyz789");
    }
    // api_key responses are NOT cached; each call hits the portal.
    expect(requestCount).toBe(2);
    expect(second.authMethod).toBe("api_key");
  });
});

describe("getVendedCredentials (error handling)", () => {
  it("maps each documented status to a typed ShelfError", async () => {
    const cases: Array<{ status: number; expected: RegExp }> = [
      { status: 400, expected: /does not support credential vending/ },
      { status: 401, expected: /rejected the module JWT/ },
      { status: 403, expected: /no tenant assigned/ },
      { status: 404, expected: /not found or not configured/ },
      { status: 502, expected: /could not exchange credentials/ },
    ];

    for (const { status, expected } of cases) {
      registerHandler({ status, body: {} });
      await expect(
        getVendedCredentials({
          slug: "immybot",
          portalToken: "jwt",
          tenantId: `tenant-${status}`,
        })
      ).rejects.toThrow(expected);
    }
  });

  it("surfaces the portal error message when one is present", async () => {
    registerHandler({
      status: 403,
      body: { error: "tenant not onboarded" },
    });
    await expect(
      getVendedCredentials({
        slug: "immybot",
        portalToken: "jwt",
        tenantId: "tenant-err",
      })
    ).rejects.toThrow(/tenant not onboarded/);
  });

  it("falls back to a generic message when the body is not JSON", async () => {
    registerHandler({ status: 500, bodyRaw: "internal" });
    await expect(
      getVendedCredentials({
        slug: "immybot",
        portalToken: "jwt",
        tenantId: "tenant-err",
      })
    ).rejects.toThrow(/Credential vending failed: 500/);
  });

  it("wraps network failures in a ShelfError", async () => {
    server.use(
      rest.get(
        `${PORTAL_URL}/api/v1/integrations/:slug/credentials`,
        (_req, res) => res.networkError("portal down")
      )
    );
    await expect(
      getVendedCredentials({
        slug: "immybot",
        portalToken: "jwt",
        tenantId: "tenant-net",
      })
    ).rejects.toThrow(ShelfError);
  });
});
