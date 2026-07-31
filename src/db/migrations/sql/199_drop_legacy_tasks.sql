-- ----------------------------------------------------------------------------
-- 199_drop_legacy_tasks
-- ----------------------------------------------------------------------------
-- The Fonderie app shares its Supabase database with the legacy backend, whose
-- `tasks` table (id/www/status int/date_created) collides with the new scrape
-- table. That legacy table is empty and no longer used, so drop it here before
-- creating scrape_tasks. CASCADE also removes any dependent FK constraints
-- (e.g. legacy leads/lead_emails references); those tables themselves remain.
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS tasks CASCADE;
