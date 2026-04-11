-- Add MSP Portal integration columns to User and Organization tables
-- These columns support the portal-based authentication and multi-tenant
-- organization visibility introduced by the MSP Portal integration.

-- User: portal identity fields
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "portalUserId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "portalTenantId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "portalRole" TEXT;

-- User: unique constraint on portalUserId
CREATE UNIQUE INDEX IF NOT EXISTS "User_portalUserId_key"
  ON "User"("portalUserId");

-- User: index for portal lookups
CREATE INDEX IF NOT EXISTS "User_portalUserId_idx"
  ON "User"("portalUserId");

-- Organization: portal tenant fields
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "portalTenantId" TEXT;
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "portalTenantSlug" TEXT;
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "parentPortalTenantId" TEXT;

-- Organization: unique constraint on portalTenantId
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_portalTenantId_key"
  ON "Organization"("portalTenantId");

-- Organization: indexes for portal lookups
CREATE INDEX IF NOT EXISTS "Organization_portalTenantId_idx"
  ON "Organization"("portalTenantId");
CREATE INDEX IF NOT EXISTS "Organization_parentPortalTenantId_idx"
  ON "Organization"("parentPortalTenantId");
