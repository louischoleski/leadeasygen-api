-- Let a queued scrape be cancelled.
--
-- Until now a task had no way out except running. A job that nothing picks up
-- (no worker deployed, a worker that died) sits `pending` forever, and that is
-- not merely untidy — it actively blocks its owner twice:
--
--   • the dedup guard treats anything not 'error' as a live duplicate, so the
--     same search cannot be queued again
--   • atActiveJobLimit counts 'pending' and 'scraping', so it holds a slot in
--     the plan's concurrent-job allowance
--
-- 'cancelled' is a terminal state alongside 'complete' and 'error'. No refund
-- accounting is involved: the wallet is debited on COMPLETION, so a task that
-- never ran was never charged.
--
-- The CHECK is unnamed in 200_create_tasks.sql, so Postgres generated
-- `scrape_tasks_status_check`. Dropping by that generated name is safe here
-- because this schema is only ever created by that migration; IF EXISTS keeps
-- it idempotent if a database was built some other way.
ALTER TABLE scrape_tasks DROP CONSTRAINT IF EXISTS scrape_tasks_status_check;

ALTER TABLE scrape_tasks
	ADD CONSTRAINT scrape_tasks_status_check
	CHECK (status IN ('pending', 'scraping', 'complete', 'error', 'cancelled'));
