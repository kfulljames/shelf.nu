-- Phase 2: Transaction RPC Functions
-- Converts Prisma db.$transaction calls to atomic Postgres functions

--------------------------------------------------------------------------------
-- 1. shelf_org_transfer_ownership
-- Atomically transfers workspace ownership between users
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_org_transfer_ownership(
  p_org_id TEXT,
  p_new_owner_user_id TEXT,
  p_current_owner_user_org_id TEXT,
  p_new_owner_user_org_id TEXT
) RETURNS VOID AS $$
BEGIN
  -- Update the organization owner
  UPDATE "Organization"
  SET "userId" = p_new_owner_user_id
  WHERE id = p_org_id;

  -- Demote current owner to ADMIN
  UPDATE "UserOrganization"
  SET roles = ARRAY['ADMIN']::"OrganizationRoles"[]
  WHERE id = p_current_owner_user_org_id;

  -- Promote new owner to OWNER
  UPDATE "UserOrganization"
  SET roles = ARRAY['OWNER']::"OrganizationRoles"[]
  WHERE id = p_new_owner_user_org_id;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 2. shelf_location_bulk_delete
-- Atomically deletes locations and their associated images
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_location_bulk_delete(
  p_location_ids TEXT[],
  p_image_ids TEXT[]
) RETURNS VOID AS $$
BEGIN
  -- Delete locations first (they reference images via FK)
  DELETE FROM "Location"
  WHERE id = ANY(p_location_ids);

  -- Delete orphaned images
  IF array_length(p_image_ids, 1) > 0 THEN
    DELETE FROM "Image"
    WHERE id = ANY(p_image_ids);
  END IF;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 3. shelf_booking_extend
-- Atomically checks for conflicts and extends a booking's end date.
-- Returns JSON: { success: true } or { success: false, clashingBookings: [...] }
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_booking_extend(
  p_booking_id TEXT,
  p_org_id TEXT,
  p_new_end_date TIMESTAMPTZ,
  p_current_to TIMESTAMPTZ,
  p_active_asset_ids TEXT[],
  p_current_status TEXT
) RETURNS JSONB AS $$
DECLARE
  v_clashing JSONB;
BEGIN
  -- Check for conflicting RESERVED bookings that overlap the extension period
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name)),
    '[]'::jsonb
  )
  INTO v_clashing
  FROM "Booking" b
  WHERE b.id != p_booking_id
    AND b."organizationId" = p_org_id
    AND b.status = 'RESERVED'::"BookingStatus"
    AND b."from" > p_current_to
    AND b."from" <= p_new_end_date
    AND EXISTS (
      SELECT 1 FROM "_AssetToBooking" ab
      WHERE ab."B" = b.id AND ab."A" = ANY(p_active_asset_ids)
    );

  -- If conflicts found, return them instead of updating
  IF v_clashing != '[]'::jsonb THEN
    RETURN jsonb_build_object('success', false, 'clashingBookings', v_clashing);
  END IF;

  -- Update booking: fix OVERDUE→ONGOING status and set new end date
  UPDATE "Booking"
  SET
    status = CASE
      WHEN p_current_status = 'OVERDUE' THEN 'ONGOING'::"BookingStatus"
      ELSE status
    END,
    "to" = p_new_end_date
  WHERE id = p_booking_id;

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 4. shelf_kit_release_removed_assets
-- Atomically releases custody and sets assets to AVAILABLE when removed from kit
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_kit_release_removed_assets(
  p_asset_ids TEXT[],
  p_org_id TEXT
) RETURNS VOID AS $$
BEGIN
  -- Delete custody records
  DELETE FROM "Custody"
  WHERE "assetId" = ANY(p_asset_ids);

  -- Set assets to AVAILABLE
  UPDATE "Asset"
  SET status = 'AVAILABLE'::"AssetStatus"
  WHERE id = ANY(p_asset_ids)
    AND "organizationId" = p_org_id;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 5. shelf_asset_bulk_update_location
-- Atomically updates asset locations and creates audit notes
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_asset_bulk_update_location(
  p_asset_ids TEXT[],
  p_new_location_id TEXT,
  p_note_contents TEXT[],
  p_note_user_id TEXT
) RETURNS VOID AS $$
BEGIN
  -- Update asset locations
  UPDATE "Asset"
  SET "locationId" = p_new_location_id
  WHERE id = ANY(p_asset_ids);

  -- Create audit notes (parallel arrays: p_asset_ids[i] ↔ p_note_contents[i])
  INSERT INTO "Note" (id, content, type, "userId", "assetId")
  SELECT
    gen_random_uuid()::text,
    note_content,
    'UPDATE'::"NoteType",
    p_note_user_id,
    asset_id
  FROM unnest(p_asset_ids, p_note_contents) AS t(asset_id, note_content);
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- TIER 2: Medium Complexity Transaction Functions
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 6. shelf_booking_checkout
-- Atomically checks out a booking: assets → CHECKED_OUT, kits → CHECKED_OUT,
-- booking status updated
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_booking_checkout(
  p_asset_ids TEXT[],
  p_kit_ids TEXT[],
  p_booking_id TEXT,
  p_new_status TEXT,
  p_new_from TIMESTAMPTZ DEFAULT NULL,
  p_new_to TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  -- Update all assets to CHECKED_OUT
  UPDATE "Asset"
  SET status = 'CHECKED_OUT'::"AssetStatus"
  WHERE id = ANY(p_asset_ids);

  -- Update kits to CHECKED_OUT (if any)
  IF array_length(p_kit_ids, 1) > 0 THEN
    UPDATE "Kit"
    SET status = 'CHECKED_OUT'::"KitStatus"
    WHERE id = ANY(p_kit_ids);
  END IF;

  -- Update booking status and optional date overrides
  UPDATE "Booking"
  SET
    status = p_new_status::"BookingStatus",
    "from" = COALESCE(p_new_from, "from"),
    "to" = COALESCE(p_new_to, "to")
  WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 7. shelf_booking_checkin
-- Atomically checks in a booking: assets → AVAILABLE, kits → AVAILABLE,
-- booking status updated
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_booking_checkin(
  p_asset_ids TEXT[],
  p_kit_ids TEXT[],
  p_booking_id TEXT,
  p_new_status TEXT,
  p_new_to TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  -- Update filtered assets to AVAILABLE
  IF array_length(p_asset_ids, 1) > 0 THEN
    UPDATE "Asset"
    SET status = 'AVAILABLE'::"AssetStatus"
    WHERE id = ANY(p_asset_ids);
  END IF;

  -- Update filtered kits to AVAILABLE
  IF array_length(p_kit_ids, 1) > 0 THEN
    UPDATE "Kit"
    SET status = 'AVAILABLE'::"KitStatus"
    WHERE id = ANY(p_kit_ids);
  END IF;

  -- Update booking status and optional end date
  UPDATE "Booking"
  SET
    status = p_new_status::"BookingStatus",
    "to" = COALESCE(p_new_to, "to")
  WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 8. shelf_booking_cancel
-- Atomically cancels a booking, reverting asset/kit status if active
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_booking_cancel(
  p_asset_ids TEXT[],
  p_kit_ids TEXT[],
  p_booking_id TEXT,
  p_was_active BOOLEAN,
  p_cancellation_reason TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  -- Only revert asset/kit status if booking was ONGOING or OVERDUE
  IF p_was_active THEN
    UPDATE "Asset"
    SET status = 'AVAILABLE'::"AssetStatus"
    WHERE id = ANY(p_asset_ids);

    IF array_length(p_kit_ids, 1) > 0 THEN
      UPDATE "Kit"
      SET status = 'AVAILABLE'::"KitStatus"
      WHERE id = ANY(p_kit_ids);
    END IF;
  END IF;

  -- Update booking to CANCELLED
  UPDATE "Booking"
  SET
    status = 'CANCELLED'::"BookingStatus",
    "cancellationReason" = p_cancellation_reason
  WHERE id = p_booking_id;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 9. shelf_booking_add_scanned_assets
-- Atomically connects assets to booking and updates their status if active
-- Returns the booking's current status for post-processing
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_booking_add_scanned_assets(
  p_asset_ids TEXT[],
  p_kit_ids TEXT[],
  p_booking_id TEXT,
  p_org_id TEXT
) RETURNS TEXT AS $$
DECLARE
  v_status TEXT;
BEGIN
  -- Connect assets to booking via join table
  INSERT INTO "_AssetToBooking" ("A", "B")
  SELECT asset_id, p_booking_id
  FROM unnest(p_asset_ids) AS asset_id
  ON CONFLICT DO NOTHING;

  -- Get booking status
  SELECT status::text INTO v_status
  FROM "Booking"
  WHERE id = p_booking_id AND "organizationId" = p_org_id;

  -- If booking is active, mark assets/kits as CHECKED_OUT
  IF v_status IN ('ONGOING', 'OVERDUE') THEN
    IF array_length(p_asset_ids, 1) > 0 THEN
      UPDATE "Asset"
      SET status = 'CHECKED_OUT'::"AssetStatus"
      WHERE id = ANY(p_asset_ids) AND "organizationId" = p_org_id;
    END IF;

    IF array_length(p_kit_ids, 1) > 0 THEN
      UPDATE "Kit"
      SET status = 'CHECKED_OUT'::"KitStatus"
      WHERE id = ANY(p_kit_ids) AND "organizationId" = p_org_id;
    END IF;
  END IF;

  -- Touch updatedAt
  UPDATE "Booking" SET "updatedAt" = now() WHERE id = p_booking_id;

  RETURN v_status;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 10. shelf_asset_bulk_checkout
-- Atomically creates custody, updates status, and creates audit notes
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_asset_bulk_checkout(
  p_asset_ids TEXT[],
  p_custodian_id TEXT,
  p_user_id TEXT,
  p_note_content TEXT
) RETURNS VOID AS $$
BEGIN
  -- Create custody records
  INSERT INTO "Custody" (id, "assetId", "teamMemberId")
  SELECT gen_random_uuid()::text, asset_id, p_custodian_id
  FROM unnest(p_asset_ids) AS asset_id;

  -- Update asset status to IN_CUSTODY
  UPDATE "Asset"
  SET status = 'IN_CUSTODY'::"AssetStatus"
  WHERE id = ANY(p_asset_ids);

  -- Create audit notes (same content for all assets)
  INSERT INTO "Note" (id, content, type, "userId", "assetId")
  SELECT gen_random_uuid()::text, p_note_content, 'UPDATE'::"NoteType", p_user_id, asset_id
  FROM unnest(p_asset_ids) AS asset_id;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 11. shelf_asset_bulk_checkin
-- Atomically deletes custody, updates status, and creates audit notes
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_asset_bulk_checkin(
  p_custody_ids TEXT[],
  p_asset_ids TEXT[],
  p_user_id TEXT,
  p_note_contents TEXT[]
) RETURNS VOID AS $$
BEGIN
  -- Delete custody records
  DELETE FROM "Custody"
  WHERE id = ANY(p_custody_ids);

  -- Update asset status to AVAILABLE
  UPDATE "Asset"
  SET status = 'AVAILABLE'::"AssetStatus"
  WHERE id = ANY(p_asset_ids);

  -- Create audit notes (parallel arrays: p_asset_ids[i] ↔ p_note_contents[i])
  INSERT INTO "Note" (id, content, type, "userId", "assetId")
  SELECT gen_random_uuid()::text, note_content, 'UPDATE'::"NoteType", p_user_id, asset_id
  FROM unnest(p_asset_ids, p_note_contents) AS t(asset_id, note_content);
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 12. shelf_kit_release_custody
-- Atomically releases kit custody: kit → AVAILABLE, delete kit custody,
-- delete asset custody, assets → AVAILABLE
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_kit_release_custody(
  p_kit_id TEXT,
  p_org_id TEXT,
  p_asset_ids TEXT[]
) RETURNS VOID AS $$
BEGIN
  -- Delete kit custody record
  DELETE FROM "KitCustody"
  WHERE "kitId" = p_kit_id;

  -- Update kit status to AVAILABLE
  UPDATE "Kit"
  SET status = 'AVAILABLE'::"KitStatus"
  WHERE id = p_kit_id AND "organizationId" = p_org_id;

  -- Delete asset custody records
  DELETE FROM "Custody"
  WHERE "assetId" = ANY(p_asset_ids);

  -- Update assets to AVAILABLE
  UPDATE "Asset"
  SET status = 'AVAILABLE'::"AssetStatus"
  WHERE id = ANY(p_asset_ids) AND "organizationId" = p_org_id;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 13. shelf_kit_bulk_remove_assets
-- Atomically removes assets from kits, deletes custody if needed, creates notes
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_kit_bulk_remove_assets(
  p_all_asset_ids TEXT[],
  p_custody_ids_to_delete TEXT[],
  p_user_id TEXT,
  p_custody_note_asset_ids TEXT[],
  p_custody_note_contents TEXT[],
  p_kit_note_asset_ids TEXT[],
  p_kit_note_contents TEXT[]
) RETURNS VOID AS $$
BEGIN
  -- Delete custody records for assets whose kits were in custody
  IF array_length(p_custody_ids_to_delete, 1) > 0 THEN
    DELETE FROM "Custody"
    WHERE id = ANY(p_custody_ids_to_delete);
  END IF;

  -- Remove assets from kits and set to AVAILABLE
  UPDATE "Asset"
  SET "kitId" = NULL, status = 'AVAILABLE'::"AssetStatus"
  WHERE id = ANY(p_all_asset_ids);

  -- Create notes for assets released from custody
  IF array_length(p_custody_note_asset_ids, 1) > 0 THEN
    INSERT INTO "Note" (id, content, type, "userId", "assetId")
    SELECT gen_random_uuid()::text, note_content, 'UPDATE'::"NoteType", p_user_id, asset_id
    FROM unnest(p_custody_note_asset_ids, p_custody_note_contents) AS t(asset_id, note_content);
  END IF;

  -- Create notes for assets removed from kit
  IF array_length(p_kit_note_asset_ids, 1) > 0 THEN
    INSERT INTO "Note" (id, content, type, "userId", "assetId")
    SELECT gen_random_uuid()::text, note_content, 'UPDATE'::"NoteType", p_user_id, asset_id
    FROM unnest(p_kit_note_asset_ids, p_kit_note_contents) AS t(asset_id, note_content);
  END IF;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- TIER 3: High Complexity Transaction Functions
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 14. shelf_booking_bulk_delete
-- Atomically deletes bookings, reverts asset/kit status, creates audit notes
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_booking_bulk_delete(
  p_booking_ids TEXT[],
  p_active_asset_ids TEXT[],
  p_active_kit_ids TEXT[],
  p_note_asset_ids TEXT[],
  p_note_contents TEXT[],
  p_note_user_id TEXT
) RETURNS VOID AS $$
BEGIN
  -- Delete all bookings
  DELETE FROM "Booking"
  WHERE id = ANY(p_booking_ids);

  -- Revert active assets to AVAILABLE
  IF array_length(p_active_asset_ids, 1) > 0 THEN
    UPDATE "Asset"
    SET status = 'AVAILABLE'::"AssetStatus"
    WHERE id = ANY(p_active_asset_ids);
  END IF;

  -- Revert active kits to AVAILABLE
  IF array_length(p_active_kit_ids, 1) > 0 THEN
    UPDATE "Kit"
    SET status = 'AVAILABLE'::"KitStatus"
    WHERE id = ANY(p_active_kit_ids);
  END IF;

  -- Create audit notes for assets
  IF array_length(p_note_asset_ids, 1) > 0 THEN
    INSERT INTO "Note" (id, content, type, "userId", "assetId")
    SELECT gen_random_uuid()::text, note_content, 'UPDATE'::"NoteType", p_note_user_id, asset_id
    FROM unnest(p_note_asset_ids, p_note_contents) AS t(asset_id, note_content);
  END IF;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 15. shelf_booking_bulk_cancel
-- Atomically cancels bookings, reverts asset/kit status, creates audit notes
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_booking_bulk_cancel(
  p_booking_ids TEXT[],
  p_active_asset_ids TEXT[],
  p_active_kit_ids TEXT[],
  p_note_asset_ids TEXT[],
  p_note_contents TEXT[],
  p_note_user_id TEXT
) RETURNS VOID AS $$
BEGIN
  -- Cancel all bookings
  UPDATE "Booking"
  SET status = 'CANCELLED'::"BookingStatus"
  WHERE id = ANY(p_booking_ids);

  -- Revert active assets to AVAILABLE
  IF array_length(p_active_asset_ids, 1) > 0 THEN
    UPDATE "Asset"
    SET status = 'AVAILABLE'::"AssetStatus"
    WHERE id = ANY(p_active_asset_ids);
  END IF;

  -- Revert active kits to AVAILABLE
  IF array_length(p_active_kit_ids, 1) > 0 THEN
    UPDATE "Kit"
    SET status = 'AVAILABLE'::"KitStatus"
    WHERE id = ANY(p_active_kit_ids);
  END IF;

  -- Create audit notes for assets
  IF array_length(p_note_asset_ids, 1) > 0 THEN
    INSERT INTO "Note" (id, content, type, "userId", "assetId")
    SELECT gen_random_uuid()::text, note_content, 'UPDATE'::"NoteType", p_note_user_id, asset_id
    FROM unnest(p_note_asset_ids, p_note_contents) AS t(asset_id, note_content);
  END IF;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 16. shelf_kit_bulk_assign_custody
-- Atomically assigns custody to kits and their assets, creates audit notes
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_kit_bulk_assign_custody(
  p_kit_ids TEXT[],
  p_custodian_id TEXT,
  p_asset_ids TEXT[],
  p_user_id TEXT,
  p_note_asset_ids TEXT[],
  p_note_contents TEXT[]
) RETURNS VOID AS $$
BEGIN
  -- Create kit custody records
  INSERT INTO "KitCustody" (id, "custodianId", "kitId")
  SELECT gen_random_uuid()::text, p_custodian_id, kit_id
  FROM unnest(p_kit_ids) AS kit_id;

  -- Update all kits to IN_CUSTODY
  UPDATE "Kit"
  SET status = 'IN_CUSTODY'::"KitStatus"
  WHERE id = ANY(p_kit_ids);

  -- Create asset custody records
  INSERT INTO "Custody" (id, "teamMemberId", "assetId")
  SELECT gen_random_uuid()::text, p_custodian_id, asset_id
  FROM unnest(p_asset_ids) AS asset_id;

  -- Update all assets to IN_CUSTODY
  UPDATE "Asset"
  SET status = 'IN_CUSTODY'::"AssetStatus"
  WHERE id = ANY(p_asset_ids);

  -- Create audit notes
  IF array_length(p_note_asset_ids, 1) > 0 THEN
    INSERT INTO "Note" (id, content, type, "userId", "assetId")
    SELECT gen_random_uuid()::text, note_content, 'UPDATE'::"NoteType", p_user_id, asset_id
    FROM unnest(p_note_asset_ids, p_note_contents) AS t(asset_id, note_content);
  END IF;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 17. shelf_kit_bulk_release_custody
-- Atomically releases custody from kits and their assets, creates audit notes
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_kit_bulk_release_custody(
  p_kit_ids TEXT[],
  p_asset_ids TEXT[],
  p_user_id TEXT,
  p_note_asset_ids TEXT[],
  p_note_contents TEXT[]
) RETURNS VOID AS $$
BEGIN
  -- Delete kit custody records
  DELETE FROM "KitCustody"
  WHERE "kitId" = ANY(p_kit_ids);

  -- Update all kits to AVAILABLE
  UPDATE "Kit"
  SET status = 'AVAILABLE'::"KitStatus"
  WHERE id = ANY(p_kit_ids);

  -- Delete asset custody records
  DELETE FROM "Custody"
  WHERE "assetId" = ANY(p_asset_ids);

  -- Update all assets to AVAILABLE
  UPDATE "Asset"
  SET status = 'AVAILABLE'::"AssetStatus"
  WHERE id = ANY(p_asset_ids);

  -- Create audit notes
  IF array_length(p_note_asset_ids, 1) > 0 THEN
    INSERT INTO "Note" (id, content, type, "userId", "assetId")
    SELECT gen_random_uuid()::text, note_content, 'UPDATE'::"NoteType", p_user_id, asset_id
    FROM unnest(p_note_asset_ids, p_note_contents) AS t(asset_id, note_content);
  END IF;
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 18. shelf_booking_partial_checkin
-- Atomically updates assets/kits and creates partial check-in record
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_booking_partial_checkin(
  p_asset_ids TEXT[],
  p_kit_ids TEXT[],
  p_booking_id TEXT,
  p_user_id TEXT,
  p_checkin_count INTEGER
) RETURNS VOID AS $$
BEGIN
  -- Update assets to AVAILABLE
  UPDATE "Asset"
  SET status = 'AVAILABLE'::"AssetStatus"
  WHERE id = ANY(p_asset_ids);

  -- Update complete kits to AVAILABLE
  IF array_length(p_kit_ids, 1) > 0 THEN
    UPDATE "Kit"
    SET status = 'AVAILABLE'::"KitStatus"
    WHERE id = ANY(p_kit_ids);
  END IF;

  -- Create partial check-in record
  INSERT INTO "PartialBookingCheckin" (id, "bookingId", "checkedInById", "assetIds", "checkinCount")
  VALUES (gen_random_uuid()::text, p_booking_id, p_user_id, p_asset_ids, p_checkin_count);
END;
$$ LANGUAGE plpgsql;

--------------------------------------------------------------------------------
-- 19. shelf_booking_update_assets
-- Atomically validates assets, connects them to booking, and syncs status.
-- Returns JSON with validated asset count and booking status.
--------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION shelf_booking_update_assets(
  p_asset_ids TEXT[],
  p_booking_id TEXT,
  p_org_id TEXT,
  p_kit_ids TEXT[]
) RETURNS JSONB AS $$
DECLARE
  v_unique_ids TEXT[];
  v_valid_count INTEGER;
  v_unique_count INTEGER;
  v_status TEXT;
BEGIN
  -- Deduplicate asset IDs
  SELECT ARRAY(SELECT DISTINCT unnest(p_asset_ids)) INTO v_unique_ids;
  v_unique_count := array_length(v_unique_ids, 1);

  -- Verify booking exists
  SELECT status::text INTO v_status
  FROM "Booking"
  WHERE id = p_booking_id AND "organizationId" = p_org_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Booking not found';
  END IF;

  -- Validate that all assets exist
  SELECT count(*) INTO v_valid_count
  FROM "Asset"
  WHERE id = ANY(v_unique_ids) AND "organizationId" = p_org_id;

  IF v_valid_count = 0 THEN
    RETURN jsonb_build_object(
      'error', 'None of the selected assets exist. They may have been deleted.',
      'status', 400
    );
  END IF;

  IF v_valid_count != v_unique_count THEN
    RETURN jsonb_build_object(
      'error', 'Some of the selected assets no longer exist. Please reload and try again.',
      'status', 400
    );
  END IF;

  -- Insert into join table
  INSERT INTO "_AssetToBooking" ("A", "B")
  SELECT asset_id, p_booking_id
  FROM unnest(v_unique_ids) AS asset_id
  ON CONFLICT ("A", "B") DO NOTHING;

  -- Touch updatedAt
  UPDATE "Booking" SET "updatedAt" = now() WHERE id = p_booking_id;

  -- If booking is active, update asset/kit status
  IF v_status IN ('ONGOING', 'OVERDUE') THEN
    UPDATE "Asset"
    SET status = 'CHECKED_OUT'::"AssetStatus"
    WHERE id = ANY(v_unique_ids) AND "organizationId" = p_org_id;

    IF array_length(p_kit_ids, 1) > 0 THEN
      UPDATE "Kit"
      SET status = 'CHECKED_OUT'::"KitStatus"
      WHERE id = ANY(p_kit_ids) AND "organizationId" = p_org_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'bookingStatus', v_status,
    'bookingId', p_booking_id
  );
END;
$$ LANGUAGE plpgsql;
