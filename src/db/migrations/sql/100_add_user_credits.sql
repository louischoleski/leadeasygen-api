-- ----------------------------------------------------------------------------
-- 100_add_user_credits
-- ----------------------------------------------------------------------------
-- The user model is owned by @fonderie/auth (table: fonderie_users), which
-- already provides the required identity fields:
--   id         UUID PRIMARY KEY DEFAULT gen_random_uuid()   -- id (uuid, pk)
--   email      TEXT UNIQUE                                  -- email (unique)
--   created_at TIMESTAMPTZ NOT NULL DEFAULT now()           -- created_at
--
-- Only the product-specific `credits` balance is missing, so we add it here
-- rather than forking a second, parallel users table (which auth would never
-- populate). Run via InternalMigrationRunner — this intentionally touches a
-- fonderie_-prefixed table.
-- ----------------------------------------------------------------------------

ALTER TABLE fonderie_users
	ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;
