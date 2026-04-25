// @vitest-environment node

import * as jose from "jose";
import { rest } from "msw";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { server } from "~/../test/mocks";
import { ShelfError } from "~/utils/error";
import {
  exchangeAuthCode,
  fetchTenantInfo,
  verifyPortalToken,
} from "./portal-auth.server";

const PORTAL_URL = "https://portal.test";
const SERVER_URL = "http://localhost:3000";

// A single key pair is used for every JWT in this file. The portal-auth
// module caches the JWKS client at module scope, so all tests must sign
// with the same key.
let privateKey: jose.CryptoKey;
let publicJwk: jose.JWK;
const KID = "test-key-1";

async function signToken(
  claims: Record<string, unknown>,
  options?: { expiresIn?: string | number }
): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer("msp-portal")
    .setExpirationTime(options?.expiresIn ?? "1h")
    .sign(privateKey);
}

beforeAll(async () => {
  const { publicKey, privateKey: pk } = await jose.generateKeyPair("RS256", {
    extractable: true,
  });
  privateKey = pk;
  publicJwk = { ...(await jose.exportJWK(publicKey)), kid: KID, alg: "RS256" };

  // Default JWKS handler — served for the life of the test file.
  // Per-test handlers can override other endpoints via server.use().
  server.use(
    rest.get(`${PORTAL_URL}/.well-known/jwks.json`, (_req, res, ctx) =>
      res(ctx.status(200), ctx.json({ keys: [publicJwk] }))
    )
  );
});

afterEach(() => {
  // Reset any per-test handlers; the default JWKS handler is re-added
  // by beforeAll. We re-register it here because resetHandlers clears
  // runtime handlers set via server.use().
  server.resetHandlers(
    rest.get(`${PORTAL_URL}/.well-known/jwks.json`, (_req, res, ctx) =>
      res(ctx.status(200), ctx.json({ keys: [publicJwk] }))
    )
  );
});

describe("verifyPortalToken", () => {
  it("accepts a valid module-scoped token with a matching audience", async () => {
    const token = await signToken({
      sub: "user-1",
      tokenType: "module_scoped",
      aud: SERVER_URL,
      moduleSlug: "shelf",
    });

    const claims = await verifyPortalToken(token);
    expect(claims.sub).toBe("user-1");
    expect(claims.tokenType).toBe("module_scoped");
  });

  it("accepts a token without an explicit audience claim", async () => {
    const token = await signToken({
      sub: "user-2",
      tokenType: "module_scoped",
    });

    const claims = await verifyPortalToken(token);
    expect(claims.sub).toBe("user-2");
  });

  it("accepts tokens whose audience is an array containing SERVER_URL", async () => {
    const token = await signToken({
      sub: "user-3",
      tokenType: "module_scoped",
      aud: [SERVER_URL, "https://other.example"],
    });

    const claims = await verifyPortalToken(token);
    expect(claims.sub).toBe("user-3");
  });

  it("rejects tokens that are not module_scoped", async () => {
    const token = await signToken({
      sub: "user-4",
      tokenType: "access_token",
    });

    await expect(verifyPortalToken(token)).rejects.toThrow(ShelfError);
    await expect(verifyPortalToken(token)).rejects.toThrow(
      /Failed to verify portal token/
    );
  });

  it("rejects tokens with an audience that does not match SERVER_URL", async () => {
    const token = await signToken({
      sub: "user-5",
      tokenType: "module_scoped",
      aud: "https://somewhere-else.example",
    });

    await expect(verifyPortalToken(token)).rejects.toThrow(ShelfError);
  });

  it("rejects tokens with the wrong issuer", async () => {
    const token = await new jose.SignJWT({
      sub: "user-6",
      tokenType: "module_scoped",
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer("not-the-portal")
      .setExpirationTime("1h")
      .sign(privateKey);

    await expect(verifyPortalToken(token)).rejects.toThrow(ShelfError);
  });

  it("rejects expired tokens", async () => {
    const token = await new jose.SignJWT({
      sub: "user-7",
      tokenType: "module_scoped",
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setIssuer("msp-portal")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    await expect(verifyPortalToken(token)).rejects.toThrow(ShelfError);
  });
});

describe("exchangeAuthCode", () => {
  it("returns the token and expiresIn when the portal responds 200", async () => {
    server.use(
      rest.post(`${PORTAL_URL}/api/v1/auth/exchange`, async (req, res, ctx) => {
        const body = await req.json();
        expect(body).toEqual({ code: "abc123" });
        return res(
          ctx.status(200),
          ctx.json({ token: "jwt-token", expiresIn: 1800 })
        );
      })
    );

    const result = await exchangeAuthCode("abc123");
    expect(result).toEqual({ token: "jwt-token", expiresIn: 1800 });
  });

  it("surfaces the portal error message when the exchange fails", async () => {
    server.use(
      rest.post(`${PORTAL_URL}/api/v1/auth/exchange`, (_req, res, ctx) =>
        res(ctx.status(401), ctx.json({ error: "invalid_code" }))
      )
    );

    await expect(exchangeAuthCode("nope")).rejects.toThrow(/invalid_code/);
  });

  it("falls back to a generic error message when the body has no error", async () => {
    server.use(
      rest.post(`${PORTAL_URL}/api/v1/auth/exchange`, (_req, res, ctx) =>
        res(ctx.status(502), ctx.body(""))
      )
    );

    await expect(exchangeAuthCode("nope")).rejects.toThrow(
      /Auth code exchange failed: 502/
    );
  });
});

describe("fetchTenantInfo", () => {
  it("returns the parent tenant id when present", async () => {
    server.use(
      rest.get(`${PORTAL_URL}/api/v1/tenant`, (req, res, ctx) => {
        expect(req.headers.get("authorization")).toBe("Bearer portal-token");
        return res(ctx.status(200), ctx.json({ parentTenantId: "parent-abc" }));
      })
    );

    const info = await fetchTenantInfo("portal-token");
    expect(info).toEqual({ parentTenantId: "parent-abc" });
  });

  it("returns null parentTenantId when the portal omits it", async () => {
    server.use(
      rest.get(`${PORTAL_URL}/api/v1/tenant`, (_req, res, ctx) =>
        res(ctx.status(200), ctx.json({}))
      )
    );

    const info = await fetchTenantInfo("portal-token");
    expect(info.parentTenantId).toBeNull();
  });

  it("swallows non-2xx responses and returns null", async () => {
    server.use(
      rest.get(`${PORTAL_URL}/api/v1/tenant`, (_req, res, ctx) =>
        res(ctx.status(500), ctx.json({ error: "portal down" }))
      )
    );

    const info = await fetchTenantInfo("portal-token");
    expect(info.parentTenantId).toBeNull();
  });

  it("swallows network errors and returns null", async () => {
    server.use(
      rest.get(`${PORTAL_URL}/api/v1/tenant`, (_req, res) =>
        res.networkError("connection refused")
      )
    );

    const info = await fetchTenantInfo("portal-token");
    expect(info.parentTenantId).toBeNull();
  });
});
