# Prisma → Supabase Migration Progress

**Branch:** `claude/review-migration-plan-wYjw6`
**Last Updated:** 2026-03-18
**Status:** Phase 5 Complete — Typecheck ✅ | Lint ✅

---

## Overall Progress

| Area                         | Total `db.` calls | Converted | Remaining | % Done |
| ---------------------------- | ----------------- | --------- | --------- | ------ |
| **Modules** (`app/modules/`) | ~245              | ~215      | 30        | 88%    |
| **Routes** (`app/routes/`)   | ~260              | ~222      | 38        | 85%    |
| **Utils** (`app/utils/`)     | ~33               | ~28       | 5         | 85%    |
| **Grand Total**              | ~538              | ~465      | ~73       | 86%    |

Test files (`.test.ts`) contain 32 additional `db.` references
(mock setups) that will be cleaned up when Prisma is fully removed.

---

## Completed Phases

### Phase 1 — Initial Module Migration (PR #1, merged)

- Migrated 26 module files across 16 modules
- Created `sbDb` Supabase client in `~/database/supabase.server`
- Established type patterns (date casts, enum casts, relation workarounds)

### Phase 2 — Audit, Invite, User Modules (PR #2, merged)

- 65 files changed, 4,631 insertions, 3,619 deletions
- Fixed all type errors across consuming route/component files
- Fully migrated: audit, invite, user modules

### Phase 3 — Remaining Module Services (current branch)

Four commits completing the hardest module conversions:

| Commit    | Description                                                       |
| --------- | ----------------------------------------------------------------- |
| `9138586` | Migrated all 21 `db.$transaction` calls to Postgres RPC functions |
| `41eb5e1` | Converted EASY Prisma calls across 6 modules                      |
| `f58ec54` | Converted MEDIUM Prisma calls across 5 modules                    |
| `b1cfaa3` | Converted HARD Prisma calls across 5 modules                      |

**Phase 3 Results by Module:**

| Module                         | Original calls | Converted | Remaining | Notes                                 |
| ------------------------------ | -------------- | --------- | --------- | ------------------------------------- |
| organization/service.server.ts | 15             | 15        | 0         | **Fully migrated**                    |
| location/service.server.ts     | 33             | 28        | 5         | `$queryRaw`, dynamic SQL              |
| kit/service.server.ts          | 40             | 33        | 7         | Generic `Prisma.KitInclude` types     |
| asset/service.server.ts        | 58             | 51        | 7         | Complex nested creates, `$queryRaw`   |
| booking/service.server.ts      | 58             | 51        | 7         | Booking conflict conditions, bulk ops |

**Also has remaining calls:**

- `asset/bulk-operations-helper.server.ts`: 2 calls
- `location/bulk-select.server.ts`: 2 calls

### Phase 4 — Route + Utility Files (current branch)

Single commit (`9ced224`) converting 32 files:

| Area               | Files | Calls converted |
| ------------------ | ----- | --------------- |
| Utility files      | 8     | ~26             |
| API route files    | 20    | ~55             |
| Layout route files | 4     | ~17             |

**Key conversions:**

- csv.server.ts: All note export functions rewritten with
  direct Supabase queries (removed generic NoteFetcher)
- dashboard.server.ts: All 5 checklist count queries
- sso.server.ts: User lookups and org SSO check
- stripe.server.ts: User customerId lookups
- command-palette.search.ts: Full rewrite for assets,
  kits, bookings, locations search
- user.entity-counts.ts: All 9 entity count queries
- 4 activity CSV routes: Asset/booking/audit/location
  name lookups

### Phase 5 — Remaining Layout + Auth + QR Routes (current branch)

Single commit (`b6acabb`) converting 61 files:

| Area                    | Files | Calls converted |
| ----------------------- | ----- | --------------- |
| Layout route files      | 42    | ~150            |
| QR route files          | 5     | ~12             |
| Auth route files        | 2     | ~4              |
| Welcome route files     | 1     | ~2              |
| API route files         | 9     | ~18             |
| Component files         | 2     | ~4              |

**Key conversions:**

- home.tsx: 13→8 remaining (announcements, dashboard queries)
- bookings overview + manage-assets/kits: booking queries
- admin-dashboard files: user/org/QR admin queries
- settings files: org, team, NRM queries
- audits files: audit session, scan, note queries
- kits/locations files: custody, scan, note queries
- scanner.tsx: scanned item lookups
- QR routes: claim, link, contact-owner queries
- auth routes: invite acceptance, password reset
- healthcheck: simple user count query

---

## Remaining Work (~73 production calls across 27 files)

### Module Files (30 calls across 6 files)

| File                                   | Calls | Reason kept                                |
| -------------------------------------- | ----- | ------------------------------------------ |
| `booking/service.server.ts`            | 7     | Conflict conditions, nested `some`/`none`  |
| `asset/service.server.ts`              | 7     | Complex nested creates, `$queryRaw`        |
| `kit/service.server.ts`                | 7     | Generic `Prisma.KitInclude` types          |
| `location/service.server.ts`           | 5     | `$queryRaw`, dynamic SQL                   |
| `asset/bulk-operations-helper.server`  | 2     | Dynamic `Prisma.WhereInput`                |
| `location/bulk-select.server.ts`       | 2     | Dynamic `Prisma.WhereInput`                |

### Route Files (38 calls across 19 files)

| File                                             | Calls | Reason kept                            |
| ------------------------------------------------ | ----- | -------------------------------------- |
| `_layout+/home.tsx`                              | 8     | Complex includes, nested relations     |
| `_layout+/bookings.$bookingId.overview.tsx`      | 6     | Booking with nested assets/kits        |
| `_layout+/admin-dashboard+/move-location-images` | 3     | Batch image processing                 |
| `_layout+/bookings.overview.manage-assets`       | 2     | Dynamic where conditions               |
| `_layout+/bookings.overview.manage-kits`         | 2     | Dynamic where conditions               |
| `_layout+/kits.$kitId.assets.assign-custody`     | 2     | Complex kit queries                    |
| `_layout+/kits.$kitId.tsx`                       | 2     | Kit with dynamic includes              |
| `_layout+/audits.$auditId.scan.tsx`              | 2     | Audit asset details                    |
| `_layout+/audits.scan.$auditAssetId.details`     | 2     | Audit scan details                     |
| `api+/command-palette.search.ts`                 | 2     | Dynamic search with `some`/`contains`  |
| `api+/get-scanned-item.$qrId.ts`                | 2     | Complex scanned item resolution        |
| 8 other route files                              | 1 ea  | Various kept-as-Prisma patterns        |

### Utility Files (5 calls across 2 files)

| File                    | Calls | Reason kept                  |
| ----------------------- | ----- | ---------------------------- |
| `utils/sso.server.ts`   | 3     | `$queryRaw` on auth schema   |
| `utils/roles.server.ts` | 2     | Nested M2M role checks       |

---

## Categories of Remaining Calls

All remaining 73 calls are kept as Prisma due to one of these:

1. **`$queryRaw` / `$executeRaw`** (~10 calls) — Direct SQL on
   auth schema or dynamic SQL assembly. Would need Supabase
   `rpc()` or raw `postgres.js` client.

2. **Dynamic `Prisma.WhereInput` builders** (~12 calls) —
   `getAssetsWhereInput`, `getKitsWhereInput`,
   `getBookingWhereInput` helpers that construct where clauses
   from search params. Central to the bulk-ops pattern.

3. **Nested `some`/`none`/`every` operators** (~15 calls) —
   Prisma-specific relation filters (e.g., booking conflict
   detection with nested date range checks). No Supabase
   PostgREST equivalent.

4. **Generic type parameters** (~8 calls) — Functions accepting
   `T extends Prisma.KitInclude` to allow callers to customize
   included relations.

5. **Complex nested creates** (~8 calls) — Atomic creation of
   entity + related records (asset + QR + custody + tags).

6. **Complex includes with 3+ nesting levels** (~20 calls) —
   Booking→assets→custody→teamMember chains that Supabase
   typed client can't resolve.

---

## Migration Strategy for Remaining Work

### Approach Options

1. **RPC functions** — Write Postgres functions for the complex
   queries and call via `sbDb.rpc()`. Best for `$queryRaw` and
   complex nested creates.

2. **View-based approach** — Create Postgres views that flatten
   nested joins, then query views via Supabase. Best for deep
   includes.

3. **Accept Prisma for edge cases** — Keep ~20-30 genuinely
   complex calls in Prisma while removing Prisma from simpler
   paths. This delays full removal but avoids rewriting core
   business logic.

### Final Cleanup (after all calls migrated)

- Remove `~/database/db.server` (Prisma client wrapper)
- Remove Prisma as a runtime dependency
- Remove `@prisma/client` from `package.json`
- Update vite config to remove Prisma browser alias
- Update test files to mock `sbDb` instead of `db`

---

## Known Type Patterns / Gotchas

### Supabase SelectQueryError for relations

Supabase's typed client doesn't resolve FK relations in `.select()`.
Fix with `as unknown as Type[]` casts.

### Dynamic select strings lose types

If `.select()` argument is a variable (not literal), Supabase returns
`{}`. Use string literals or explicit return types.

### Dates return as strings

Supabase returns dates as ISO strings, not `Date` objects.
Cast with `new Date(field as string)`.

### Enum types return as strings

Prisma enums come back as plain `string` from Supabase.
Cast with `as EnumType`.

### Join tables for many-to-many

Prisma implicit M2M tables (e.g., `_AssetToBooking`, `_BookingToTag`)
must be queried explicitly via `sbDb.from("_JoinTable")`.
