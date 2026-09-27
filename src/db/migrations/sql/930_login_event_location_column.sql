-- EXPAND ahead of @fonderie/auth's 018_login_event_location.sql.
--
-- The auth release that stores login locations also READS this column on
-- every login-history request, and Vercel deploys in parallel with the
-- production migration job. Adding the column here first, in its own deploy,
-- means the code that uses it can never go live against a table without it.
-- Idempotent with the brick's own migration (same IF NOT EXISTS DDL).
ALTER TABLE fonderie_login_events ADD COLUMN IF NOT EXISTS location JSONB;
