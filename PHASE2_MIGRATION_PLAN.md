# Phase 2: Transaction Migration Plan

**Goal:** Convert all 21 `db.$transaction` calls to Postgres RPC functions + `sbDb.rpc()`.

**Strategy:** Easy wins first to establish patterns, then batch by module.

**Status: COMPLETE** — All 21 transactions migrated.

---

## Tier 1 — Low Complexity (7 functions)

Simple multi-table updates/deletes with no conditional logic.

| #   | Function                    | Module       | Tables                         | Ops                         | Status |
| --- | --------------------------- | ------------ | ------------------------------ | --------------------------- | ------ |
| 1   | `transferOwnership`         | organization | Organization, UserOrganization | 3 updates                   | ✅     |
| 2   | `bulkDeleteLocations`       | location     | Location, Image                | 2 deletes                   | ✅     |
| 3   | `bulkDeleteKits`            | kit          | Kit                            | 1 delete + image cleanup    | ✅     |
| 4   | `extendBooking`             | booking      | Booking                        | conflict check + update     | ✅     |
| 5   | `bulkArchiveBookings`       | booking      | Booking, BookingNote           | status update + notes       | ✅     |
| 6   | `updateKitAssets` (removal) | kit          | Custody, Asset                 | conditional delete + update | ✅     |
| 7   | `bulkUpdateAssetLocation`   | asset        | Asset, Note                    | conditional update + notes  | ✅     |

## Tier 2 — Medium Complexity (8 functions)

Multi-table operations with bulk creates and status synchronization.

| #   | Function                    | Module  | Tables               | Ops                     | Status |
| --- | --------------------------- | ------- | -------------------- | ----------------------- | ------ |
| 8   | `checkoutBooking`           | booking | Asset, Kit, Booking  | 3 bulk updates          | ✅     |
| 9   | `checkinBooking`            | booking | Asset, Kit, Booking  | 3 bulk updates          | ✅     |
| 10  | `cancelBooking`             | booking | Asset, Kit, Booking  | conditional resets      | ✅     |
| 11  | `addScannedAssetsToBooking` | booking | Booking, Asset, Kit  | connect + updates       | ✅     |
| 12  | `bulkCheckOutAssets`        | asset   | Custody, Asset, Note | create + update + notes | ✅     |
| 13  | `bulkCheckInAssets`         | asset   | Custody, Asset, Note | delete + update + notes | ✅     |
| 14  | `releaseCustody`            | kit     | Kit, Custody, Asset  | cascade release         | ✅     |
| 15  | `bulkRemoveAssetsFromKits`  | kit     | Custody, Asset, Note | 4 operations            | ✅     |

## Tier 3 — High Complexity (6 functions)

Complex conditional logic, many tables, raw SQL, or 5+ operations.

| #   | Function                | Module  | Tables                                                        | Ops                    | Status |
| --- | ----------------------- | ------- | ------------------------------------------------------------- | ---------------------- | ------ |
| 16  | `bulkDeleteBookings`    | booking | Booking, Asset, Kit, Note                                     | cascade + audit        | ✅     |
| 17  | `bulkCancelBookings`    | booking | Booking, Asset, Kit, Note, BookingNote                        | multi-cascade          | ✅     |
| 18  | `bulkAssignKitCustody`  | kit     | Kit, KitCustody, Asset, Custody, Note                         | 5 operations           | ✅     |
| 19  | `bulkReleaseKitCustody` | kit     | Kit, KitCustody, Asset, Custody, Note                         | 5 operations           | ✅     |
| 20  | `partialCheckinBooking` | booking | Asset, Kit, PartialBookingCheckin, Note, Booking, BookingNote | 6+ ops                 | ✅     |
| 21  | `updateBookingAssets`   | booking | Booking, Asset, Kit, \_AssetToBooking                         | raw SQL + conditionals | ✅     |

---

## Execution Plan

Each function follows this workflow:

1. **Write Postgres function** in a SQL migration file
2. **Update the TypeScript caller** to use `sbDb.rpc('function_name', { params })`
3. **Remove the `db.$transaction` call** and related Prisma imports if no longer needed
4. **Typecheck** after each batch

### Migration Files

All Postgres functions go into a single migration:
`packages/database/prisma/migrations/20260318024719_add_phase2_transaction_rpc_functions/migration.sql`

### Conventions

- Function names: `shelf_<module>_<operation>` (e.g., `shelf_org_transfer_ownership`)
- All functions use `SECURITY DEFINER` with `search_path = public`
- Parameters as typed function arguments
- Returns relevant data as JSON where callers need it, void otherwise
- Error handling via `RAISE EXCEPTION` mapped to ShelfError in TS

### Implementation Notes

- Functions that only did a single DB write (e.g., `bulkDeleteKits`, `bulkArchiveBookings`)
  were simplified to direct `sbDb.from().delete()`/`.update()` calls — no RPC needed.
- 19 Postgres RPC functions were created for the remaining transactions.
- Non-atomic operations (notes via `createStatusTransitionNote`/`createSystemBookingNote`)
  were moved outside the RPC since they already used sbDb independently.
- Complex returns (Prisma includes) are handled by re-fetching with Prisma after the RPC.

---

## Progress Tracking

- **Total:** 21/21 complete
- **Tier 1:** 7/7
- **Tier 2:** 8/8
- **Tier 3:** 6/6
