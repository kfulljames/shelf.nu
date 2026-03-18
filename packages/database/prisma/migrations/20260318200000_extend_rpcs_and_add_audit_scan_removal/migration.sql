-- Extend shelf_user_workspaces_with_counts to include ssoDetails and tierId
-- Also add RPC for audit scan removal transaction

---------------------------------------------------------------------------------
-- 1. Update shelf_user_workspaces_with_counts
-- Adds: ssoDetails per organization, tierId as a direct field
---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_user_workspaces_with_counts(
  p_user_id TEXT
) RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'firstName', u."firstName",
    'tierId', u."tierId",
    'tier', jsonb_build_object(
      'id', t.id::text,
      'name', t.name
    ),
    'userOrganizations', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', uo.id,
            'roles', (SELECT jsonb_agg(r) FROM unnest(uo.roles) r),
            'organization', jsonb_build_object(
              'id', o.id,
              'name', o.name,
              'type', o.type::text,
              'imageId', o."imageId",
              'userId', o."userId",
              'updatedAt', o."updatedAt",
              'enabledSso', o."enabledSso",
              'currency', o.currency::text,
              'owner', CASE
                WHEN ow.id IS NOT NULL THEN jsonb_build_object(
                  'id', ow.id,
                  'firstName', ow."firstName",
                  'lastName', ow."lastName",
                  'profilePicture', ow."profilePicture"
                )
                ELSE NULL
              END,
              'ssoDetails', (
                SELECT jsonb_build_object(
                  'id', sd.id,
                  'domain', sd.domain,
                  'organizationId', sd."organizationId",
                  'adminGroupId', sd."adminGroupId",
                  'selfServiceGroupId', sd."selfServiceGroupId",
                  'baseUserGroupId', sd."baseUserGroupId"
                )
                FROM "SsoDetails" sd
                WHERE sd."organizationId" = o.id
              ),
              '_count', jsonb_build_object(
                'assets', (SELECT COUNT(*)::int FROM "Asset" WHERE "organizationId" = o.id),
                'members', (SELECT COUNT(*)::int FROM "TeamMember" WHERE "organizationId" = o.id),
                'locations', (SELECT COUNT(*)::int FROM "Location" WHERE "organizationId" = o.id)
              )
            )
          )
        )
        FROM "UserOrganization" uo
        JOIN "Organization" o ON o.id = uo."organizationId"
        LEFT JOIN "User" ow ON ow.id = o."userId"
        WHERE uo."userId" = p_user_id
      ),
      '[]'::jsonb
    )
  )
  FROM "User" u
  LEFT JOIN "Tier" t ON t.id = u."tierId"
  WHERE u.id = p_user_id;
$$ LANGUAGE sql STABLE;

---------------------------------------------------------------------------------
-- 2. shelf_remove_audit_scan
-- Atomically removes an audit scan and recalculates session counts.
-- Replaces: db.$transaction in audits.$auditId.scan.tsx
-- Note: Does NOT create the audit note - that is handled in app code after
-- this RPC returns, so markdoc-formatted notes stay in the app layer.
---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_remove_audit_scan(
  p_session_id TEXT,
  p_asset_id TEXT,
  p_removed_by_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_scan RECORD;
  v_found_count INT;
  v_missing_count INT;
  v_unexpected_count INT;
BEGIN
  -- Find the scan by session + asset
  SELECT
    s.id AS scan_id,
    s."auditAssetId",
    aa.id AS audit_asset_id,
    aa.expected AS audit_asset_expected
  INTO v_scan
  FROM "AuditScan" s
  LEFT JOIN "AuditAsset" aa ON aa.id = s."auditAssetId"
  WHERE s."auditSessionId" = p_session_id
    AND s."assetId" = p_asset_id
  LIMIT 1;

  IF v_scan IS NULL THEN
    -- No scan found, nothing to do
    RETURN jsonb_build_object('success', true, 'noScanFound', true);
  END IF;

  -- Handle based on whether the audit asset was expected
  IF v_scan.audit_asset_expected = true THEN
    -- Expected asset was found, revert to missing
    UPDATE "AuditAsset"
    SET status = 'MISSING', "scannedAt" = NULL, "scannedById" = NULL
    WHERE id = v_scan.audit_asset_id;
  ELSIF v_scan.audit_asset_id IS NOT NULL THEN
    -- Unexpected asset, delete it
    DELETE FROM "AuditAsset" WHERE id = v_scan.audit_asset_id;
  END IF;

  -- Delete the scan
  DELETE FROM "AuditScan" WHERE id = v_scan.scan_id;

  -- Recalculate counts
  SELECT COUNT(*)::int INTO v_found_count
  FROM "AuditAsset"
  WHERE "auditSessionId" = p_session_id
    AND expected = true
    AND status = 'FOUND';

  SELECT COUNT(*)::int INTO v_missing_count
  FROM "AuditAsset"
  WHERE "auditSessionId" = p_session_id
    AND expected = true
    AND status = 'MISSING';

  SELECT COUNT(*)::int INTO v_unexpected_count
  FROM "AuditAsset"
  WHERE "auditSessionId" = p_session_id
    AND expected = false
    AND status = 'UNEXPECTED';

  -- Update session with accurate counts
  UPDATE "AuditSession"
  SET "foundAssetCount" = v_found_count,
      "missingAssetCount" = v_missing_count,
      "unexpectedAssetCount" = v_unexpected_count
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'success', true,
    'foundAssetCount', v_found_count,
    'missingAssetCount', v_missing_count,
    'unexpectedAssetCount', v_unexpected_count
  );
END;
$$ LANGUAGE plpgsql;

---------------------------------------------------------------------------------
-- 3. shelf_admin_org_with_details
-- Returns org with qrCodes (including asset/kit), owner, ssoDetails, workingHours
-- Replaces: deep nested db.organization.findFirstOrThrow in admin dashboard
---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_admin_org_with_details(
  p_organization_id TEXT
) RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'id', o.id,
    'name', o.name,
    'type', o.type::text,
    'userId', o."userId",
    'imageId', o."imageId",
    'currency', o.currency::text,
    'enabledSso', o."enabledSso",
    'updatedAt', o."updatedAt",
    'createdAt', o."createdAt",
    'workspaceDisabled', o."workspaceDisabled",
    'barcodesEnabled', o."barcodesEnabled",
    'auditsEnabled', o."auditsEnabled",
    'owner', jsonb_build_object(
      'id', ow.id,
      'firstName', ow."firstName",
      'lastName', ow."lastName",
      'email', ow.email,
      'profilePicture', ow."profilePicture"
    ),
    'ssoDetails', (
      SELECT jsonb_build_object(
        'id', sd.id,
        'domain', sd.domain,
        'organizationId', sd."organizationId",
        'adminGroupId', sd."adminGroupId",
        'selfServiceGroupId', sd."selfServiceGroupId",
        'baseUserGroupId', sd."baseUserGroupId"
      )
      FROM "SsoDetails" sd
      WHERE sd."organizationId" = o.id
    ),
    'workingHours', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', wh.id,
          'dayOfWeek', wh."dayOfWeek",
          'startTime', wh."startTime",
          'endTime', wh."endTime",
          'organizationId', wh."organizationId"
        )
      )
      FROM "WorkingHours" wh
      WHERE wh."organizationId" = o.id
    ),
    'qrCodes', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', qr.id,
            'createdAt', qr."createdAt",
            'updatedAt', qr."updatedAt",
            'assetId', qr."assetId",
            'kitId', qr."kitId",
            'organizationId', qr."organizationId",
            'userId', qr."userId",
            'asset', CASE
              WHEN a.id IS NOT NULL THEN jsonb_build_object(
                'id', a.id,
                'title', a.title
              )
              ELSE NULL
            END,
            'kit', CASE
              WHEN k.id IS NOT NULL THEN jsonb_build_object(
                'id', k.id,
                'name', k.name
              )
              ELSE NULL
            END
          )
        )
        FROM "Qr" qr
        LEFT JOIN "Asset" a ON a.id = qr."assetId"
        LEFT JOIN "Kit" k ON k.id = qr."kitId"
        WHERE qr."organizationId" = o.id
      ),
      '[]'::jsonb
    )
  )
  FROM "Organization" o
  JOIN "User" ow ON ow.id = o."userId"
  WHERE o.id = p_organization_id;
$$ LANGUAGE sql STABLE;

---------------------------------------------------------------------------------
-- 4. shelf_admin_user_organizations
-- Returns user organizations with ssoDetails and SSO user counts.
-- Replaces: db.userOrganization.findMany in admin-dashboard/$userId.tsx
---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_admin_user_organizations(
  p_user_id TEXT
) RETURNS JSONB AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'roles', (SELECT jsonb_agg(r) FROM unnest(uo.roles) r),
        'organization', jsonb_build_object(
          'id', o.id,
          'name', o.name,
          'type', o.type::text,
          'userId', o."userId",
          'enabledSso', o."enabledSso",
          'workspaceDisabled', o."workspaceDisabled",
          'createdAt', o."createdAt",
          'ssoDetails', (
            SELECT jsonb_build_object(
              'id', sd.id,
              'domain', sd.domain,
              'organizationId', sd."organizationId",
              'adminGroupId', sd."adminGroupId",
              'selfServiceGroupId', sd."selfServiceGroupId",
              'baseUserGroupId', sd."baseUserGroupId"
            )
            FROM "SsoDetails" sd
            WHERE sd."organizationId" = o.id
          ),
          'userOrganizations', COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object('userId', uo2."userId")
              )
              FROM "UserOrganization" uo2
              JOIN "User" u2 ON u2.id = uo2."userId"
              WHERE uo2."organizationId" = o.id
                AND u2.sso = true
            ),
            '[]'::jsonb
          )
        )
      )
    ),
    '[]'::jsonb
  )
  FROM "UserOrganization" uo
  JOIN "Organization" o ON o.id = uo."organizationId"
  WHERE uo."userId" = p_user_id;
$$ LANGUAGE sql STABLE;

---------------------------------------------------------------------------------
-- 5. shelf_upsert_sso_details
-- Upserts SSO details for an organization.
-- Replaces: db.organization.update with ssoDetails upsert
---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_upsert_sso_details(
  p_organization_id TEXT,
  p_domain TEXT,
  p_admin_group_id TEXT,
  p_self_service_group_id TEXT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO "SsoDetails" (id, "organizationId", domain, "adminGroupId", "selfServiceGroupId")
  VALUES (gen_random_uuid()::text, p_organization_id, p_domain, p_admin_group_id, p_self_service_group_id)
  ON CONFLICT ("organizationId")
  DO UPDATE SET
    domain = EXCLUDED.domain,
    "adminGroupId" = EXCLUDED."adminGroupId",
    "selfServiceGroupId" = EXCLUDED."selfServiceGroupId";
END;
$$ LANGUAGE plpgsql;

---------------------------------------------------------------------------------
-- 6. shelf_upsert_custom_tier_limit
-- Upserts custom tier limit for a user.
-- Replaces: db.customTierLimit.upsert
---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_upsert_custom_tier_limit(
  p_user_id TEXT,
  p_max_organizations INT,
  p_is_enterprise BOOLEAN
) RETURNS VOID AS $$
BEGIN
  INSERT INTO "CustomTierLimit" (id, "userId", "maxOrganizations", "isEnterprise")
  VALUES (gen_random_uuid()::text, p_user_id, p_max_organizations, p_is_enterprise)
  ON CONFLICT ("userId")
  DO UPDATE SET
    "maxOrganizations" = EXCLUDED."maxOrganizations",
    "isEnterprise" = EXCLUDED."isEnterprise";
END;
$$ LANGUAGE plpgsql;
