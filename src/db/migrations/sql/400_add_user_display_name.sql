-- ----------------------------------------------------------------------------
-- 400_add_user_display_name
-- ----------------------------------------------------------------------------
-- Product-specific editable display name for a user (shown on the profile).
-- @fonderie/auth ships first_name/last_name behind a verify-gated route, so we
-- keep a simple, ungated display_name for the profile edit feature. Run via
-- InternalMigrationRunner — it touches the fonderie_-prefixed users table.
-- ----------------------------------------------------------------------------

ALTER TABLE fonderie_users
	ADD COLUMN IF NOT EXISTS display_name TEXT;
