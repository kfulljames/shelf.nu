# Prisma → Supabase Migration Progress

**Branch:** `claude/review-migration-plan-wYjw6`
**Last Updated:** 2026-03-18
**Status:** Phase 4 Complete — Typecheck ✅ | Lint ✅

---

## Overall Progress

| Area                         | Total `db.` calls | Converted | Remaining | % Done |
| ---------------------------- | ----------------- | --------- | --------- | ------ |
| **Modules** (`app/modules/`) | ~245              | ~205      | 40        | 84%    |
| **Routes** (`app/routes/`)   | ~260              | ~72       | 188       | 28%    |
| **Utils** (`app/utils/`)     | ~33               | ~26       | 7         | 79%    |
| **Grand Total**              | ~538              | ~303      | ~235      | 56%    |

Note: Route file count revised upward — initial scan missed
`_layout+/` route files which contain significant `db.` usage.

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
| booking/service.server.ts      | 58             | 49        | 9         | Booking conflict conditions, bulk ops |

**Also has remaining calls:**

- `asset/bulk-operations-helper.server.ts`: 3 calls
- `location/bulk-select.server.ts`: 3 calls
- `audit/helpers.server.ts`: 1 call
- `audit/worker.server.ts`: 1 call

### Phase 4 — Route + Utility Files (current branch)

Single commit converting 32 files:

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

**Kept as Prisma (with annotation comments):**

- roles.server.ts: Nested many-to-many role checks
- sso.server.ts: `$queryRaw` on auth schema
- user.change-current-organization.ts: `$executeRaw`
- reminders.team-members.ts: Deeply nested AND/hasSome

---

## Remaining Work

### Tier A: Module Stubborn Calls (~40 remaining)

Calls kept as Prisma due to genuine complexity:

- Dynamic `Prisma.WhereInput` helpers (`getAssetsWhereInput`,
  `getKitsWhereInput`, `getBookingWhereInput`) — used by bulk ops
- Generic type parameters (`T extends Prisma.KitInclude`)
- `$queryRaw` with dynamic SQL assembly
- Complex nested creates (asset + QR + custody + tags atomically)
- Booking conflict conditions with deeply nested date range
  `some`/`none` operators
- Complex `AND`/`OR` where clauses with case-insensitive `contains`
  across nested relations

### Tier B: Route Files (~188 remaining across ~69 files)

Phase 4 converted 24 API/activity routes. The remaining 188
calls are primarily in `_layout+/` route files:

| File                                                       | Calls                 |
| ---------------------------------------------------------- | --------------------- |
| `_layout+/home.tsx`                                        | 13                    |
| `_layout+/bookings.$bookingId.overview.tsx`                | 10                    |
| `_layout+/admin-dashboard+/$userId.tsx`                    | 6                     |
| `_layout+/account-details.workspace.$workspaceId.edit.tsx` | 6                     |
| `_layout+/bookings.$bookingId.overview.manage-assets.tsx`  | 6                     |
| `_layout+/kits.$kitId.assets.assign-custody.tsx`           | 5                     |
| `_layout+/admin-dashboard+/move-location-images.tsx`       | 5                     |
| `_layout+/settings.general.tsx`                            | 4                     |
| `_layout+/scanner.tsx`                                     | 4                     |
| `api+/get-scanned-item.$qrId.ts`                           | 4                     |
| ~59 other route files                                      | 2-3 each (~130 total) |

### Tier C: Utility Files (~7 remaining across 2 files)

| File                    | Calls | Reason kept                |
| ----------------------- | ----- | -------------------------- |
| `utils/sso.server.ts`   | 4     | `$queryRaw` on auth schema |
| `utils/roles.server.ts` | 3     | Nested M2M role checks     |

---

## Migration Strategy for Remaining Work

### Priority Order

1. **Tier B (Layout routes)** — 188 calls, ~69 files. Many
   are simple `findUnique`/`findMany` that translate directly.
   The largest files (home.tsx, bookings overview) are highest
   priority.
2. **Tier A (Module stragglers)** — 40 calls. Requires rewriting
   `WhereInput` helpers or accepting Prisma for edge cases.
3. **Tier C (Utils)** — 7 calls remaining, all genuinely
   require Prisma ($queryRaw, nested M2M).

### Final Cleanup (after all calls migrated)

- Remove `~/database/db.server` (Prisma client wrapper)
- Remove Prisma as a runtime dependency
- Remove `@prisma/client` from `package.json`
- Update vite config to remove Prisma browser alias

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
