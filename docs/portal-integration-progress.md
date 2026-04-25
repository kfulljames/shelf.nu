# MSP Portal Integration — Progress Log

Live status of the 20-chunk plan in
[`portal-integration-plan.md`](./portal-integration-plan.md). Updated as work
lands. Status markers:

- ✅ **Done** — code and tests merged on this branch.
- 🟡 **Partial** — some code exists but tests or scope are incomplete.
- ❌ **TODO** — not started.
- 🏚 **Pre-existing** — landed before this integration effort; audit below.

## Stage 1 — Portal auth foundation

| Chunk                                    | Status                | Notes                                                                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 JWKS verifier                        | 🟡 covered by tests   | Code already existed in `apps/webapp/app/utils/portal-auth.server.ts` from commit `7441b69`. Uses `jose.createRemoteJWKSet`. Does not implement the plan's "5-min TTL" explicitly — `jose` handles JWKS caching internally. Now unit-tested (`e13ec93`, `dad93f1`). |
| 1.2 Portal config + auth-exchange client | 🟡 covered by tests   | `exchangeAuthCode` lives in the same file. Config constants read from `~/utils/env`, not a dedicated `app/config/portal.ts` as the plan suggested. Tested in `dad93f1`.                                                                                             |
| 1.3 JWT session cookie                   | 🏚 existing           | Implemented via react-router-hono-server `context.setSession`, not a dedicated module. Fields on `AuthSession` match the plan's shape (`apps/webapp/server/session.ts`). No extra tests yet.                                                                        |
| 1.4 Global auth-code catcher             | ❌ TODO               | Current implementation requires portal to redirect to `/portal-callback?code=`. Plan wanted a middleware catching `?code=` on any route. Acceptable to defer unless portal redirect target is not configurable.                                                     |
| 1.5 Role mapping + session hydration     | ✅ tested             | `mapPortalRoleToShelfRole` in `portal-auth.server.ts`. Unit-tested in `e13ec93`.                                                                                                                                                                                    |
| 1.6 First-launch provisioning            | 🏚 existing, untested | 429 lines in `apps/webapp/app/modules/user/portal-provisioning.server.ts`. Uses Supabase client (not Prisma) throughout. No tests yet.                                                                                                                              |
| 1.7 Supabase removal                     | ❌ TODO               | `portal-provisioning.server.ts` still uses `sbDb.from(...)`. Supabase deps remain in `package.json`. Big cutover deferred.                                                                                                                                          |

## Stage 2 — Breakglass

| Chunk                               | Status  | Notes                                                                                                                                                                                  |
| ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Breakglass banner               | ✅ done | `apps/webapp/app/components/breakglass/breakglass-banner.tsx` + layout wiring + `usePortalSession`/`useReadonly` hooks. Commit `93d5612`.                                              |
| 2.2 Read-only writeblock middleware | ✅ done | `enforceReadonly` in `apps/webapp/server/middleware.ts`. Blocks POST/PUT/PATCH/DELETE for readonly sessions, excludes `/logout`, `/portal-callback`, `/healthcheck`. Commit `93d5612`. |
| 2.3 Audit log breakglass context    | ❌ TODO | No audit-log plumbing wired. Needs a hunt for existing audit patterns in Shelf.                                                                                                        |

## Stage 3 — Multi-client switcher

| Chunk                                | Status  | Notes                                                                                                        |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------ |
| 3.1 Multi-org membership in session  | ❌ TODO | Provisioning already creates a `UserOrganization` row; switcher surface & cross-org check still outstanding. |
| 3.2 Switcher UI + tenant-scope guard | ❌ TODO | Shelf's existing org switcher exists; needs portal-role-aware behaviour + cross-tenant guard.                |

## Stage 4 — ConnectWise company sync

| Chunk                           | Status  | Notes                                                                                                                                            |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4.1 Credential-vending client   | ✅ done | `apps/webapp/app/modules/portal-integrations/credentials.server.ts`. Shared by all Stage 4/5/6 adapters. Commit `d86a2af`.                       |
| 4.2 ConnectWise adapter         | ✅ done | `apps/webapp/app/modules/portal-integrations/connectwise/client.server.ts`. `listCompanies`, `listAllCompanies`, `getCompany`. Commit `f1fc64c`. |
| 4.3 Company sync service (lazy) | ❌ TODO | Next up. Will upsert into `Organization` by `portalTenantId` + optionally `connectwiseCompanyId`.                                                |
| 4.4 Nightly refresh cron        | ❌ TODO | Depends on 4.3 and Shelf's existing scheduler pattern.                                                                                           |

## Stage 5 — Device sync (ImmyBot + NinjaRMM)

| Chunk                       | Status  | Notes |
| --------------------------- | ------- | ----- |
| 5.1 Device → Asset mapper   | ❌ TODO |       |
| 5.2 ImmyBot adapter + sync  | ❌ TODO |       |
| 5.3 NinjaRMM adapter + sync | ❌ TODO |       |

## Stage 6 — Entra user sync

| Chunk                 | Status  | Notes |
| --------------------- | ------- | ----- |
| 6.1 Entra adapter     | ❌ TODO |       |
| 6.2 User sync service | ❌ TODO |       |

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

## Decisions still deferred (called out in the plan, unblock before coding)

- `read_only` → Shelf role mapping: the code currently maps to `BASE`, which
  lets read-only users write. Plan flags this as an open question — likely
  needs a new `READ_ONLY` Shelf role or tightening of `assertNotReadonly`.
- MAC-address storage shape for device sync (Chunk 5.1).
- Entra user keying: email vs `objectId` (Chunk 6.2).
- Breakglass user lifecycle after expiry (Chunk 2.1).
