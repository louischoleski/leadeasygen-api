-- ----------------------------------------------------------------------------
-- 300_create_credit_purchases
-- ----------------------------------------------------------------------------
-- Tracks completed Stripe Checkout sessions so credit top-ups are idempotent:
-- the session id is the primary key, so a webhook that fires twice for the
-- same session inserts once and credits the balance once. No @fonderie/billing
-- (or any payments table) is installed, so we own this table. Run via
-- InternalMigrationRunner — it references the fonderie_-prefixed users table.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credit_purchases (
	session_id   TEXT PRIMARY KEY,
	user_id      UUID NOT NULL REFERENCES fonderie_users (id) ON DELETE CASCADE,
	pack         TEXT NOT NULL,
	credits      INTEGER NOT NULL,
	amount_cents INTEGER NOT NULL,
	processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_user_id ON credit_purchases (user_id);
