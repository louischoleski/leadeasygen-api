-- ----------------------------------------------------------------------------
-- 900_add_task_dedup_key
-- ----------------------------------------------------------------------------
-- Per-user duplicate detection for scrape jobs. `dedup_key` is a normalized,
-- time-independent signature of what a structured job actually searches for —
-- keyword + location + radius. Computed in the app at insert time (see
-- tasks/routes.ts); legacy url-only jobs have no params and leave it NULL
-- (never deduped).
--
-- "Recent" is a rolling window applied at query time (`created_at > now() -
-- INTERVAL`), NOT baked into the key: calendar buckets would misalign with
-- per-user credit cycles that don't start on the 1st, and freshness is what's
-- really being guarded. The create path checks the key inside the same
-- per-user advisory-locked transaction that guards the active-job limit, so
-- concurrent identical submits serialize and only the first inserts. The index
-- is deliberately NON-unique: a user can force a fresh run of the same search
-- (a second row with the same key), so no unique constraint is wanted.
-- `error`/superseded rows are excluded so a failed or retried search can always
-- be re-run.
-- ----------------------------------------------------------------------------

ALTER TABLE scrape_tasks
	ADD COLUMN IF NOT EXISTS dedup_key TEXT;

CREATE INDEX IF NOT EXISTS idx_scrape_tasks_dedup
	ON scrape_tasks (user_id, dedup_key)
	WHERE dedup_key IS NOT NULL AND superseded_by IS NULL;
