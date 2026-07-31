-- ----------------------------------------------------------------------------
-- 500_create_credit_transactions
-- ----------------------------------------------------------------------------
-- Append-only credit ledger. Balance is derived as SUM(amount) per user;
-- fonderie_users.credits becomes a fast-read cache, not the source of truth.
--   purchase +N  (Stripe webhook)   usage  -1 (scrape completes)
--   refund   +1  (reserved)         bonus  +N (admin/manual grant)
-- Run via InternalMigrationRunner — references fonderie_ / scrape_tasks tables.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credit_transactions (
	id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id     UUID NOT NULL REFERENCES fonderie_users (id) ON DELETE CASCADE,
	task_id     UUID REFERENCES scrape_tasks (id) ON DELETE SET NULL,
	type        TEXT NOT NULL CHECK (type IN ('purchase', 'usage', 'refund', 'bonus')),
	amount      INTEGER NOT NULL,
	description TEXT,
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id
	ON credit_transactions (user_id, created_at DESC);

-- Backfill: seed the ledger from existing cached balances so SUM(amount)
-- matches each user's current credits at cutover. Runs once (migration tracked).
INSERT INTO credit_transactions (user_id, type, amount, description)
SELECT id, 'bonus', credits, 'Initial balance (ledger migration)'
FROM fonderie_users
WHERE credits IS NOT NULL AND credits <> 0;
