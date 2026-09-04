-- ----------------------------------------------------------------------------
-- 600_add_task_params
-- ----------------------------------------------------------------------------
-- Structured scrape parameters for tasks created by the app's "New scrape
-- job" form. `params` carries what the form captured (location, keyword,
-- radiusKm, category, groupId) so listings can render rich job cards without
-- parsing the Maps URL back apart; the URL stays the scraper's sole input.
-- `superseded_by` links a failed task to the retry that replaced it — the
-- listing endpoint hides superseded rows so a retried job never shows its
-- past failures alongside the fresh attempt.
-- ----------------------------------------------------------------------------

ALTER TABLE scrape_tasks
	ADD COLUMN IF NOT EXISTS params JSONB,
	ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES scrape_tasks (id) ON DELETE SET NULL;
