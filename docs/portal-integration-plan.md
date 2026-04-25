# MSP Portal Integration — Implementation Plan

Turning Shelf into a module of the MSP Portal (`msp.bluesnoot.com`).
Based on `MODULE_INTEGRATION.md` and `MODULE_RBAC_GUIDE.md`.

---

## Decisions

| #   | Decision                 | Choice                                                                                    |
| --- | ------------------------ | ----------------------------------------------------------------------------------------- |
| 1   | Deployment model         | **Module-only.** No standalone Shelf. Supabase auth UI is removed.                        |
| 2   | Module slug              | `shelf-asset-management`                                                                  |
| 3   | Source of truth for orgs | ConnectWise PSA (via portal credential vending) → Shelf `Organization`                    |
| 4   | MSP user view            | One client at a time, with a switcher                                                     |
| 5   | Role system              | **Translate at the edge** — keep Shelf's `Role` enum, map portal `groups` → `Role` at JWT |
| 6   | Breakglass posture       | Minimal: accept JWT, log, honor `isReadonly`, show banner                                 |
| 7   | Vendor integrations      | ConnectWise (companies), ImmyBot (devices), NinjaRMM (devices), Entra (users)             |
| 8   | Sync strategy            | Lazy on first launch **and** nightly scheduled refresh                                    |
| 9   | JWT validation           | Local JWKS verification, 5-minute cache                                                   |

---

## Architecture

### Before (standalone Shelf)

```
User ──► Supabase Auth (login/signup) ──► Shelf webapp ──► Prisma/Postgres
```

### After (module of MSP Portal)

```
User ──► MSP Portal ──(?code=…)──► Shelf webapp
                                     │
                                     ├─ POST /api/v1/auth/exchange ──► Portal (swap code for module JWT)
                                     ├─ JWKS fetch (cached 5 min)   ──► Portal
                                     └─ GET /api/v1/integrations/{slug}/credentials ──► Portal ──► Vendor API
```

Shelf no longer owns:

- Login, signup, password reset, email verification, onboarding
- Supabase Auth client & sessions
- Direct vendor API credentials (stored in portal instead)

Shelf still owns:

- Organization, Asset, Booking, Custody, QR, Bookings, etc. (all domain data)
- Its own Postgres + Prisma schema
- UI, reports, exports

---

## Data model impact

No destructive schema changes. Additive only.

| Table              | Change                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Organization`     | **Add** `portalTenantId String? @unique` and `connectwiseCompanyId String?`. Nullable for migration; populated on first launch.                                 |
| `User`             | **Add** `portalSubjectId String? @unique` (the JWT `sub` claim). **Remove** Supabase-specific columns only after Stage 1 cutover (kept nullable until cleanup). |
| `UserOrganization` | No change. Already N:M; MSP users get rows for every client Org.                                                                                                |
| `Asset`            | **Add** `externalSource String?` (`"immybot"` / `"ninja"`) and `externalId String?`. Indexed on `(organizationId, externalSource, externalId)`.                 |
| `AuditLog` (new)   | If not already present, add `breakglass Boolean`, `breakglassExpires DateTime?`, `impersonatedBy String?` columns/flags for compliance logging.                 |

All columns nullable so existing rows keep working.

---

## Environment variables

### Added

| Var                  | Purpose                                                                        |
| -------------------- | ------------------------------------------------------------------------------ |
| `PORTAL_URL`         | e.g. `https://msp.bluesnoot.com`. Used for exchange, JWKS, credential vending. |
| `SHELF_MODULE_SLUG`  | Fixed to `shelf-asset-management`. Lives in config, not env, but documented.   |
| `JWKS_CACHE_TTL_SEC` | Default `300`. Override for tests.                                             |
| `SESSION_SECRET`     | **Keep.** Still used to sign Shelf's session cookie that wraps the module JWT. |

### Removed (after cutover in chunk 1.5)

- `SUPABASE_URL`
- `SUPABASE_ANON_PUBLIC`
- `SUPABASE_SERVICE_ROLE`
- `DISABLE_SIGNUP`
- `SEND_ONBOARDING_EMAIL`

---

# Implementation chunks

Each chunk is a standalone PR. Chunks within a stage are ordered — later chunks
depend on earlier ones. Stages themselves can be paused or reprioritized between.

**Sizing key:** 🟢 small (<1 day), 🟡 medium (1-2 days), 🔴 large (3+ days).

---

## Stage 1 — Portal auth (foundation)

Goal: users launch from the portal and land in a working Shelf session. No
domain behavior changes. Supabase is physically still there until chunk 1.7.

### Chunk 1.1 — JWKS verifier utility 🟢

- New: `app/modules/portal-auth/jwks.server.ts`.
- Fetches `{PORTAL_URL}/.well-known/jwks.json`, caches keys for 5 min.
- `verifyModuleJwt(token): Promise<ModuleJwtPayload>` using `jose`.
- Rotates cache on verify failure; retries once.
- Unit tests with mocked JWKS response (MSW).
- **No wiring to routes yet.** Just a library.

### Chunk 1.2 — Portal config + auth-exchange client 🟢

- New: `app/config/portal.ts` — `PORTAL_URL`, `SHELF_MODULE_SLUG`.
- New: `app/modules/portal-auth/exchange.server.ts` — `exchangeAuthCode(code): Promise<ModuleJwt>`.
- Wraps `POST {PORTAL_URL}/api/v1/auth/exchange`.
- Typed errors for 400/401/403/502.
- Unit tests with MSW for portal responses.

### Chunk 1.3 — JWT session cookie 🟡

- New: `app/modules/portal-auth/session.server.ts`.
- Signed cookie stores `{ moduleJwt, issuedAt }`.
- Helpers: `getSessionJwt(request)`, `commitSessionJwt(jwt)`, `destroySession()`.
- Runs **parallel** to existing Supabase session — no removals yet.
- Unit tests for cookie round-trip + expiry.

### Chunk 1.4 — Auth-code catcher + redirect-to-portal guard 🟡

- New middleware in `server/` entry: intercepts any request with `?code=…`.
  - Calls `exchangeAuthCode`, sets session cookie, redirects to same path with
    `?code` stripped.
- New helper `requireModuleSession(request)` replaces `requireAuthSession`.
  - On missing/invalid JWT: `302` to `${PORTAL_URL}/launch/${SHELF_MODULE_SLUG}`.
- Gated behind `PORTAL_AUTH_ENABLED=true` env flag so we can test without
  breaking Supabase login.

### Chunk 1.5 — Role mapping + session hydration 🟡

- New: `app/modules/portal-auth/role-mapping.server.ts`.
  - Pure function `mapPortalGroupsToShelfRole(groups): Role`.
  - `super_admin`/`admin` → `OWNER`/`ADMIN`, `technician` → `BASE`,
    `read_only` → `SELF_SERVICE` (or new `READ_ONLY` if that's too restrictive —
    TBD in review).
- Session hydrator converts module JWT into the `AuthSession` shape Shelf
  consumes everywhere.
- Unit tests cover every group combination + multi-group priority (highest
  priority wins, matching portal behavior).

### Chunk 1.6 — First-launch provisioning 🟡

- New: `app/modules/portal-auth/provision.server.ts`.
- On validated session hydrate:
  - Upsert `User` by `portalSubjectId`.
  - Upsert `Organization` by `portalTenantId`.
  - Upsert `UserOrganization` link.
- Idempotent. Runs inside a transaction. Safe under concurrent launches
  (unique constraints on `portalSubjectId` and `portalTenantId`).
- Does **not** yet sync ConnectWise company metadata — just creates the Org
  record with placeholder name `Portal Tenant <id>`. Stage 4 populates names.

### Chunk 1.7 — Cutover + Supabase removal 🔴

- Flip `PORTAL_AUTH_ENABLED` default to on; remove the flag.
- Delete route trees: `app/routes/_auth+/`, `app/routes/_welcome+/`.
- Remove Supabase client & dependencies.
- Remove Supabase env vars from config + `.env.example`.
- Remove onboarding emails + templates that no longer apply.
- Update `CLAUDE.md` auth/section notes to reflect portal-only.
- Big diff but mostly deletions. Gate on passing validation pipeline.

---

## Stage 2 — Breakglass

### Chunk 2.1 — Session breakglass claims + banner 🟢

- Extend `AuthSession` with `breakglass`, `breakglassExpires`, `isReadonly`,
  `impersonatedBy`.
- New component: `<BreakglassBanner>` rendered in root layout when
  `breakglass === true`. Shows reason (fetched once from
  `/api/v1/breakglass/status`) and expiry countdown.
- Accessibility: banner is `role="alert"`, visible contrast, persistent.

### Chunk 2.2 — Read-only writeblock middleware 🟡

- Global Remix action wrapper that returns 403 when `isReadonly` and the
  request method is `POST`/`PUT`/`PATCH`/`DELETE`.
- Same check at the service layer for anything invoked outside actions
  (background jobs, webhooks) — defense in depth.
- UI: disable submit buttons and mutation menu items when `isReadonly`; hook
  `useDisabled()` already does per-form disable — extend with a
  `useReadonly()` hook to gray out everything proactively.

### Chunk 2.3 — Audit log breakglass context 🟢

- Every mutation path writes `breakglass`, `breakglassExpires`, `impersonatedBy`
  into the audit log row. Shelf's logger already accepts arbitrary context;
  this is a small plumbing change.
- Add filter in admin audit-log view to filter by breakglass.

---

## Stage 3 — Multi-client switcher for MSP users

### Chunk 3.1 — Load multi-org membership into session 🟢

- When session hydrates, if the user is `super_admin`/`admin`/`technician`
  (i.e. MSP-side), query all `UserOrganization` rows for them.
- Active `organizationId` resolution order:
  1. `?org=<id>` query param
  2. session cookie `activeOrgId`
  3. Most recently used (fallback to first)

### Chunk 3.2 — Switcher UI + scope guard 🟡

- Extend Shelf's existing org switcher component to list all orgs the user has
  membership in, not just the one active one.
- New loader helper `requireOrgScope(request, orgId)`: verifies the active
  org belongs to the user AND matches the JWT's `tenantId` _or_ is a child
  client tenant the MSP user has access to.
- Integration test: MSP technician cannot read assets for an org their MSP
  doesn't manage.

---

## Stage 4 — ConnectWise company sync

### Chunk 4.1 — Generic credential-vending client 🟢

- New: `app/modules/portal-integrations/credentials.server.ts`.
- `getVendedCredentials(slug): Promise<VendedCredentials>`.
- Handles both `oauth2_token` and `api_key` shapes.
- Caches `oauth2_token` responses in-memory until `expiresIn - 60s`.
- On 401 from vendor API, force re-fetch (used by vendor adapters).
- Shared by all of Stages 4/5/6.

### Chunk 4.2 — ConnectWise adapter 🟡

- New: `app/modules/portal-integrations/connectwise/client.server.ts`.
- Builds `Basic` + `clientId` headers from vended creds.
- Methods used in this stage: `listCompanies()`, `getCompany(id)`.
- Pagination + rate-limit backoff.
- MSW tests for each method.

### Chunk 4.3 — Company sync service (lazy) 🟡

- New: `app/modules/portal-integrations/connectwise/sync.server.ts`.
- `syncCompanyForTenant(tenantId)`: called from Chunk 1.6's provisioning.
  Populates `Organization.name`, `connectwiseCompanyId`, address, etc.
- First-launch blocks on this call (<2s typical). On failure, Org is still
  created with placeholder — user can proceed, nightly job fills in later.

### Chunk 4.4 — Nightly scheduled refresh 🟡

- New: cron entry or queue job (match Shelf's existing scheduler pattern).
- Runs daily: for every Org with a `connectwiseCompanyId`, refresh metadata.
- Respects soft-delete: ConnectWise "inactive" companies flip Org to
  `status = 'INACTIVE'` (don't delete — preserve asset history).
- Observability: emit metric per run (count succeeded/failed), log to Logger.

---

## Stage 5 — Device sync (ImmyBot + NinjaRMM)

### Chunk 5.1 — Device → Asset mapper 🟢

- New: `app/modules/portal-integrations/devices/mapper.server.ts`.
- Shared normalizer: vendor device → Shelf `Asset` create/update shape.
- Handles MAC addresses (store as custom field or new `Asset.macAddresses`
  column — schema decision TBD in review).
- No vendor code yet — just the normalizer + unit tests.

### Chunk 5.2 — ImmyBot adapter + sync 🟡

- New: `app/modules/portal-integrations/immybot/client.server.ts`.
  - `listComputers()`, handles `oauth2_token` refresh on 401.
- New: `.../immybot/sync.server.ts`.
  - Upserts assets by `(organizationId, 'immybot', computerId)`.
- Lazy: triggered on Org's first load of Assets page (with "syncing…" UI state).
- Cron: daily per Org.

### Chunk 5.3 — NinjaRMM adapter + sync 🟡

- Same shape as 5.2, different vendor:
  - `client.server.ts` for `/devices`.
  - `sync.server.ts` for `(organizationId, 'ninja', deviceId)`.
- Devices from both vendors for the same physical machine are **not** merged
  initially (they'd show as two assets). Dedupe by MAC is Stage 7 / later work.

---

## Stage 6 — User sync (Entra)

### Chunk 6.1 — Entra adapter 🟢

- New: `app/modules/portal-integrations/entra/client.server.ts`.
- `listUsers()` against Graph `/users`.
- Shares credential-vending client from Chunk 4.1.

### Chunk 6.2 — User sync service 🟡

- New: `.../entra/sync.server.ts`.
- Upserts Shelf `User` rows keyed on `email` (or `portalSubjectId` if we can
  get a stable identifier from Graph — TBD in review).
- **Does not** grant access — users only get `UserOrganization` rows after
  they actually launch via the portal (that's Chunk 1.6).
- Why sync them at all? So custody/booking assignment can name-search a user
  who hasn't opened Shelf yet.
- Cron: daily per Org that has Entra configured in the portal.

---

## Risks & open questions

Flagged for review before chunks start:

- **`read_only` mapping.** Shelf's `SELF_SERVICE` role lets users manage their
  own bookings. Portal `read_only` = cannot write anything. If we map them
  together we accidentally let read-only users create bookings. Probable fix:
  introduce a `READ_ONLY` Shelf role. Decision needed in Chunk 1.5.
- **MSP user = membership in N Orgs.** The switcher handles UI, but permission
  checks that assume a single active Org need a tenant-scope guard
  (Chunk 3.2) — auditable list of every loader + action. I'll generate that
  list as part of Stage 3.
- **Entra user matching.** If an Entra user's email changes, we'll create a
  duplicate. Keying on `immutableId` / `objectId` is safer. Needs one
  portal-side question before Chunk 6.2.
- **Device dedupe.** ImmyBot + NinjaRMM both report the same physical laptop
  → two assets. Out of scope for this plan; propose Stage 7 later.
- **Token revocation latency.** 5-minute JWKS cache means fired users can
  still act for up to 5 min. Acceptable per decision #9; documented here so
  it doesn't surprise anyone in security review.
- **Breakglass user ↔ Shelf user.** Breakglass JWT has `sub` = temp user
  UUID. Chunk 1.6 provisions a Shelf User for them. After expiry the Shelf
  User row is orphaned. Should a nightly job soft-delete breakglass users
  whose last login > `breakglassExpires`? Decide before Chunk 2.1.

---

## Out of scope for this plan

- Two-way sync (writing from Shelf back to ConnectWise/Ninja/Entra).
- Billing module permissions (`billing:*`) — not needed by asset management.
- Any migration of existing Supabase users into the portal. The portal is the
  only identity provider going forward; there are no legacy accounts to carry.
- Huntress, Datto, N-central integrations. Can be added later with the same
  pattern as Chunks 5.x.
