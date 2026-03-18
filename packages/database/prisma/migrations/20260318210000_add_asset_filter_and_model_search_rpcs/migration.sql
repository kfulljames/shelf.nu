---------------------------------------------------------------------------------
-- 1. shelf_get_filtered_asset_ids
-- Returns asset IDs matching complex filter criteria including M2M tags,
-- nested custody relations, and location/category filters.
-- Replaces: getAssetsWhereInput() + db.asset.findMany in route files
---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_get_filtered_asset_ids(
  p_organization_id TEXT,
  p_search TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_category_ids TEXT[] DEFAULT NULL,
  p_tag_ids TEXT[] DEFAULT NULL,
  p_location_ids TEXT[] DEFAULT NULL,
  p_team_member_ids TEXT[] DEFAULT NULL
) RETURNS TEXT[] AS $$
DECLARE
  v_ids TEXT[];
BEGIN
  SELECT ARRAY_AGG(a.id) INTO v_ids
  FROM "Asset" a
  WHERE a."organizationId" = p_organization_id
    -- Search filter (case-insensitive title match)
    AND (p_search IS NULL OR a.title ILIKE '%' || p_search || '%')
    -- Status filter
    AND (p_status IS NULL OR a.status::text = p_status)
    -- Category filter (with "uncategorized" support)
    AND (p_category_ids IS NULL OR
         (CASE
           WHEN 'uncategorized' = ANY(p_category_ids) THEN
             a."categoryId" IS NULL
             OR a."categoryId" = ANY(p_category_ids)
           ELSE
             a."categoryId" = ANY(p_category_ids)
          END))
    -- Tag filter (with "untagged" support via M2M join table)
    AND (p_tag_ids IS NULL OR
         (CASE
           WHEN 'untagged' = ANY(p_tag_ids) THEN
             EXISTS (
               SELECT 1 FROM "_AssetToTag" att
               WHERE att."A" = a.id AND att."B" = ANY(p_tag_ids)
             )
             OR NOT EXISTS (
               SELECT 1 FROM "_AssetToTag" att WHERE att."A" = a.id
             )
           ELSE
             EXISTS (
               SELECT 1 FROM "_AssetToTag" att
               WHERE att."A" = a.id AND att."B" = ANY(p_tag_ids)
             )
          END))
    -- Location filter (with "without-location" support)
    AND (p_location_ids IS NULL OR
         (CASE
           WHEN 'without-location' = ANY(p_location_ids) THEN
             a."locationId" IS NULL
             OR a."locationId" = ANY(p_location_ids)
           ELSE
             a."locationId" = ANY(p_location_ids)
          END))
    -- Team member filter (custody + booking relations)
    AND (p_team_member_ids IS NULL OR
         (
           -- Direct custody by team member ID
           EXISTS (
             SELECT 1 FROM "Custody" c
             WHERE c."assetId" = a.id
               AND c."teamMemberId" = ANY(p_team_member_ids)
           )
           -- Custody by team member's user ID
           OR EXISTS (
             SELECT 1 FROM "Custody" c
             JOIN "TeamMember" tm ON tm.id = c."teamMemberId"
             WHERE c."assetId" = a.id
               AND tm."userId" = ANY(p_team_member_ids)
           )
           -- Booking custodian (team member or user)
           OR EXISTS (
             SELECT 1 FROM "_AssetToBooking" ab
             JOIN "Booking" b ON b.id = ab."B"
             WHERE ab."A" = a.id
               AND (
                 b."custodianTeamMemberId" = ANY(p_team_member_ids)
                 OR b."custodianUserId" = ANY(p_team_member_ids)
               )
           )
           -- "without-custody" handling
           OR (
             'without-custody' = ANY(p_team_member_ids)
             AND NOT EXISTS (
               SELECT 1 FROM "Custody" c WHERE c."assetId" = a.id
             )
           )
         ));

  RETURN COALESCE(v_ids, ARRAY[]::TEXT[]);
END;
$$ LANGUAGE plpgsql STABLE;

---------------------------------------------------------------------------------
-- 2. shelf_model_filter_search
-- Generic model search for autocomplete/filter UIs.
-- Replaces: db[name].dynamicFindMany() in api+/model-filters.ts
-- Returns JSONB array of {id, name/title/queryKey, color?, user?}
---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_model_filter_search(
  p_organization_id TEXT,
  p_model_name TEXT,
  p_query_key TEXT,
  p_query_value TEXT DEFAULT NULL,
  p_selected_values TEXT[] DEFAULT NULL,
  p_use_for TEXT DEFAULT NULL,
  p_deleted_at TEXT DEFAULT NULL,
  p_admin_owner_only BOOLEAN DEFAULT FALSE,
  p_users_only BOOLEAN DEFAULT FALSE
) RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
  v_selected TEXT[];
BEGIN
  -- Parse selected values (may be empty)
  v_selected := COALESCE(p_selected_values, ARRAY[]::TEXT[]);

  CASE p_model_name
    WHEN 'asset' THEN
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          p_query_key, t.title
        )
      ), '[]'::jsonb) INTO v_result
      FROM "Asset" t
      WHERE t."organizationId" = p_organization_id
        AND (
          t.id = ANY(v_selected)
          OR (p_query_value IS NULL OR t.title ILIKE '%' || p_query_value || '%')
        );

    WHEN 'category' THEN
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          p_query_key, CASE p_query_key WHEN 'name' THEN t.name ELSE t.name END,
          'color', t.color
        )
      ), '[]'::jsonb) INTO v_result
      FROM "Category" t
      WHERE t."organizationId" = p_organization_id
        AND (
          t.id = ANY(v_selected)
          OR (p_query_value IS NULL OR t.name ILIKE '%' || p_query_value || '%')
        );

    WHEN 'location' THEN
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          p_query_key, CASE p_query_key WHEN 'name' THEN t.name ELSE t.name END
        )
      ), '[]'::jsonb) INTO v_result
      FROM "Location" t
      WHERE t."organizationId" = p_organization_id
        AND (
          t.id = ANY(v_selected)
          OR (p_query_value IS NULL OR t.name ILIKE '%' || p_query_value || '%')
        );

    WHEN 'kit' THEN
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          p_query_key, CASE p_query_key WHEN 'name' THEN t.name ELSE t.name END
        )
      ), '[]'::jsonb) INTO v_result
      FROM "Kit" t
      WHERE t."organizationId" = p_organization_id
        AND (
          t.id = ANY(v_selected)
          OR (p_query_value IS NULL OR t.name ILIKE '%' || p_query_value || '%')
        );

    WHEN 'tag' THEN
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          p_query_key, CASE p_query_key WHEN 'name' THEN t.name ELSE t.name END,
          'color', t.color
        )
      ), '[]'::jsonb) INTO v_result
      FROM "Tag" t
      WHERE t."organizationId" = p_organization_id
        AND (
          t.id = ANY(v_selected)
          OR (p_query_value IS NULL OR t.name ILIKE '%' || p_query_value || '%')
        )
        AND (
          p_use_for IS NULL
          OR array_length(t."useFor"::text[], 1) IS NULL
          OR p_use_for = ANY(t."useFor"::text[])
        );

    WHEN 'teamMember' THEN
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', tm.id,
          p_query_key, CASE p_query_key WHEN 'name' THEN tm.name ELSE tm.name END,
          'user', CASE
            WHEN u.id IS NOT NULL THEN jsonb_build_object(
              'id', u.id,
              'firstName', u."firstName",
              'lastName', u."lastName",
              'email', u.email
            )
            ELSE NULL
          END
        )
      ), '[]'::jsonb) INTO v_result
      FROM "TeamMember" tm
      LEFT JOIN "User" u ON u.id = tm."userId"
      WHERE tm."organizationId" = p_organization_id
        AND (
          tm.id = ANY(v_selected)
          OR (p_query_value IS NULL OR (
            tm.name ILIKE '%' || p_query_value || '%'
            OR u."firstName" ILIKE '%' || p_query_value || '%'
            OR u."lastName" ILIKE '%' || p_query_value || '%'
            OR u.email ILIKE '%' || p_query_value || '%'
          ))
        )
        AND (
          (p_deleted_at IS NULL AND tm."deletedAt" IS NULL)
          OR (p_deleted_at IS NOT NULL)
        )
        AND (
          NOT p_users_only OR u.id IS NOT NULL
        )
        AND (
          NOT p_admin_owner_only
          OR (
            u.id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM "UserOrganization" uo
              WHERE uo."userId" = u.id
                AND uo."organizationId" = p_organization_id
                AND (uo.roles && ARRAY['ADMIN', 'OWNER']::"OrganizationRoles"[])
            )
          )
        );

    WHEN 'booking' THEN
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          p_query_key, CASE p_query_key WHEN 'name' THEN t.name ELSE t.name END
        )
      ), '[]'::jsonb) INTO v_result
      FROM "Booking" t
      WHERE t."organizationId" = p_organization_id
        AND t.status::text IN ('RESERVED', 'ONGOING', 'OVERDUE')
        AND (
          t.id = ANY(v_selected)
          OR (p_query_value IS NULL OR t.name ILIKE '%' || p_query_value || '%')
        );

    ELSE
      RAISE EXCEPTION 'Unknown model name: %', p_model_name;
  END CASE;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;
