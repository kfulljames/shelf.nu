# Prisma → Supabase Migration Progress

**Branch:** `claude/continue-project-work-s5x7o`
**Last Updated:** 2026-03-18
**Status:** Migration ceiling reached — 9 production files retain Prisma
for features Supabase PostgREST cannot express

---

## Overall Progress

| Area                         | Files with `db` | Production | Test | Notes                           |
| ---------------------------- | --------------- | ---------- | ---- | ------------------------------- |
| **Modules** (`app/modules/`) | 16              | 6          | 10   | Dynamic includes, nested writes |
| **Routes** (`app/routes/`)   | 4               | 2          | 2    | Dynamic includes, `hasSome`     |
| **Utils** (`app/utils/`)     | 1               | 1          | 0    | `$queryRaw` for auth schema     |
| **Grand Total**              | **21**          | **9**      | 12   |                                 |

12 test files contain `db` references (mock setups) that will be
cleaned up when Prisma is fully removed.

---

## Completed Work (11 commits)

### Infrastructure Created

- **`sbDb` client** — Supabase JS client at `app/database/supabase.server.ts`
- **`packages/database/src/types.ts`** — Shared TypeScript types (+300 lines)
- **27 PostgreSQL RPC functions** via migration SQL (+1000 lines)

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
| (new)     | Deep includes, relation writes, transactions, SSO          | 12 files  |
| (new)     | Module bulk ops + location service select-all migrations   | 6 files   |
| (new)     | Route cleanup: custody, palette, audit details, raw SQL    | 5 files   |
| (new)     | manage-kits booking/kit queries to Supabase                | 1 file    |

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
- **Layout routes** (`_layout+/`): ~50 files converted (all done)
- **QR routes** (`qr+/`): 5 files converted
- **Auth routes** (`_auth+/`): 3 files converted
- **Utilities**: `csv.server.ts`, `dashboard.server.ts`, `sso.server.ts`,
  `stripe.server.ts`, `subscription.server.ts`, `permission.validator.server.ts`

### Transactions → RPC Functions (27 total)

| RPC Function                            | Module     |
| --------------------------------------- | ---------- |
| `assign_kit_custody`                    | kit        |
| `release_kit_custody`                   | kit        |
| `bulk_release_custody`                  | asset      |
| `manage_kit_assets`                     | kit        |
| `manage_location_assets`                | location   |
| `manage_location_kits`                  | location   |
| `manage_booking_assets`                 | booking    |
| `manage_booking_kits`                   | booking    |
| `checkin_booking_assets`                | booking    |
| `start_audit`                           | audit      |
| `process_audit_scan`                    | audit      |
| `delete_kit`                            | kit        |
| `shelf_dashboard_asset_aggregation`     | dashboard  |
| `shelf_dashboard_assets_by_status`      | dashboard  |
| `shelf_dashboard_monthly_growth`        | dashboard  |
| `shelf_dashboard_top_custodians`        | dashboard  |
| `shelf_dashboard_location_distribution` | dashboard  |
| `shelf_user_workspaces_with_counts`     | settings   |
| `shelf_remove_audit_scan`               | audit      |
| `shelf_admin_org_with_details`          | admin      |
| `shelf_admin_user_organizations`        | admin      |
| `shelf_upsert_sso_details`              | admin/SSO  |
| `shelf_upsert_custom_tier_limit`        | admin/tier |
| + ~4 more                               | various    |

---

## Outstanding Work

### Categories DONE in PR 3

#### 4. Deep Nested Includes — DONE

All 5 deep nested includes migrated via RPCs and split queries:

- `settings.general.tsx` → `shelf_user_workspaces_with_counts` RPC
- `admin-dashboard+/org.$organizationId.tsx` → `shelf_admin_org_with_details` RPC
- `admin-dashboard+/org.$organizationId.qr-codes.tsx` → same RPC
- `admin-dashboard+/$userId.tsx` → `shelf_admin_user_organizations` RPC
- `utils/sso.server.ts` → Split Supabase queries

#### 5. Relation Writes — DONE

All 4 relation write calls migrated:

- `kits.$kitId.assets.assign-custody.tsx` → Direct inserts to `KitCustody`/`Custody`
- `admin-dashboard+/move-location-images.tsx` → `update({ imageId: null })`
- `account-details.workspace.$workspaceId.edit.tsx` → Supabase `.eq("userId", id)` filter
- `kits.$kitId.tsx` → Direct `update({ kitId: null })` + `delete()` on Custody

#### 7. Array Field Filters — DONE

Both `isEmpty`/`has` filters migrated via PostgREST array operators.

#### 8. Unmigrated Transaction — DONE

`audits.$auditId.scan.tsx` → `shelf_remove_audit_scan` RPC

#### 6. Dynamic Where Inputs & Model Access — DONE

All 3 dynamic where/model access calls migrated via RPCs:

- `bookings.overview.manage-assets.tsx` → `getFilteredAssetIds()` using `shelf_get_filtered_asset_ids` RPC
- `api+/assets.get-assets-for-bulk-qr-download.ts` → Same `getFilteredAssetIds()` pattern
- `api+/model-filters.ts` → `shelf_model_filter_search` RPC

### Remaining Work

#### 9. Raw SQL on Auth Schema (2 calls — must stay as Prisma)

| File                       | Details                                                |
| -------------------------- | ------------------------------------------------------ |
| `utils/sso.server.ts` (x2) | `$queryRaw` on `auth.sso_domains` — auth schema access |

These 2 calls access the Supabase `auth` schema which is not accessible
via the Supabase JS client. They must remain as `db.$queryRaw` until
security-definer RPCs or the Supabase Admin API can be used.

#### Module-level remaining Prisma calls (~20 calls — all KEPT AS PRISMA)

All remaining calls are documented with `// KEPT AS PRISMA:` comments
explaining why they cannot be migrated to Supabase:

- `audit/helpers.server.ts` — `tx ?? db` pattern for transaction support
- `asset/service.server.ts` — Dynamic generic includes, nested relation
  writes (customFields create/update/deleteMany), `$queryRaw` with
  dynamic Prisma.sql templates, P2002 retry logic
- `asset/bulk-operations-helper.server.ts` — Advanced mode `$queryRaw`
  with dynamic WHERE clause from `generateWhereClause()`
- `booking/service.server.ts` — Complex nested booking conflict
  conditions, dynamic where from `getBookingWhereInput`
- `location/service.server.ts` — Dynamic Prisma includes, nested
  `assets.some.bookings.some` multi-level existence filters
- `kit/service.server.ts` — Dynamic generic includes, `assets: { none: {} }`

#### Route-level remaining Prisma calls (2 files — all KEPT AS PRISMA)

- `api+/get-scanned-item.$qrId.ts` — Dynamic Prisma include objects
  built from runtime params
- `api+/reminders.team-members.ts` — Nested WHERE with
  `user: { isNot: null }`, `userOrganizations.some`, `roles.hasSome`

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
| RPC results need double cast                 | Cast with `as unknown as Type`                 |
| Supabase FK joins return arrays for 1:1      | Take `[0] ?? null` for ssoDetails-style joins  |
