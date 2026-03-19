# AssetMesh ↔ Shelf.nu Integration Plan

> **Status:** Planning
> **Overall Confidence:** ~95%
> **Repository:** [assetmesh-io](https://github.com/Stealth-Peanut/assetmesh-io)
> **Date:** 2026-03-19

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Data Model](#data-model)
4. [Multi-Tenancy / MSP Model](#multi-tenancy--msp-model)
5. [Authentication & SSO](#authentication--sso)
6. [Golden Record Ingestion](#golden-record-ingestion)
7. [Bidirectional Sync](#bidirectional-sync)
8. [Write-Back Queue](#write-back-queue)
9. [Sync Lifecycle](#sync-lifecycle)
10. [Field Locking & Editability](#field-locking--editability)
11. [Locations](#locations)
12. [Service Requests](#service-requests)
13. [Client User Experience](#client-user-experience)
14. [Tenant List Page (MSP View)](#tenant-list-page-msp-view)
15. [QR / Existing Features](#qr--existing-features)
16. [Trigger.dev](#triggerdev)
17. [DB Schema Design](#db-schema-design)
18. [Confidence Matrix](#confidence-matrix)
19. [Open Questions & Risks](#open-questions--risks)

---

## Executive Summary

AssetMesh is a Tier-0 (T0) aggregation layer that pulls device and
asset data from RMM/PSA tools (ConnectWise, NinjaRMM, etc.) and
produces a **golden record** — a normalized, deduplicated, enriched
representation of each asset. Shelf.nu consumes these golden records
as the user-facing asset management platform.

This document defines the full integration plan between AssetMesh
and Shelf.nu, covering data flow, multi-tenancy, sync, auth, and
the MSP/client user experience.

---

## Architecture Overview

```
┌─────────────┐      ┌──────────────┐      ┌───────────────┐
│  RMM / PSA  │─────▶│  AssetMesh   │─────▶│   Shelf.nu    │
│  (CW, Ninja │      │  (Tier-0)    │      │  (User-facing │
│   Datto..)  │      │              │◀─────│   platform)   │
└─────────────┘      └──────────────┘      └───────────────┘
                      golden records ──▶    ingestion API
                      ◀── edits             write-back API
```

### Key Architectural Decisions

- **Separate databases**: AssetMesh and Shelf.nu each maintain
  their own database. No shared DB.
- **API bridge**: Communication via REST APIs between the two
  systems.
- **AssetMesh pushes** delta golden records → Shelf.nu ingestion
  API.
- **Shelf.nu pushes** user edits back → AssetMesh T0 API (async
  queue).
- **Per-org API key auth** for inter-service communication.
- **Trigger.dev** is T0-only (AssetMesh side) — Shelf.nu does not
  run Trigger.dev.

---

## Data Model

### Core Principles

- **Generic, source-agnostic** integration tables — not
  CW-specific or Ninja-specific.
- **Golden record ID** as the stable match key across systems.
- **Upsert on sync** — new records are created, existing records
  are updated.
- **Archive on disappear** — assets removed from source are
  archived, not deleted.
- **Key fields as custom fields** + JSON metadata blob for
  extended data.
- **Configurable category mapping** — RMM categories map to
  Shelf.nu categories via config.
- **Full audit log** for all sync operations.
- **Conflict flagging** for bidirectional sync collisions.

### OrgType Enum

```
enum OrgType {
  MSP      // Managed Service Provider (parent org)
  CLIENT   // Client/tenant org (managed by MSP)
}
```

### Field Strategy

| Field Type                                      | Storage            | Editable in Shelf?   |
| ----------------------------------------------- | ------------------ | -------------------- |
| Core asset fields (name, serial, model, etc.)   | Dedicated columns  | Locked (RMM-sourced) |
| Extended RMM fields (warranty, last seen, etc.) | Custom fields      | Locked (RMM-sourced) |
| Shelf-native fields (notes, tags, custodian)    | Dedicated columns  | Yes                  |
| Unmapped source data                            | JSON metadata blob | Read-only            |

---

## Multi-Tenancy / MSP Model

### Model: Dropsuite-style

- MSP admin sees a **tenant list page** → clicks into a client
  org.
- Each client org is a **separate Shelf.nu organization**.
- **Lazy provisioning**: client org is created on first access
  by MSP admin.
- MSP admin gets **admin role** in client orgs automatically.

### Org Hierarchy

```
MSP Org (parent)
├── Client Org A
├── Client Org B
└── Client Org C
```

- MSP org holds configuration, sync settings, API keys.
- Client orgs hold assets, locations, team members.
- Data isolation enforced at the org level (existing Shelf.nu
  RLS model).

---

## Authentication & SSO

### Inter-Service Auth

- **Per-org API keys** for AssetMesh ↔ Shelf.nu communication.
- API keys scoped to specific organizations.
- Key rotation supported.

### User Auth

- **Microsoft OAuth** for client users (pre-provisioned only).
- Users must be pre-provisioned in Shelf.nu before they can
  log in — no self-registration.
- **CW contacts → Team Members** + optional Users:
  - Rule-based mapping by CW contact type.
  - Some contacts become full Users (can log in).
  - Others become Team Members only (assignable but no login).

---

## Golden Record Ingestion

### Flow

```
AssetMesh ──(delta push)──▶ Shelf.nu Ingestion API
                            │
                            ├── Validate golden record
                            ├── Match by golden_record_id
                            ├── Upsert asset
                            ├── Map category
                            ├── Map location
                            ├── Lock RMM-sourced fields
                            ├── Write audit log
                            └── Return result
```

### Ingestion API Contract

- **Endpoint**: `POST /api/integrations/ingest`
- **Auth**: Org-scoped API key in header
- **Payload**: Array of golden records (batch support)
- **Response**: Per-record success/failure with IDs

### Matching Strategy

1. Match by `golden_record_id` (stable, source-agnostic ID
   from AssetMesh).
2. If no match → create new asset.
3. If match found → upsert (update changed fields only).
4. If asset disappears from source → archive (soft delete).

---

## Bidirectional Sync

### Direction: Shelf.nu → AssetMesh (Write-Back)

- **All mapped fields** sync back via Shelf → T0 API.
- Only Shelf-editable fields are written back (not locked RMM
  fields).
- Async with queue + status indicator.
- Conflicts flagged for manual resolution.

### Direction: AssetMesh → Shelf.nu (Golden Record Push)

- Delta push: only changed records since last sync.
- Full sync available as manual trigger.
- Configurable sync interval.

### Conflict Resolution

- **Last-write-wins** as default for non-critical fields.
- **Conflict flagging** for fields edited on both sides since
  last sync.
- Conflicts surfaced in sync log for MSP admin review.
- Manual resolution UI (pick Shelf value or source value).

---

## Write-Back Queue

### Design

```
Shelf.nu User Edit
      │
      ▼
Write-Back Queue (DB table)
      │
      ▼
Async Worker picks up job
      │
      ▼
POST to AssetMesh T0 API
      │
      ├── Success → mark complete, update sync timestamp
      └── Failure → retry with backoff, flag after max retries
```

### Queue Table Schema

```sql
CREATE TABLE write_back_queue (
  id              UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  asset_id        UUID NOT NULL,
  golden_record_id TEXT NOT NULL,
  field_changes   JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | processing | completed | failed | conflict
  attempts        INT DEFAULT 0,
  max_attempts    INT DEFAULT 3,
  last_error      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  created_by      UUID  -- user who made the edit
);
```

### Status Indicator

- UI shows sync status per asset (synced / pending / failed).
- MSP admin can view full queue status.

### Open Item

- Confirm conflict resolution strategy for edge cases
  (simultaneous edits on both sides within same sync window).

---

## Sync Lifecycle

### Delta Push

1. AssetMesh tracks `last_sync_at` per org.
2. On sync trigger, queries all golden records modified since
   `last_sync_at`.
3. Pushes delta to Shelf.nu ingestion API.
4. Updates `last_sync_at` on success.

### Archive

- Assets that disappear from all sources are marked as archived
  in Shelf.nu.
- Archived assets are hidden by default but recoverable.
- Archive is reversible if asset reappears in source.

### Upsert

- Existing assets updated field-by-field (only changed fields).
- New assets created with full field set.
- Category and location mappings applied during upsert.

### Sync Log

- Every sync operation logged with:
  - Timestamp
  - Org ID
  - Records created / updated / archived / failed
  - Duration
  - Errors (if any)
- Visible to MSP admins in tenant detail view.

### Audit Trail

- Every field change logged with:
  - Old value → new value
  - Source (RMM sync vs. user edit)
  - Timestamp
  - User (if manual edit)

---

## Field Locking & Editability

### Rules

| Source                  | Locked in Shelf? | Editable in Shelf?       | Syncs Back? |
| ----------------------- | ---------------- | ------------------------ | ----------- |
| RMM (via golden record) | Yes              | No                       | N/A         |
| Shelf-native            | No               | Yes                      | Yes         |
| Both (mapped)           | Conditional      | Yes (with conflict flag) | Yes         |

### UI Behavior

- Locked fields show a lock icon and are non-editable.
- Tooltip on locked fields: "This field is managed by [source
  name]".
- Shelf-native fields behave as normal.
- Mapped editable fields show sync status indicator.

---

## Locations

### Bidirectional Location Sync

- **CW Sites** and **NinjaRMM Locations** map to Shelf.nu
  Locations.
- Locations synced from source → Shelf.nu during golden record
  ingestion.
- Location edits in Shelf.nu → write back to source via T0 API.
- Location matching by name + address (fuzzy match with
  confirmation).

### Mapping

```
CW Site          → Shelf.nu Location
NinjaRMM Site    → Shelf.nu Location
Datto Site       → Shelf.nu Location
```

- New locations created automatically on first sync.
- Location merging handled manually by MSP admin if duplicates
  detected.

---

## Service Requests

### Flow

```
Shelf.nu User → Creates Service Request
      │
      ▼
Shelf.nu → AssetMesh T0 API
      │
      ▼
AssetMesh → ConnectWise (creates CW ticket)
```

### Implementation

- Service request form in Shelf.nu.
- Submitted to AssetMesh via T0 API.
- AssetMesh routes to CW (or other PSA) to create a ticket.
- Ticket ID linked back to Shelf.nu for tracking.
- **Rewst iframe**: TBD — may embed Rewst workflow UI for
  advanced service request flows. UI deferred to later phase.

### Confidence: 90%

- Core flow is clear.
- Rewst iframe integration details TBD.
- UI for service requests deferred to later phase.

---

## Client User Experience

### Landing

- Client users land **directly in their org** — standard
  Shelf.nu landing page.
- No tenant selector (that's MSP-only).

### Role-Based Access

| Role        | Capabilities                                                                  |
| ----------- | ----------------------------------------------------------------------------- |
| **Manager** | Full asset management, location management, team management, service requests |
| **User**    | View own assigned assets, create service requests                             |

### Key UX Points

- Microsoft OAuth login (pre-provisioned only).
- Assets show source badge (CW, Ninja, etc.) and lock icons on
  RMM-sourced fields.
- Service request button on asset detail page.
- Rewst iframe TBD for advanced workflows.

---

## Tenant List Page (MSP View)

### Layout

MSP admin sees a dashboard with all client orgs:

| Column       | Description                       |
| ------------ | --------------------------------- |
| Client Name  | Org name (click to enter)         |
| Device Count | Total active assets               |
| Alerts       | Count of sync errors or conflicts |
| Last Sync    | Timestamp of last successful sync |
| Status       | Connected / Disconnected / Error  |

### Features

- Click client name → enter client org as admin.
- Sync log accessible per tenant.
- Bulk actions (trigger sync, view errors).
- Device count aggregation from latest sync.
- Alert badges for sync failures or conflicts.

---

## QR / Existing Features

### Preserved

All existing Shelf.nu features remain intact:

- QR code generation and scanning.
- Asset tagging and categorization.
- Booking system.
- Custom fields.
- Image attachments.
- CSV import/export.
- Team management.
- Location management.

### Integration Points

- QR codes work on synced assets (golden record assets get QR
  codes like any other asset).
- Custom fields from golden records are read-only but visible.
- Bookings work on synced assets normally.

---

## Trigger.dev

### Scope: AssetMesh (T0) Only

- Trigger.dev runs **only** on the AssetMesh side.
- Shelf.nu does **not** run Trigger.dev.
- Used for:
  - Scheduled sync jobs (pull from RMM/PSA sources).
  - Golden record computation and deduplication.
  - Delta push to Shelf.nu ingestion API.
  - Write-back processing from Shelf.nu edits.

### Why T0-Only

- Keeps Shelf.nu's architecture unchanged.
- AssetMesh owns the sync orchestration.
- Shelf.nu only needs to expose ingestion + write-back APIs.

---

## DB Schema Design

### New Tables (Shelf.nu Side)

```prisma
// Integration source configuration per org
model IntegrationSource {
  id              String   @id @default(cuid())
  organizationId  String
  organization    Organization @relation(fields: [organizationId],
                    references: [id])
  name            String   // "connectwise", "ninjarmm", etc.
  displayName     String   // "ConnectWise Manage"
  apiKeyHash      String   // hashed API key for this source
  isActive        Boolean  @default(true)
  lastSyncAt      DateTime?
  syncIntervalMin Int      @default(15)
  config          Json?    // source-specific configuration
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  syncLogs        SyncLog[]
  @@unique([organizationId, name])
}

// Sync log per integration run
model SyncLog {
  id                String   @id @default(cuid())
  integrationSourceId String
  integrationSource IntegrationSource @relation(
    fields: [integrationSourceId], references: [id])
  organizationId    String
  status            String   // success | partial | failed
  recordsCreated    Int      @default(0)
  recordsUpdated    Int      @default(0)
  recordsArchived   Int      @default(0)
  recordsFailed     Int      @default(0)
  duration          Int?     // milliseconds
  errors            Json?    // array of error details
  startedAt         DateTime @default(now())
  completedAt       DateTime?
}

// Golden record mapping (asset ↔ external source record)
model ExternalAssetLink {
  id              String   @id @default(cuid())
  assetId         String
  asset           Asset    @relation(fields: [assetId],
                    references: [id])
  organizationId  String
  goldenRecordId  String   // stable ID from AssetMesh
  sourceName      String   // "connectwise", "ninjarmm"
  sourceRecordId  String   // original ID in source system
  lockedFields    String[] // fields locked from editing
  metadata        Json?    // unmapped source data
  lastSyncedAt    DateTime?
  syncStatus      String   @default("synced")
  // synced | pending | conflict
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([organizationId, goldenRecordId])
  @@index([assetId])
  @@index([organizationId, sourceName])
}

// Write-back queue for Shelf → AssetMesh edits
model WriteBackQueue {
  id              String   @id @default(cuid())
  organizationId  String
  assetId         String
  goldenRecordId  String
  fieldChanges    Json     // { field: { old, new } }
  status          String   @default("pending")
  // pending | processing | completed | failed | conflict
  attempts        Int      @default(0)
  maxAttempts     Int      @default(3)
  lastError       String?
  createdAt       DateTime @default(now())
  processedAt     DateTime?
  createdBy       String?  // userId
}

// Audit log for all sync and edit operations
model IntegrationAuditLog {
  id              String   @id @default(cuid())
  organizationId  String
  assetId         String?
  action          String
  // sync_create | sync_update | sync_archive |
  // user_edit | write_back | conflict_resolved
  source          String   // "assetmesh" | "shelf" | "user"
  fieldChanges    Json?    // { field: { old, new } }
  userId          String?  // if user-initiated
  metadata        Json?    // additional context
  createdAt       DateTime @default(now())

  @@index([organizationId, createdAt])
  @@index([assetId])
}

// MSP ↔ Client org relationship
model OrgRelationship {
  id              String   @id @default(cuid())
  parentOrgId     String   // MSP org
  childOrgId      String   // Client org
  parentOrg       Organization @relation("ParentOrg",
    fields: [parentOrgId], references: [id])
  childOrg        Organization @relation("ChildOrg",
    fields: [childOrgId], references: [id])
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())

  @@unique([parentOrgId, childOrgId])
}
```

### Modifications to Existing Models

```prisma
// Add to Organization model
model Organization {
  // ... existing fields ...
  orgType           OrgType @default(STANDARD)
  parentRelations   OrgRelationship[] @relation("ChildOrg")
  childRelations    OrgRelationship[] @relation("ParentOrg")
  integrationSources IntegrationSource[]
}

enum OrgType {
  STANDARD  // Regular shelf.nu org
  MSP       // Managed Service Provider
  CLIENT    // Client managed by MSP
}

// Add to Asset model
model Asset {
  // ... existing fields ...
  externalLinks     ExternalAssetLink[]
}
```

---

## Confidence Matrix

| Section                     | Confidence | Notes                                                             |
| --------------------------- | ---------- | ----------------------------------------------------------------- |
| Multi-tenancy / MSP model   | 95%        | Done                                                              |
| Golden record ingestion     | 95%        | Done                                                              |
| DB Schema design            | 95%        | Golden record + CW extras, key fields + JSON blob, audit log      |
| Field locking / editability | 95%        | Done                                                              |
| Auth / SSO                  | 95%        | Done                                                              |
| Bidirectional sync          | 93%        | All mapped fields write back via Shelf → T0 API, async with queue |
| Client user experience      | 95%        | Done                                                              |
| Tenant list page            | 95%        | Device counts + alerts + sync log                                 |
| Sync lifecycle              | 95%        | Delta push, archive, upsert, sync log, audit trail                |
| Service requests            | 90%        | Shelf → T0 → CW. Rewst iframe TBD. UI deferred                    |
| Trigger.dev                 | 95%        | T0 only                                                           |
| Locations                   | 95%        | Bidirectional. CW/Ninja sites map to Shelf Locations              |
| QR / existing features      | 95%        | Done                                                              |
| Write-back queue            | 90%        | Async queue + status indicator. Confirm conflict resolution       |
| **Overall**                 | **~94%**   |                                                                   |

---

## Open Questions & Risks

### To Confirm

1. **Write-back conflict resolution**: What happens when the
   same field is edited in both Shelf.nu and the RMM source
   within the same sync window? Current plan: flag for manual
   resolution. Need to confirm this UX.

2. **Rewst iframe**: Service request UI may embed Rewst workflow
   iframe. Details TBD — deferred to later phase.

3. **Category mapping configuration**: Where does the MSP admin
   configure category mappings? Separate admin UI or config
   file?

4. **Location fuzzy matching**: What threshold for auto-matching
   locations by name/address? Need to define matching algorithm.

5. **API rate limits**: What rate limits should the ingestion
   API enforce? Need to consider large MSPs with thousands of
   devices.

### Risks

| Risk                                | Impact         | Mitigation                                            |
| ----------------------------------- | -------------- | ----------------------------------------------------- |
| Sync volume at scale (large MSPs)   | Performance    | Batch processing, queue-based ingestion               |
| Conflict resolution UX complexity   | User confusion | Clear UI indicators, sensible defaults                |
| API key management across many orgs | Security       | Key rotation, scoped permissions                      |
| Location deduplication              | Data quality   | Manual merge UI for MSP admins                        |
| Write-back failures                 | Data drift     | Retry with backoff, alerting, manual queue inspection |

---

## Implementation Phases (Suggested)

### Phase 1: Foundation

- [ ] Add `OrgType` enum and `OrgRelationship` model
- [ ] Create `IntegrationSource` and `ExternalAssetLink` models
- [ ] Build ingestion API endpoint
- [ ] Implement golden record upsert logic
- [ ] Field locking UI

### Phase 2: Sync & Write-Back

- [ ] Implement `WriteBackQueue` and async worker
- [ ] Build sync log UI for MSP admins
- [ ] Implement `IntegrationAuditLog`
- [ ] Delta sync support
- [ ] Archive-on-disappear logic

### Phase 3: MSP Experience

- [ ] Tenant list page with device counts and alerts
- [ ] Lazy provisioning of client orgs
- [ ] MSP admin → client org navigation
- [ ] Sync status dashboard

### Phase 4: Client Experience & Locations

- [ ] Microsoft OAuth integration
- [ ] CW contacts → Team Members/Users mapping
- [ ] Bidirectional location sync
- [ ] Location matching and merge UI

### Phase 5: Service Requests

- [ ] Service request form in Shelf.nu
- [ ] Shelf → T0 → CW ticket creation
- [ ] Ticket tracking and status display
- [ ] Rewst iframe (if applicable)
