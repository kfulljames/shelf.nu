# Module Integration Guide — Credential Vending & Authentication

This document is the reference for modules that integrate with the MSP Portal's
credential vending system. If you are building a module that calls vendor APIs
(ImmyBot, ConnectWise, NinjaRMM, Datto, Huntress, N-central, Microsoft Entra),
follow this guide to authenticate and obtain credentials securely.

---

## Architecture Overview

```
Module Server                       MSP Portal                         Vendor API
    |                                   |                                  |
    |-- GET /api/v1/integrations/       |                                  |
    |   {slug}/credentials ------------>|                                  |
    |   (Bearer: module-scoped JWT)     |                                  |
    |                                   |-- decrypts stored creds          |
    |                                   |-- (OAuth2 vendors) exchanges     |
    |                                   |   client_secret for access_token |
    |                                   |                                  |
    |<-- { credentials } ---------------|                                  |
    |                                   |                                  |
    |-- GET {baseUrl}/api/endpoint -----|--------------------------------->|
    |   (Bearer: accessToken)           |                                  |
    |<-- vendor response ---------------|----------------------------------|
```

**Key security property:** For OAuth2 vendors (ImmyBot, NinjaRMM, Datto, N-central,
Microsoft Entra), the raw `client_secret` never leaves the portal. The portal
exchanges it for a short-lived access token and vends only that token.

For API-key vendors (ConnectWise, Huntress), no token exchange is available, so
the raw API keys are vended directly over HTTPS, server-to-server only.

---

## Prerequisites

Before using credential vending, your module must:

1. Be registered in the portal's `modules` table with `type = "external_link"`
2. Have completed the authorization code exchange flow (see `CLAUDE.md` section
   "How to Build a New Module")
3. Hold a valid **module-scoped JWT** (obtained via `POST /api/v1/auth/exchange`)

---

## Step 1: Authenticate with the Portal

Your module receives a module-scoped JWT during the launch flow. Use this JWT as
a Bearer token for all portal API calls.

```ts
const PORTAL_URL = Deno.env.get("PORTAL_URL"); // https://msp.bluesnoot.com

// moduleToken was obtained during the auth code exchange at launch
const headers = {
  Authorization: `Bearer ${moduleToken}`,
};
```

---

## Step 2: Request Vended Credentials

```
GET {PORTAL_URL}/api/v1/integrations/{slug}/credentials
Authorization: Bearer <module-scoped-jwt>
```

### Response (OAuth2 vendor — ImmyBot, NinjaRMM, Datto, N-central, Entra)

```jsonc
{
  "credentials": {
    "authMethod": "oauth2_token",
    "baseUrl": "https://acme.immy.bot/api/v1",
    "accessToken": "<short-lived-oauth2-token>",  // short-lived (~1 hour)
    "expiresIn": 3600                      // seconds until expiry
  }
}
```

### Response (API-key vendor — ConnectWise, Huntress)

```jsonc
{
  "credentials": {
    "authMethod": "api_key",
    "baseUrl": "https://na.myconnectwise.net/v4_6_release/apis/3.0",
    "apiCredentials": {
      "companyId": "acme",
      "clientId": "uuid",
      "publicKey": "abc123",
      "privateKey": "xyz789"
    }
  }
}
```

### Error responses

| Status | Meaning |
|--------|---------|
| 400 | Integration does not support credential vending (use proxy instead) |
| 401 | Invalid or expired JWT |
| 403 | User has no tenant assigned |
| 404 | Integration not found or not configured for this tenant |
| 502 | Token exchange with vendor failed |

---

## Step 3: Call the Vendor API Directly

### OAuth2 vendors (accessToken)

```ts
const res = await fetch(`${credentials.baseUrl}/computers`, {
  headers: {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: "application/json",
  },
});
const data = await res.json();
```

### API-key vendors (ConnectWise example)

```ts
const { companyId, publicKey, privateKey, clientId } = credentials.apiCredentials;
const basicAuth = btoa(`${companyId}+${publicKey}:${privateKey}`);

const res = await fetch(`${credentials.baseUrl}/company/configurations`, {
  headers: {
    Authorization: `Basic ${basicAuth}`,
    clientId: clientId,
    Accept: "application/json",
  },
});
```

### API-key vendors (Huntress example)

```ts
const { apiKey, apiSecret } = credentials.apiCredentials;
const basicAuth = btoa(`${apiKey}:${apiSecret}`);

const res = await fetch(`${credentials.baseUrl}/organizations`, {
  headers: {
    Authorization: `Basic ${basicAuth}`,
    Accept: "application/json",
  },
});
```

---

## Step 4: Handle Token Expiry

For OAuth2 vendors, the vended `accessToken` expires after the `expiresIn` period
(typically ~1 hour). When it expires:

1. Call `GET /api/v1/integrations/{slug}/credentials` again to get a fresh token
2. The portal will exchange the stored credentials for a new access token
3. Retry the failed vendor API call with the new token

```ts
async function fetchWithRefresh(url: string, slug: string, moduleToken: string) {
  let creds = await getVendedCredentials(slug, moduleToken);
  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.accessToken}` },
  });

  if (res.status === 401) {
    // Token expired — get fresh credentials from portal
    creds = await getVendedCredentials(slug, moduleToken);
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
  }

  return res;
}

async function getVendedCredentials(slug: string, moduleToken: string) {
  const res = await fetch(
    `${PORTAL_URL}/api/v1/integrations/${slug}/credentials`,
    { headers: { Authorization: `Bearer ${moduleToken}` } },
  );
  const { credentials } = await res.json();
  return credentials;
}
```

---

## Credential Vending vs Proxy — When to Use Which

| Approach | Endpoint | Use when |
|----------|----------|----------|
| **Credential vending** | `GET /api/v1/integrations/{slug}/credentials` | Module needs to make many vendor API calls directly (better performance, lower latency) |
| **Proxy** | `POST /api/v1/integrations/{slug}/proxy` | Module makes occasional calls, or you prefer the portal to handle auth entirely |

Both approaches are available for all integrations. The proxy never exposes
credentials; credential vending exposes only short-lived tokens for OAuth2 vendors.

---

## Complete Example: Pulling MAC Addresses from ImmyBot

This example shows a module route that fetches computer inventory (including MAC
addresses) from ImmyBot using vended credentials.

```ts
// routes/api/devices/mac-addresses.ts

const PORTAL_URL = Deno.env.get("PORTAL_URL")!;

export async function handler(req: Request) {
  // 1. Get the module-scoped JWT from the module's session
  const moduleToken = getSessionToken(req); // your session management

  // 2. Vend credentials from the portal
  //    The portal exchanges the stored Azure AD client credentials for a
  //    short-lived access token. The raw client_secret never reaches this module.
  const credsRes = await fetch(
    `${PORTAL_URL}/api/v1/integrations/immybot/credentials`,
    { headers: { Authorization: `Bearer ${moduleToken}` } },
  );

  if (!credsRes.ok) {
    const err = await credsRes.json();
    return Response.json({ error: err.error }, { status: credsRes.status });
  }

  const { credentials } = await credsRes.json();
  // credentials = {
  //   authMethod: "oauth2_token",
  //   baseUrl: "https://acme.immy.bot/api/v1",
  //   accessToken: "<short-lived-oauth2-token>",
  //   expiresIn: 3600,
  // }

  // 3. Call ImmyBot API directly using the vended access token
  const computersRes = await fetch(`${credentials.baseUrl}/computers`, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
    },
  });

  if (!computersRes.ok) {
    return Response.json(
      { error: `ImmyBot API error: ${computersRes.status}` },
      { status: 502 },
    );
  }

  const computers = await computersRes.json();

  // 4. Extract MAC addresses from computer inventory
  const devices = computers.map((computer: Record<string, unknown>) => ({
    computerId: computer.computerId,
    computerName: computer.computerName,
    serialNumber: computer.serialNumber,
    // ImmyBot inventory data — check your Swagger UI for exact shape
    macAddresses: extractMacAddresses(computer),
  }));

  return Response.json({ devices });
}

function extractMacAddresses(computer: Record<string, unknown>): string[] {
  // ImmyBot may store network adapters in inventory data
  // Check https://yourdomain.immy.bot/swagger for exact schema
  const adapters = computer.networkAdapters as
    | Array<{ macAddress?: string }>
    | undefined;
  if (adapters) {
    return adapters.map((a) => a.macAddress).filter(Boolean) as string[];
  }
  return [];
}
```

---

## Vendor-Specific Reference

### ImmyBot

| Field | Value |
|-------|-------|
| Slug | `immybot` |
| Auth method | `oauth2_token` |
| Base URL format | `https://{subdomain}.immy.bot/api/v1` |
| Token lifetime | ~1 hour (Azure AD default) |
| Swagger docs | `https://{subdomain}.immy.bot/swagger` |
| Key endpoints | `/computers`, `/tenants`, `/deployments` |

### NinjaRMM

| Field | Value |
|-------|-------|
| Slug | `ninja` |
| Auth method | `oauth2_token` |
| Base URL format | `https://{host}/api/v2` |
| Token lifetime | ~1 hour |
| Key endpoints | `/devices`, `/organizations`, `/devices/{id}` |

### Datto RMM

| Field | Value |
|-------|-------|
| Slug | `datto` |
| Auth method | `oauth2_token` |
| Base URL format | `https://{host}/api/v2` |
| Token lifetime | ~1 hour |
| Key endpoints | `/account/devices`, `/account/sites` |

### N-central

| Field | Value |
|-------|-------|
| Slug | `ncentral` |
| Auth method | `oauth2_token` (JWT exchange) |
| Base URL format | `https://{host}/api` |
| Token lifetime | varies |
| Key endpoints | `/devices`, `/customers` |

### Microsoft Entra (Graph)

| Field | Value |
|-------|-------|
| Slug | `entra` |
| Auth method | `oauth2_token` |
| Base URL | `https://graph.microsoft.com/v1.0` |
| Token lifetime | ~1 hour |
| Key endpoints | `/users`, `/devices`, `/groups` |

### ConnectWise PSA

| Field | Value |
|-------|-------|
| Slug | `connectwise` |
| Auth method | `api_key` |
| Base URL format | `https://{host}/v4_6_release/apis/3.0` |
| Auth header | `Basic {base64(companyId+publicKey:privateKey)}` + `clientId` header |
| Key endpoints | `/company/configurations`, `/service/tickets` |

### Huntress

| Field | Value |
|-------|-------|
| Slug | `huntress` |
| Auth method | `api_key` |
| Base URL | `https://api.huntress.io/v1` |
| Auth header | `Basic {base64(apiKey:apiSecret)}` |
| Key endpoints | `/organizations`, `/agents`, `/incident_reports` |

---

## Security Model

### What the module receives

| Vendor type | What is vended | Raw secret exposed? |
|-------------|----------------|---------------------|
| OAuth2 (ImmyBot, Ninja, Datto, N-central, Entra) | Short-lived access token (~1hr) | **No** — client_secret stays in portal |
| API-key (ConnectWise, Huntress) | Raw API keys | **Yes** — no token exchange available |

### Trust boundaries

- Credentials are vended **server-to-server over HTTPS only**
- The credential vending endpoint requires a valid **module-scoped JWT**
- All vending operations are **audit logged** (`integration.credentials_vended`)
- For OAuth2 vendors, if a vended token leaks, it expires in ~1 hour
- For API-key vendors, the MSP admin can revoke/rotate keys from the portal
- **Token revocation**: if a user's session is revoked (via admin action or
  breakglass expiry), their module-scoped JWT is also invalidated. Modules using
  the portal's remote validation endpoint (`GET /api/v1/token`) will see immediate
  rejection. Modules validating locally should check `exp` and implement JWKS cache
  refresh on verification failure.

### What modules must NOT do

- Never expose vended credentials to the browser/client-side
- Never log access tokens or API keys
- Never cache credentials longer than their `expiresIn` value
- Never use the proxy endpoint AND credential vending simultaneously for the
  same request (pick one approach)

---

## Migrating an Existing Module from Proxy to Credential Vending

If your module currently uses `POST /api/v1/integrations/{slug}/proxy`:

1. Replace proxy calls with `GET /api/v1/integrations/{slug}/credentials`
2. Use the vended `accessToken` or `apiCredentials` to call the vendor directly
3. Add token refresh logic (see Step 4 above)
4. Remove the proxy request body construction (`method`, `path`, `query`, `body`)

The proxy endpoint remains available as a fallback. Both approaches can coexist
during migration.

---

## Environment Variables (Module-Side)

| Variable | Description |
|----------|-------------|
| `PORTAL_URL` | Portal base URL, e.g. `https://msp.bluesnoot.com` — used for JWKS fetch and re-launch redirects |

Modules discover public keys dynamically from `GET {PORTAL_URL}/.well-known/jwks.json`.
No shared secrets are needed.

---

## Checklist for Module Developers

- [ ] Module authenticates with portal using module-scoped JWT
- [ ] Module calls `GET /api/v1/integrations/{slug}/credentials` to obtain vendor credentials
- [ ] Module checks `authMethod` to determine how to use the credentials
- [ ] For `oauth2_token`: uses `accessToken` as Bearer token, respects `expiresIn`
- [ ] For `api_key`: builds vendor-specific auth headers from `apiCredentials`
- [ ] Token refresh logic handles 401 responses from vendor APIs
- [ ] Credentials are never exposed to the browser or logged
- [ ] Credentials are never cached beyond their expiry
- [ ] Module-scoped JWT expiry (30 min) is handled — redirects to portal for re-launch

---

## Adapter Reference

This section documents each vendor integration adapter registered in the portal.
Adapters live in `lib/integrations/<vendor>/` and follow a uniform interface
(`IIntegrationAdapter` from `lib/integrations/types.ts`).

### Proxy architecture

```
Module (external)                        Portal
  │                                        │
  ├─ POST /api/v1/integrations/:slug/proxy ──►  Decrypt stored credentials
  │   { method, path, query, body }        │    Look up adapter by slug
  │                                        │    adapter.proxy(creds, request)
  │                                        │        │
  │                                        │        ▼
  │                                        │    Vendor API (CW, Ninja, etc.)
  │                                        │        │
  │  ◄── { status, data } ────────────────────────  │
```

### Adapter interface

Every adapter implements `IIntegrationAdapter`:

```ts
interface IIntegrationAdapter {
  slug: string;                           // URL-safe identifier
  name: string;                           // Human-readable name
  description: string;
  icon: string;
  configFields: ConfigFieldDefinition[];  // UI form fields
  configSchema: z.ZodSchema;              // Runtime validation

  testConnection(config: unknown): Promise<ConnectionTestResult>;
  proxy(config: unknown, request: ProxyRequest): Promise<ProxyResponse>;
}
```

Adapters are registered in `lib/integrations/registry.ts` and auto-synced to
the `integration_definitions` DB table on startup via `lib/integrations/sync.ts`.

### ConnectWise PSA

| Property | Value |
|---|---|
| **Slug** | `connectwise` |
| **Auth** | Basic — `companyId+publicKey:privateKey` (Base64) |
| **API base** | `https://{siteUrl}/v4_6_release/apis/3.0` |
| **Required header** | `clientId` (UUID from ConnectWise Developer Portal) |
| **Test endpoint** | `GET /system/info` |
| **Config fields** | `siteUrl`, `companyId`, `clientId`, `publicKey`, `privateKey` |
| **Files** | `lib/integrations/connectwise/` |

### NinjaRMM (NinjaOne)

| Property | Value |
|---|---|
| **Slug** | `ninja` |
| **Auth** | OAuth2 client credentials (`client_id` + `client_secret`) |
| **API base** | `https://{instanceUrl}/api/v2` |
| **Token endpoint** | `https://{instanceUrl}/ws/oauth/token` |
| **Token caching** | In-memory, expires 60 s early |
| **Test endpoint** | `GET /organizations?pageSize=1` |
| **Config fields** | `instanceUrl`, `clientId`, `clientSecret` |
| **Files** | `lib/integrations/ninja/` |

### Datto RMM

| Property | Value |
|---|---|
| **Slug** | `datto` |
| **Auth** | OAuth2 client credentials (Basic header with `apiKey:apiSecret`) |
| **API base** | `https://{apiUrl}/api/v2` |
| **Token endpoint** | `https://{apiUrl}/auth/oauth/token` |
| **Token caching** | In-memory, expires 60 s early |
| **Test endpoint** | `GET /account/sites?max=1` |
| **Config fields** | `apiUrl`, `apiKey`, `apiSecret` |
| **Files** | `lib/integrations/datto/` |

### Huntress

| Property | Value |
|---|---|
| **Slug** | `huntress` |
| **Auth** | Basic — `apiKey:apiSecret` (Base64) |
| **API base** | `https://api.huntress.io/v1` (fixed) |
| **Test endpoint** | `GET /organizations?page=1&per_page=1` |
| **Config fields** | `apiKey`, `apiSecret` |
| **Files** | `lib/integrations/huntress/` |

### N-central (N-able)

| Property | Value |
|---|---|
| **Slug** | `ncentral` |
| **Auth** | Two-step JWT — exchange long-lived JWT for short-lived access token |
| **API base** | `https://{serverUrl}/api` |
| **Auth endpoint** | `POST /auth/authenticate` (Bearer long-lived JWT) |
| **Token caching** | In-memory, expires 60 s early |
| **Test endpoint** | `GET /devices?pageSize=1&pageNumber=1` |
| **Config fields** | `serverUrl`, `jwtToken` |
| **Files** | `lib/integrations/ncentral/` |

### ImmyBot

| Property | Value |
|---|---|
| **Slug** | `immybot` |
| **Auth** | OAuth2 client credentials via Azure AD |
| **API base** | `https://{subdomain}.immy.bot/api/v1` |
| **Token endpoint** | `https://login.microsoftonline.com/{azureTenantId}/oauth2/v2.0/token` |
| **Token caching** | In-memory, expires 60 s early |
| **Test endpoint** | `GET /tenants` |
| **Config fields** | `instanceSubdomain`, `azureTenantId`, `clientId`, `clientSecret` |
| **Files** | `lib/integrations/immybot/` |

### Microsoft Entra (Azure AD)

| Property | Value |
|---|---|
| **Slug** | `entra` |
| **Auth** | OAuth2 client credentials via Azure AD |
| **API base** | `https://graph.microsoft.com/v1.0` (fixed) |
| **Token endpoint** | `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` |
| **Token caching** | In-memory, expires 60 s early |
| **Test endpoint** | `GET /organization` |
| **Config fields** | `tenantId`, `clientId`, `clientSecret` |
| **Files** | `lib/integrations/entra/` |

### Credential lifecycle

1. **Save** — `PUT /api/msp/integrations/:provider` encrypts each credential
   value with AES-GCM before writing to `tenant_integration_configs.credentials`.
2. **Test** — `POST /api/msp/integrations/:provider/test` decrypts credentials,
   then calls `adapter.testConnection()`.
3. **Proxy** — `POST /api/v1/integrations/:slug/proxy` decrypts credentials,
   then calls `adapter.proxy()`. Credentials never reach the calling module.
4. **Read** — `GET /api/msp/integrations/:provider` returns masked placeholders
   (`••••••••`) for all fields. Encrypted ciphertext is never exposed.

### Adding a new integration

1. Create `lib/integrations/<slug>/adapter.ts`, `client.ts`, `types.ts`
2. Implement `IIntegrationAdapter` with `testConnection()` and `proxy()`
3. Add `import` and `registerAdapter()` in `lib/integrations/registry.ts`
4. Add seed data in `lib/db/seed.ts` (optional — sync.ts handles runtime)
5. The adapter auto-syncs to `integration_definitions` on next server start
