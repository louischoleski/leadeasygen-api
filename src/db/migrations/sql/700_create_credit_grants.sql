-- ----------------------------------------------------------------------------
-- 700_create_credit_grants
-- ----------------------------------------------------------------------------
-- Idempotency ledger for the free plan's monthly credit grant. One row per
-- user per calendar month (period = first day of that month); the primary
-- key makes the grant exactly-once under concurrent requests, mirroring the
-- credit_purchases pattern used for Stripe webhooks. The actual credits move
-- through credit_transactions ('bonus') as usual — this table only records
-- that a given month was granted. Run via InternalMigrationRunner — it
-- references the fonderie_-prefixed users table.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credit_grants (
	user_id    UUID NOT NULL REFERENCES fonderie_users (id) ON DELETE CASCADE,
	period     DATE NOT NULL,
	credits    INTEGER NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, period)
);
