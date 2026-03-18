# Prisma → Supabase Migration Progress

**Branch:** `claude/review-migration-plan-wYjw6`
**Last Updated:** 2026-03-18
**Status:** ~93% complete — remaining work tracked below

---

## Overall Progress

| Area                         | Total `db.` calls | Converted | Remaining | % Done |
| ---------------------------- | ----------------- | --------- | --------- | ------ |
| **Modules** (`app/modules/`) | ~245              | ~215      | 30        | 88%    |
| **Routes** (`app/routes/`)   | ~260              | ~248      | 12        | 95%    |
| **Utils** (`app/utils/`)     | ~33               | ~30       | 3         | 91%    |
| **Grand Total**              | ~538              | ~496      | ~42       | 92%    |

Test files (`.test.ts`) contain 32 additional `db.` references
(mock setups) to clean up when Prisma is fully removed.

---

## Completed Work (8 commits)

### Infrastructure Created

- **`sbDb` client** — Supabase JS client at `app/database/supabase.server.ts`
- **`packages/database/src/types.ts`** — Shared TypeScript types (+195 lines)
- **21 PostgreSQL RPC functions** via migration SQL (+711 lines)

### Commit History

| Commit    | Description                                                | Scope     |
| --------- | ---------------------------------------------------------- | --------- |
| `9138586` | Migrated all 21 `db.$transaction` → Postgres RPC functions | 5 modules |
| `41eb5e1` | Converted EASY Prisma calls to Supabase                    | 6 modules |
| `f58ec54` | Converted MEDIUM Prisma calls to Supabase                  | 5 modules |
| `b1cfaa3` | Converted HARD Prisma calls to Supabase                    | 5 modules |
| `9ced224` | Migrated route and utility files                           | 32 files  |
| `b6acabb` | Migrated 61 route and component files                      | 61 files  |
| `7a56bb2` | Converted final simple Prisma calls                        | 4 files   |
| (new)     | Dashboard aggregation RPCs + workspace counts              | 4 files   |
| (new)     | Relation filters, \_count, array ops, role checks          | 6 files   |

### Module Services — Completed Conversions

| Module                           | Calls Converted   | Status             |
| -------------------------------- | ----------------- | ------------------ |
| `organization/service.server.ts` | 15/15             | **Fully migrated** |
| `location/service.server.ts`     | 28/33             | 5 remaining        |
| `kit/service.server.ts`          | 33/40             | 7 remaining        |
| `asset/service.server.ts`        | 51/58             | 7 remaining        |
| `booking/service.server.ts`      | 51/58             | 7 remaining        |
| `user/service.server.ts`         | ~all simple calls | Fully migrated     |
| `audit/service.server.ts`        | ~all simple calls | Fully migrated     |
| `invite/service.server.ts`       | ~all simple calls | Fully migrated     |
| `qr/service.server.ts`           | ~all simple calls | Fully migrated     |
| `update/service.server.ts`       | ~all simple calls | Fully migrated     |

### Routes — Completed Conversions

- **API routes** (`api+/`): ~25 files converted
- **Layout routes** (`_layout+/`): ~42 files converted
- **QR routes** (`qr+/`): 5 files converted
- **Auth routes** (`_auth+/`): 3 files converted
- **Utilities**: `csv.server.ts`, `dashboard.server.ts`, `sso.server.ts`,
  `stripe.server.ts`, `subscription.server.ts`, `permission.validator.server.ts`

### Transactions → RPC Functions (all 21 migrated)

| RPC Function             | Module   |
| ------------------------ | -------- |
| `assign_kit_custody`     | kit      |
| `release_kit_custody`    | kit      |
| `bulk_release_custody`   | asset    |
| `manage_kit_assets`      | kit      |
| `manage_location_assets` | location |
| `manage_location_kits`   | location |
| `manage_booking_assets`  | booking  |
| `manage_booking_kits`    | booking  |
| `checkin_booking_assets` | booking  |
| `start_audit`            | audit    |
| `process_audit_scan`     | audit    |
| `delete_kit`             | kit      |
| + ~9 more                | various  |

---

## Outstanding Work (~8 distinct operations, 9 files)

Every remaining call is tagged with `// KEPT AS PRISMA` explaining
the specific Prisma feature that prevents simple migration.

### 1. Aggregation & GroupBy — DONE

Migrated via RPC functions: `shelf_dashboard_asset_aggregation`,
`shelf_dashboard_assets_by_status`, `shelf_dashboard_monthly_growth`,
`shelf_dashboard_top_custodians`, `shelf_dashboard_location_distribution`.

### 2. `_count` in Select & OrderBy — DONE

All `_count` queries migrated via RPCs or Supabase count queries.

### 3. Nested `some`/`every` Relation Filters — DONE

Migrated via join table queries (`_AssetToBooking`, `_RoleToUser`,
`UserOrganization`) and PostgREST array operators (`cs`, `eq.{}`).

### 4. Deep Nested Includes — 3+ levels (5 calls)

| File                                                | Depth                                            |
| --------------------------------------------------- | ------------------------------------------------ |
| `settings.general.tsx`                              | user → userOrgs → org → ssoDetails/\_count/owner |
| `admin-dashboard+/org.$organizationId.tsx`          | org → qrCodes → asset + owner/sso/hours          |
| `admin-dashboard+/org.$organizationId.qr-codes.tsx` | org → qrCodes → asset/kit + owner                |
| `admin-dashboard+/$userId.tsx`                      | 3+ levels + customTierLimit upsert               |
| `utils/sso.server.ts`                               | user → userOrgs → org → ssoDetails               |

### 5. Relation Writes — connect/disconnect/upsert (4 calls)

| File                                              | Operation                                         |
| ------------------------------------------------- | ------------------------------------------------- |
| `kits.$kitId.assets.assign-custody.tsx`           | `custody: { create: { custodian: { connect } } }` |
| `admin-dashboard+/move-location-images.tsx`       | `image: { disconnect: true }`                     |
| `account-details.workspace.$workspaceId.edit.tsx` | `ssoDetails: { upsert: { create, update } }`      |
| `kits.$kitId.tsx`                                 | `custody: { disconnect, delete }`                 |

### 6. Dynamic Where Inputs & Model Access (3 calls)

| File                                             | Feature                                                    |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `bookings.overview.manage-assets.tsx`            | `getAssetsWhereInput()` → dynamic `Prisma.AssetWhereInput` |
| `api+/assets.get-assets-for-bulk-qr-download.ts` | Same `getAssetsWhereInput` pattern                         |
| `api+/model-filters.ts`                          | Dynamic model access `db[name].dynamicFindMany()`          |

### 7. Array Field Filters — isEmpty/has (2 calls)

| File                               | Filter                                                         |
| ---------------------------------- | -------------------------------------------------------------- |
| `bookings._index.tsx`              | `tag.useFor: { isEmpty: true }` / `{ has: TagUseFor.BOOKING }` |
| `bookings.$bookingId.overview.tsx` | Same pattern                                                   |

### 8. Unmigrated Transaction (1 call)

| File                       | Details                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `audits.$auditId.scan.tsx` | Multi-step audit scan removal (find → update → delete → count → update) |

### 9. Raw SQL on Auth Schema (2 calls)

| File                       | Details                                         |
| -------------------------- | ----------------------------------------------- |
| `utils/sso.server.ts` (x2) | `$queryRaw` on `auth.users` / `auth.identities` |

---

## Recommended Follow-Up PRs

### PR 1: Dashboard Aggregation RPCs — DONE

**Scope:** Categories 1 + 2 + partial 4 (11 calls)
**Result:** Created 6 RPC functions. Migrated `home.tsx` (5 calls)
and `account-details.workspace.index.tsx` (1 call).

### PR 2: Relation Filters + \_count + Array Ops — DONE

**Scope:** Categories 2 + 3 + partial 7 (12 calls)
**Result:** Migrated via join table queries, PostgREST array
operators, and split queries. 6 files updated.

### PR 3: Deep Includes → Targeted Queries

**Scope:** Category 4 (6 calls)
**Approach:** Replace deep includes with multiple focused
Supabase queries joined in app code, or create flattening views.

### PR 4: Relation Writes + Remaining Transaction → RPCs

**Scope:** Categories 5 + 8 (5 calls)
**Approach:** Create RPC functions for connect/disconnect/upsert
and the audit scan transaction.

### PR 5: Dynamic Where & Array Filters

**Scope:** Categories 6 + 7 (5 calls)
**Approach:** Refactor `getAssetsWhereInput` to build Supabase
filter chains. Replace `isEmpty`/`has` with PostgREST array ops.

### PR 6: Auth Schema Raw SQL

**Scope:** Category 9 (2 calls)
**Approach:** Use Supabase Admin API or security-definer RPCs.

---

## Final Cleanup (after all calls migrated)

- Remove `~/database/db.server` (Prisma client wrapper)
- Remove Prisma as a runtime dependency
- Remove `@prisma/client` from `package.json`
- Update vite config to remove Prisma browser alias
- Update 32 test file mocks from `db` to `sbDb`

---

## Known Type Patterns / Gotchas

| Issue                                        | Fix                                            |
| -------------------------------------------- | ---------------------------------------------- |
| Supabase `SelectQueryError` for FK relations | Cast with `as unknown as Type[]`               |
| Dynamic `.select()` string loses types       | Use string literals or explicit return types   |
| Dates return as ISO strings, not `Date`      | Cast with `new Date(field as string)`          |
| Enum types return as plain `string`          | Cast with `as EnumType`                        |
| Prisma implicit M2M join tables              | Query explicitly via `sbDb.from("_JoinTable")` |
