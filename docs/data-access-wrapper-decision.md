# Data Access Wrapper — Decision Record

**Date:** 2026-03-19
**Status:** Implemented
**Branch:** `claude/merge-assetmesh-shelf-kV8cN`

## Context

Over the past week we migrated shelf.nu's data access layer from Prisma ORM to
Supabase's PostgREST JS client (`sbDb`). The migration reached **93% completion**
(147 of 160 files). The remaining 13 files (9 production, 4 test) contain **48
Prisma `db.` calls** that cannot be converted due to technical limitations of
Supabase's JS client.

We need to proceed with merging AssetMesh (from `Stealth-Peanut/assetmesh-io`)
into shelf.nu. Spending more time on the final 7% of migration would delay the
merge with diminishing returns, since those queries genuinely require Prisma
features.

## Decision

**Create a thin unified data-access wrapper** (`data.server.ts`) that
re-exports both clients from a single canonical module, rather than finishing
the remaining 7% conversion.

### Why wrapper, not full conversion

| Factor                              | Full conversion                                       | Wrapper                 |
| ----------------------------------- | ----------------------------------------------------- | ----------------------- |
| **3 files marked "KEEP AS PRISMA"** | Would need RPC functions or raw SQL rewrites for each | Keeps working as-is     |
| **Dynamic Prisma includes**         | Cannot be expressed in PostgREST select strings       | Keeps working as-is     |
| **Transaction-aware audit helpers** | Would need Supabase RPC + plpgsql rewrite             | Keeps working as-is     |
| **Auth schema raw SQL**             | PostgREST doesn't expose `auth.*` tables              | Keeps working as-is     |
| **Risk of subtle bugs**             | High — these are the most complex queries             | Zero — no query changes |
| **Time to AssetMesh merge**         | Delayed by days                                       | Immediate               |

### Why wrapper, not just leave both imports

- **Single entry point** — New code imports from `~/database/data.server`
  instead of choosing between two files
- **Documentation in code** — The wrapper module documents exactly which
  queries use Prisma and why, so future developers don't have to investigate
- **Migration path** — If Supabase adds features (e.g., proper transaction
  support), we can convert remaining calls and eventually remove the Prisma
  re-export from this single file

## Architecture

```
apps/webapp/app/database/
├── data.server.ts        ← NEW: unified entry point
├── db.server.ts          ← Prisma client (unchanged)
└── supabase.server.ts    ← Supabase client (unchanged)
```

### Import patterns

```typescript
// NEW CODE — use the unified module
import { sbDb, db } from "~/database/data.server";

// EXISTING CODE — still works, no forced migration
import { sbDb } from "~/database/supabase.server"; // 146 files
import { db } from "~/database/db.server"; // 9 files
```

Existing imports are **not** bulk-updated. That can be done incrementally or
during the AssetMesh merge as files are touched.

## Remaining Prisma Usage (48 calls across 9 files)

### Category 1: Dynamic includes (15 calls)

Files: `asset/service.server.ts`, `kit/service.server.ts`,
`location/service.server.ts`, `booking/service.server.ts`,
`api+/get-scanned-item.$qrId.ts`

These functions accept a generic `include` parameter that callers build
dynamically. Supabase's `select()` takes a flat string — it cannot accept
runtime-constructed nested objects.

### Category 2: Deeply nested relation filters (10 calls)

Files: `booking/service.server.ts`, `location/service.server.ts`,
`api+/reminders.team-members.ts`

Queries like `assets.some.bookings.some` with date-range overlap, or
`user.userOrganizations.some.roles.hasSome(["ADMIN"])`. PostgREST filters
operate on the target table only — they cannot express multi-level existence
checks across joins.

### Category 3: Nested relation writes (3 calls)

Files: `asset/service.server.ts`

Prisma's `create`/`update` with nested `connect`, `set`, `upsert`,
`deleteMany` on child records (tags, custom fields, barcodes) in a single
atomic call. Supabase requires separate insert/update/delete calls per table.

### Category 4: Transaction-aware helpers (17 calls)

File: `audit/helpers.server.ts`

Every function uses `const client = tx ?? db` to support running inside a
Prisma `$transaction` or standalone. These are simple queries (findUnique,
create) but the transaction context binds them to Prisma.

### Category 5: Raw SQL on auth schema (3 calls)

Files: `utils/sso.server.ts`, `asset/bulk-operations-helper.server.ts`

`db.$queryRaw` on `auth.sso_domains` and dynamic SQL with joins. PostgREST
only exposes the public schema.

## Test files (4 files)

The 4 test files that still mock `db` correspond to production code that uses
Prisma. They will continue to mock `db` until/unless the production code is
converted.

- `modules/booking/service.server.test.ts`
- `modules/kit/service.server.test.ts`
- `routes/_layout+/bookings.$bookingId.overview.manage-assets.test.server.ts`
- `routes/_layout+/bookings.$bookingId.overview.manage-kits.test.server.ts`

## Next Steps

1. **Merge AssetMesh** — Proceed with integrating `Stealth-Peanut/assetmesh-io`
   into shelf.nu. New AssetMesh code should use `sbDb` from
   `~/database/data.server`.

2. **Incremental import migration** — As files are touched during the AssetMesh
   merge, update their imports to use `~/database/data.server` instead of the
   individual client modules.

3. **Future Prisma removal** — If Supabase's JS client gains transaction
   support or we add RPC wrappers for the complex queries, convert the
   remaining calls and remove the `db` re-export.

## Recovery Notes

If something goes wrong during the AssetMesh merge:

- **Both clients are independent singletons** — removing `data.server.ts` has
  zero impact on existing code. All 146 `sbDb` imports and 9 `db` imports
  continue to work from their original modules.
- **No queries were changed** — this wrapper is purely additive (re-exports
  only). Rolling it back is a single file deletion.
- **Branch state** — All migration work is on
  `claude/merge-assetmesh-shelf-kV8cN`. The `main` branch is untouched
  upstream shelf.nu code.
- **Prisma still works** — The Prisma client, schema, and migrations are fully
  intact in `packages/database/`. If we need to revert the entire Supabase
  migration, `git revert` the migration commits and restore the original
  `db` imports.
