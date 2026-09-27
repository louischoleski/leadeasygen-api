-- EXPAND ahead of @fonderie/auth's 019_session_location.sql.
--
-- The auth release that stores a location per session also READS this column
-- on every Active Sessions request and writes it on every sign-in, and Vercel
-- deploys in parallel with the production migration job. Adding it here first,
-- in its own deploy, means that code can never go live without the column.
-- Idempotent with the brick's own migration (same IF NOT EXISTS DDL).
ALTER TABLE fonderie_sessions ADD COLUMN IF NOT EXISTS location JSONB;
