-- Dashboard Aggregation RPC Functions
-- Replaces Prisma aggregate, groupBy, $queryRaw, and _count queries in home.tsx
-- and the deep nested _count query in account-details.workspace.index.tsx

--------------------------------------------------------------------------------
-- 1. shelf_dashboard_asset_aggregation
-- Returns total asset count and sum of valuations for an organization.
-- Replaces: db.asset.aggregate({ _count: { _all: true }, _sum: { valuation: true } })
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_dashboard_asset_aggregation(
  p_organization_id TEXT
) RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'totalAssets', COUNT(*)::int,
    'totalValuation', COALESCE(SUM(valuation), 0)
  )
  FROM "Asset"
  WHERE "organizationId" = p_organization_id;
$$ LANGUAGE sql STABLE;

--------------------------------------------------------------------------------
-- 2. shelf_dashboard_assets_by_status
-- Returns asset counts grouped by status for an organization.
-- Replaces: db.asset.groupBy({ by: ["status"], _count: { _all: true } })
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_dashboard_assets_by_status(
  p_organization_id TEXT
) RETURNS JSONB AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'status', status::text,
        'count', cnt
      )
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT status, COUNT(*)::int AS cnt
    FROM "Asset"
    WHERE "organizationId" = p_organization_id
    GROUP BY status
  ) sub;
$$ LANGUAGE sql STABLE;

--------------------------------------------------------------------------------
-- 3. shelf_dashboard_monthly_growth
-- Returns monthly asset creation counts for the last 12 months.
-- Replaces: db.$queryRaw with date_trunc
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_dashboard_monthly_growth(
  p_organization_id TEXT,
  p_since TIMESTAMPTZ
) RETURNS JSONB AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'monthStart', month_start,
        'assetsCreated', assets_created
      )
      ORDER BY month_start
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT date_trunc('month', "createdAt") AS month_start,
           COUNT(*)::int AS assets_created
    FROM "Asset"
    WHERE "organizationId" = p_organization_id
      AND "createdAt" >= p_since
    GROUP BY 1
  ) sub;
$$ LANGUAGE sql STABLE;

--------------------------------------------------------------------------------
-- 4. shelf_dashboard_top_custodians
-- Returns team members ordered by custody count (desc), with user info.
-- Replaces: db.teamMember.findMany with _count and orderBy _count
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_dashboard_top_custodians(
  p_organization_id TEXT,
  p_limit INT DEFAULT 20
) RETURNS JSONB AS $$
  SELECT COALESCE(
    jsonb_agg(row_data ORDER BY custody_count DESC),
    '[]'::jsonb
  )
  FROM (
    SELECT
      jsonb_build_object(
        'id', tm.id,
        'name', tm.name,
        'userId', tm."userId",
        'user', CASE
          WHEN u.id IS NOT NULL THEN jsonb_build_object(
            'firstName', u."firstName",
            'lastName', u."lastName",
            'profilePicture', u."profilePicture",
            'email', u.email
          )
          ELSE NULL
        END,
        'custodyCount', COUNT(c.id)::int
      ) AS row_data,
      COUNT(c.id)::int AS custody_count
    FROM "TeamMember" tm
    INNER JOIN "Custody" c ON c."teamMemberId" = tm.id
    LEFT JOIN "User" u ON u.id = tm."userId"
    WHERE tm."organizationId" = p_organization_id
    GROUP BY tm.id, tm.name, tm."userId",
             u.id, u."firstName", u."lastName", u."profilePicture", u.email
    HAVING COUNT(c.id) > 0
    ORDER BY COUNT(c.id) DESC
    LIMIT p_limit
  ) sub;
$$ LANGUAGE sql STABLE;

--------------------------------------------------------------------------------
-- 5. shelf_dashboard_location_distribution
-- Returns top locations ordered by asset count (desc).
-- Replaces: db.location.findMany with _count select and orderBy _count
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_dashboard_location_distribution(
  p_organization_id TEXT,
  p_limit INT DEFAULT 5
) RETURNS JSONB AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'locationId', loc.id,
        'locationName', loc.name,
        'assetCount', asset_count
      )
      ORDER BY asset_count DESC
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT l.id, l.name, COUNT(a.id)::int AS asset_count
    FROM "Location" l
    INNER JOIN "Asset" a ON a."locationId" = l.id
    WHERE l."organizationId" = p_organization_id
    GROUP BY l.id, l.name
    HAVING COUNT(a.id) > 0
    ORDER BY COUNT(a.id) DESC
    LIMIT p_limit
  ) loc;
$$ LANGUAGE sql STABLE;

--------------------------------------------------------------------------------
-- 6. shelf_user_workspaces_with_counts
-- Returns user's organizations with asset/member/location counts and owner info.
-- Replaces: deep nested db.user.findUniqueOrThrow with _count on organizations
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_user_workspaces_with_counts(
  p_user_id TEXT
) RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'firstName', u."firstName",
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
              'owner', CASE
                WHEN ow.id IS NOT NULL THEN jsonb_build_object(
                  'id', ow.id,
                  'firstName', ow."firstName",
                  'lastName', ow."lastName",
                  'profilePicture', ow."profilePicture"
                )
                ELSE NULL
              END,
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
