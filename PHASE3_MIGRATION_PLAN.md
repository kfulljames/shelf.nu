# Phase 3: Remaining Prisma → Supabase Migration Plan

**Goal:** Convert all remaining `db.*` (Prisma) calls to `sbDb.*` (Supabase)
across module service files, then routes/utils, then remove Prisma runtime.

**Original Scope:** ~245 calls in 8 module files + ~300 in routes/utils

---

## Module Files — Progress

| #   | File                                     | Original | Remaining | Converted | Status                                      |
| --- | ---------------------------------------- | -------- | --------- | --------- | ------------------------------------------- |
| 1   | `location/bulk-select.server.ts`         | 3        | 3         | 0         | ⬜ Blocked (Prisma where helpers)           |
| 2   | `asset/bulk-operations-helper.server.ts` | 3        | 3         | 0         | ⬜ Blocked (Prisma where helpers)           |
| 3   | `audit/helpers.server.ts`                | 35       | 1         | 34        | 🟡 Only import (tx ?? db pattern)           |
| 4   | `organization/service.server.ts`         | 15       | 0         | 15        | ✅ FULLY MIGRATED                           |
| 5   | `location/service.server.ts`             | 33       | 5         | 28        | 🟡 Prisma where + deep kit includes         |
| 6   | `kit/service.server.ts`                  | 40       | 7         | 33        | 🟡 Prisma where + deep includes             |
| 7   | `asset/service.server.ts`                | 58       | 7         | 51        | 🟡 $queryRaw + Prisma where + deep includes |
| 8   | `booking/service.server.ts`              | 58       | 9         | 49        | 🟡 Prisma where + conflict conditions       |

**Total Module Calls:** 217 of 245 converted (89%)
**Remaining:** 28 actual db calls + 6 import statements

## Remaining Calls — Categorized

### Prisma WhereInput-coupled (cannot convert without rewriting helpers)

- `getAssetsWhereInput()` returns `Prisma.AssetWhereInput` — used by:
  - asset/service.server.ts: `getAssets()` findMany + count
  - location/service.server.ts: `getAssetsForLocation()` findMany
  - kit/service.server.ts: `getKitAssets()` findMany + count
- `getKitsWhereInput()` returns `Prisma.KitWhereInput` — used by:
  - kit/service.server.ts: `getKits()` findMany + count + emptyCount
  - location/service.server.ts: kits queries
- `getBookingsWhereInput()` returns booking where — used by:
  - booking/service.server.ts: `getBookings()` findMany + count, calendar queries

### $queryRaw (raw SQL)

- asset/service.server.ts: `getAdvancedPaginatedAndFilterableAssets()` — complex
  full-text search with dynamic sort/filter

### Complex nested creates with includes

- asset/service.server.ts: `createAsset()` — create with location/user/custody
  includes, `updateAsset()` — update with multi-relation includes
- booking/service.server.ts: `getBooking()` — findFirstOrThrow with merged
  dynamic includes

### Deep relation queries with some/none

- kit/service.server.ts: `getKits()` — count with `assets: { none: {} }`
- booking/service.server.ts: various findMany with nested booking conditions

## Routes & Utils (Tier 4)

85 route files still import `db` (~300+ calls).
To be planned after Prisma where helpers are addressed.

## Strategy for Remaining Items

1. **Prisma where helpers** — Rewrite `getAssetsWhereInput`, `getKitsWhereInput`,
   `getBookingsWhereInput` to return sbDb-compatible filter functions instead
   of `Prisma.WhereInput` objects. This unblocks ~15 remaining calls.

2. **$queryRaw** — Convert to Supabase RPC (stored procedure) or use
   `sbDb.rpc()` with a custom function.

3. **Complex creates with includes** — Already partially converted. Remaining
   ones can use sequential insert + select queries.

4. **Routes** — Most route db calls are simple CRUD that mirror patterns
   already converted in service files.

---

## Commits

1. `refactor: convert EASY Prisma calls to Supabase across 6 modules`
   — 1078+/529-
2. `refactor: convert MEDIUM Prisma calls to Supabase across 5 modules`
   — 1855+/953-
3. `refactor: convert HARD Prisma calls to Supabase across 5 modules`
   — 2642+/778-
