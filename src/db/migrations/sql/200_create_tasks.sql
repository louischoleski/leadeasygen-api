-- ----------------------------------------------------------------------------
-- 200_create_tasks
-- ----------------------------------------------------------------------------
-- Scrape jobs owned by a user (named scrape_tasks to avoid colliding with the
-- legacy backend's `tasks` table in the shared Supabase database — see
-- 199_drop_legacy_tasks). `results` holds the scraper engine's Lead[] array
-- once complete. Run via InternalMigrationRunner: it references the
-- fonderie_-prefixed users table, which the public MigrationRunner rejects.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scrape_tasks (
	id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id       UUID NOT NULL REFERENCES fonderie_users (id) ON DELETE CASCADE,
	url           TEXT NOT NULL,
	"limit"       INTEGER,
	status        TEXT NOT NULL DEFAULT 'pending'
	                  CHECK (status IN ('pending', 'scraping', 'complete', 'error')),
	results       JSONB,
	error_message TEXT,
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the per-user, newest-first listing query.
CREATE INDEX IF NOT EXISTS idx_scrape_tasks_user_id ON scrape_tasks (user_id, created_at DESC);
