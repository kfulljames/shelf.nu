/**
 * Unified Data Access Layer
 *
 * This module is the canonical entry point for all database access in the
 * webapp. It re-exports both the Supabase client (primary) and the Prisma
 * client (fallback for queries that cannot be expressed via PostgREST).
 *
 * ## Usage
 *
 * ```ts
 * import { sbDb, db } from "~/database/data.server";
 * ```
 *
 * - **`sbDb`** — Supabase (PostgREST) client. Use for all new code and the
 *   93% of queries that have already been migrated.
 * - **`db`** — Prisma ORM client. Reserved for the ~48 queries that rely on
 *   Prisma-specific features (see below).
 *
 * ## When to use `db` (Prisma)
 *
 * Only use the Prisma client when the query requires one of these features
 * that Supabase's PostgREST JS client cannot express:
 *
 * 1. **Dynamic/generic includes** — Prisma `include` objects built at runtime
 *    from caller-supplied parameters (e.g. `getAsset({ include })`).
 * 2. **Deeply nested relation filters** — Multi-level existence checks like
 *    `user.userOrganizations.some.roles.hasSome`, `assets.some.bookings.some`
 *    with date-range overlap, or `{ isNot: null }` guards.
 * 3. **Nested relation writes** — Single-call creates/updates that
 *    connect/disconnect/upsert child records (tags, custom fields, barcodes).
 * 4. **Transaction-aware helpers** — Functions that accept `tx ?? db` to run
 *    inside an existing Prisma `$transaction` or standalone.
 * 5. **Auth-schema raw SQL** — `db.$queryRaw` on Supabase's `auth.*` tables,
 *    which are outside the public schema that PostgREST exposes.
 *
 * ## Files still using Prisma (as of 2026-03-19)
 *
 * | File | Calls | Reason |
 * |------|-------|--------|
 * | modules/booking/service.server.ts | 8 | Booking conflict detection, dynamic includes, ALL_SELECTED_KEY where |
 * | modules/asset/service.server.ts | 5 | Dynamic includes, nested relation writes, bulk import |
 * | modules/kit/service.server.ts | 4 | Dynamic includes, nested filters |
 * | modules/location/service.server.ts | 2 | Dynamic includes, nested relation filters |
 * | modules/asset/bulk-operations-helper.server.ts | 1 | $queryRaw with dynamic SQL |
 * | modules/audit/helpers.server.ts | ~20 | Transaction-aware (tx ?? db) pattern |
 * | routes/api+/get-scanned-item.$qrId.ts | 2 | Dynamic Prisma include objects |
 * | routes/api+/reminders.team-members.ts | 1 | Nested relation filters (hasSome, isNot) |
 * | utils/sso.server.ts | 2 | $queryRaw on auth.sso_domains |
 */

// Primary client — use for all new code
export { sbDb } from "./supabase.server";

// Prisma fallback — use only for queries listed above
export { db } from "./db.server";
export type { ExtendedPrismaClient } from "./db.server";
