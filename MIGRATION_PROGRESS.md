# Prisma → Supabase Migration Progress

**Branch:** `claude/review-migration-plan-wYjw6`
**Last Updated:** 2026-03-18
**Status:** Phase 3 Complete — Typecheck ✅ | Lint ✅

---

## Overall Progress

| Area                         | Total `db.` calls | Converted | Remaining | % Done |
| ---------------------------- | ----------------- | --------- | --------- | ------ |
| **Modules** (`app/modules/`) | ~245              | ~205      | 40        | 84%    |
| **Routes** (`app/routes/`)   | ~78               | 0         | 78        | 0%     |
| **Utils** (`app/utils/`)     | ~33               | 0         | 33        | 0%     |
| **Grand Total**              | ~356              | ~205      | ~152      | 58%    |

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

### Tier B: Route Files (~78 calls across 24 files)

| File                                       | Calls             |
| ------------------------------------------ | ----------------- |
| `api+/user.entity-counts.ts`               | 10                |
| `api+/get-scanned-item.$qrId.ts`           | 9                 |
| `api+/command-palette.search.ts`           | 6                 |
| `api+/asset.generate-thumbnail.ts`         | 6                 |
| `api+/public-stats.ts`                     | 4                 |
| `api+/get-scanned-barcode.$value.ts`       | 4                 |
| `api+/asset.refresh-main-image.ts`         | 3                 |
| `api+/settings.invite-user.ts`             | 3                 |
| `api+/user.change-current-organization.ts` | 3                 |
| `api+/image.$imageId.ts`                   | 3                 |
| 4x activity CSV routes                     | 2 each (8 total)  |
| 8x other API routes                        | 2 each (16 total) |
| `api+/model-filters.ts`                    | 1                 |

### Tier C: Utility Files (~33 calls across 8 files)

| File                                               | Calls |
| -------------------------------------------------- | ----- |
| `utils/csv.server.ts`                              | 7     |
| `utils/dashboard.server.ts`                        | 6     |
| `utils/sso.server.ts`                              | 6     |
| `utils/stripe.server.ts`                           | 5     |
| `utils/roles.server.ts`                            | 3     |
| `utils/subscription.server.ts`                     | 2     |
| `utils/permissions/permission.validator.server.ts` | 2     |
| `utils/note/load-user-for-notes.server.ts`         | 2     |

---

## Migration Strategy for Remaining Work

### Priority Order

1. **Tier C (Utils)** — 33 calls, 8 files. Mostly simple
   CRUD queries, quick wins.
2. **Tier B (Routes)** — 78 calls, 24 files. Many are simple
   `findUnique`/`findMany` queries that translate directly.
3. **Tier A (Module stragglers)** — 40 calls. Requires rewriting
   `WhereInput` helpers or accepting Prisma for these edge cases.

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
