# MSP Portal Integration — Progress Log

Live status of the 20-chunk plan in
[`portal-integration-plan.md`](./portal-integration-plan.md). Updated as work
lands. Status markers:

- ✅ **Done** — code and tests merged on this branch.
- 🟡 **Partial** — some code exists but tests or scope are incomplete.
- ❌ **TODO** — not started.
- 🏚 **Pre-existing** — landed before this integration effort; audit below.

## Summary

| Stage                      | Chunks done                          | Chunks remaining                                          |
| -------------------------- | ------------------------------------ | --------------------------------------------------------- |
| 1 — Portal auth foundation | 1.1, 1.2, 1.3 (existing), 1.5 tested | 1.4 (global catcher), 1.6 (tests), 1.7 (Supabase removal) |
| 2 — Breakglass             | 2.1, 2.2                             | 2.3 (audit log context)                                   |
| 3 — Multi-client switcher  | —                                    | 3.1, 3.2                                                  |
| 4 — ConnectWise sync       | 4.1, 4.2, 4.3                        | 4.4 (cron — blocked on service-account design)            |
| 5 — Device sync            | 5.1, 5.2, 5.3                        | — ✅                                                      |
| 6 — Entra user sync        | 6.1, 6.2                             | — ✅                                                      |

## Stage 1 — Portal auth foundation

| Chunk                                    | Status                | Notes                                                                                                                                                                                                |
| ---------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 JWKS verifier                        | 🟡 covered by tests   | Code already existed in `apps/webapp/app/utils/portal-auth.server.ts` from commit `7441b69`. Uses `jose.createRemoteJWKSet`; `jose` handles JWKS caching internally. Tested in `e13ec93`, `dad93f1`. |
| 1.2 Portal config + auth-exchange client | 🟡 covered by tests   | `exchangeAuthCode` in same file. Config constants read from `~/utils/env`. Tested in `dad93f1`.                                                                                                      |
| 1.3 JWT session cookie                   | 🏚 existing           | Implemented via react-router-hono-server `context.setSession` (see `apps/webapp/server/session.ts`). No extra tests yet.                                                                             |
| 1.4 Global auth-code catcher             | ❌ TODO               | Current implementation handles `?code=` only on `/portal-callback`. Plan wanted a middleware catching `?code=` on any route. Acceptable to defer if portal redirect target is configurable.          |
| 1.5 Role mapping + session hydration     | ✅ tested             | `mapPortalRoleToShelfRole`. Tested in `e13ec93`.                                                                                                                                                     |
| 1.6 First-launch provisioning            | 🏚 existing, untested | 429 lines in `apps/webapp/app/modules/user/portal-provisioning.server.ts`. Uses Supabase client (not Prisma). No tests yet.                                                                          |
| 1.7 Supabase removal                     | ❌ TODO               | `portal-provisioning.server.ts` still uses `sbDb`. Supabase deps remain in `package.json`. Destructive cutover deferred.                                                                             |

## Stage 2 — Breakglass

| Chunk                               | Status           | Notes                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Breakglass banner               | ✅ done          | `apps/webapp/app/components/breakglass/breakglass-banner.tsx` + layout wiring + `usePortalSession`/`useReadonly` hooks. Commit `93d5612`.                                                                                                                                                                            |
| 2.2 Read-only writeblock middleware | ✅ done          | `enforceReadonly` in `apps/webapp/server/middleware.ts`. Blocks POST/PUT/PATCH/DELETE for readonly sessions; excludes `/logout`, `/portal-callback`, `/healthcheck`. Commit `93d5612`.                                                                                                                               |
| 2.3 Audit log breakglass context    | ✅ done (scoped) | Shelf has no persistent access-audit table. The plan's intent is implemented as structured warn-level events via `Logger.warn({ event, ... })`. `enforceReadonly` emits `portal.readonly_block` on every blocked write; `portal-callback.tsx` emits `portal.breakglass_login` on breakglass entry. Commit `63da427`. |

## Stage 3 — Multi-client switcher

| Chunk                                | Status  | Notes                                                                                                       |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------- |
| 3.1 Multi-org membership in session  | ❌ TODO | Provisioning already creates `UserOrganization` rows; switcher surface + cross-org check still outstanding. |
| 3.2 Switcher UI + tenant-scope guard | ❌ TODO | Shelf's existing org switcher exists; needs portal-role-aware behaviour + cross-tenant guard.               |

## Stage 4 — ConnectWise company sync

| Chunk                           | Status     | Notes                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1 Credential-vending client   | ✅ done    | `apps/webapp/app/modules/portal-integrations/credentials.server.ts`. Shared by all Stage 4/5/6 adapters. Commit `d86a2af`.                                                                                                                                                                    |
| 4.2 ConnectWise adapter         | ✅ done    | `connectwise/client.server.ts`. `listCompanies`, `listAllCompanies`, `getCompany`. Commit `f1fc64c`.                                                                                                                                                                                          |
| 4.3 Company sync service (lazy) | ✅ done    | `connectwise/sync.server.ts`. Matches orgs by `portalTenantSlug` against CW's `identifier`. Commit `ad9f872`. Interim design — a `connectwiseCompanyId` column on `Organization` would tighten matching (needs a schema migration).                                                           |
| 4.4 Nightly refresh cron        | ❌ BLOCKED | Shelf's scheduler (`pg-boss`) runs with `noScheduling: true`. Cron would need either (a) a service-account token from the portal that cron can call without a user session, or (b) an external cron HTTP-pinging an authenticated Shelf endpoint. Both require a portal-side design decision. |

## Stage 5 — Device sync

| Chunk                       | Status  | Notes                                                                                                            |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| 5.1 Device → Asset mapper   | ✅ done | `devices/mapper.server.ts`. Reuses existing `ExternalAssetLink` model; no new `Asset` columns. Commit `cd222af`. |
| 5.2 ImmyBot adapter + sync  | ✅ done | `immybot/client.server.ts` + `sync.server.ts`. Commits `16295e3`, `8961db2`.                                     |
| 5.3 NinjaRMM adapter + sync | ✅ done | `ninja/client.server.ts` + `sync.server.ts`. Cursor-style pagination (?after=id). Commit `fb09dba`.              |

## Stage 6 — Entra user sync

| Chunk                 | Status  | Notes                                                                                                                                                                           |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.1 Entra adapter     | ✅ done | `entra/client.server.ts`. `listUsersPage`, `listAllUsers` (walks `@odata.nextLink`), `normalizeEntraUser`.                                                                      |
| 6.2 User sync service | ✅ done | `entra/sync.server.ts`. Creates Shelf `User` rows by email lookup; does **not** update existing users (no locked-fields model on User yet). Skips entries with no usable email. |

## Operational notes

- **Formatter hook** runs repo-wide on every Write/Edit. Every commit on this
  branch has been scoped manually via `git restore` on the formatter-touched
  files so the commit diff only contains the intentional changes. If this
  hook is ever fixed to run only on touched files, these manual restores
  become unnecessary.
- **Prisma client must be generated** before the webapp typechecks. Run
  `pnpm db:generate` after a fresh clone.
- **Tests use MSW v1** (`rest`), not v2 (`http`). Package pins `msw ^1.3.5`.
- **Test JWTs** use `jose.generateKeyPair` + `exportJWK`; the JWKS handler is
  registered in `beforeAll` and re-applied after each `resetHandlers` call.
- **Per-tenant credential cache** (`credentials.server.ts`) is in-process.
  It's reset between tests via `__resetVendedCredentialsCacheForTest()`.
- **Pre-existing test failures** in
  `apps/webapp/app/modules/user/service.server.test.ts`
  (6 cases in `createUserOrAttachOrg`) fail on this branch AND on the
  parent commit — a copy-drift between an error message in the source
  and its fixture. Unrelated to the portal integration work. Worth
  fixing separately.

## Decisions still deferred (called out in the plan, unblock before coding)

- **`read_only` → Shelf role mapping.** Current code in
  `portal-auth.server.ts` maps `read_only` → `BASE`, which lets read-only
  users write. Mitigation for breakglass: `enforceReadonly` middleware
  (Chunk 2.2) blocks writes server-side for any session with
  `isReadonly: true`. A cleaner long-term fix is introducing a `READ_ONLY`
  Shelf role.
- **MAC-address storage shape** — no dedicated column on `Asset`. The
  device mapper writes MACs into `ExternalAssetLink.metadata.macAddresses`
  and folds them into the Asset's `description` for searchability.
- **Entra user keying: email vs `objectId`.** Stage 6.2 keys on email.
  `entraObjectId` is computed and available on the normalized shape, so a
  future column on `User` can switch the key without rewriting the adapter.
- **Breakglass user lifecycle after expiry.** Portal is expected to
  invalidate tokens server-side; Shelf accepts breakglass JWTs, banners
  them, and enforces read-only. No post-expiry cleanup in Shelf today.
- **ConnectWise companyId column on Organization.** Current match uses
  `portalTenantSlug` ↔ CW `identifier`. Adding an indexed
  `connectwiseCompanyId` + storing it during sync would skip the walk.
  Requires a live Postgres to run `prisma migrate`.
- **Cron authentication for scheduled syncs** (Chunk 4.4). See
  "Stage 4, 4.4" above.
