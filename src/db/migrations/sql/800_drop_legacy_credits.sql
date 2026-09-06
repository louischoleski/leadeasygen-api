-- ----------------------------------------------------------------------------
-- 800_drop_legacy_credits
-- ----------------------------------------------------------------------------
-- Phase F — schema retirement. The hand-rolled credits system is fully
-- deprecated: @fonderie/billing's wallet is now the single source of truth for
-- balances, grants, purchases and usage (server cut over in phase C, packs +
-- webhook in D, client in E). Each user's balance was conserved into the wallet
-- by the one-time backfill at cutover (as a PURCHASED opening entry), so these
-- tables no longer back anything.
--
-- Gated on zero-observation: no app/api code references credit_transactions,
-- credit_grants, credit_purchases, or fonderie_users.credits anymore (grep-clean
-- after phase E). Run via InternalMigrationRunner — it touches the
-- fonderie_-prefixed users table.
--
-- IRREVERSIBLE: this drops the pre-cutover ledger detail. Only the migrated
-- opening balance (in fonderie_wallet_ledger) and all post-cutover wallet
-- activity survive; the individual legacy rows do not. Run only once the wallet
-- is confirmed authoritative in production.
--
-- The three tables are leaf tables (their FKs point at fonderie_users /
-- scrape_tasks; nothing references them), so order is unconstrained. CASCADE
-- also removes their indexes and constraints, matching 199_drop_legacy_tasks.
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS credit_grants CASCADE;
DROP TABLE IF EXISTS credit_purchases CASCADE;
DROP TABLE IF EXISTS credit_transactions CASCADE;

-- The fast-read cache column on the shared users table; the wallet balance
-- replaces it.
ALTER TABLE fonderie_users DROP COLUMN IF EXISTS credits;
