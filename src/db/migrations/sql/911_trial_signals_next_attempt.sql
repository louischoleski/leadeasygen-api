-- ----------------------------------------------------------------------------
-- 911_trial_signals_next_attempt
-- ----------------------------------------------------------------------------
-- Per-row enforcement backoff for the trial-abuse defense. A 'pending' trial
-- decision whose card can't be resolved yet (transient Stripe/DB error, or a
-- payment method with no fingerprint) is retried by the reconciliation sweep.
-- Without a backoff, a batch of such rows re-selected every tick (ORDER BY
-- created_at ASC LIMIT N) would starve newer reused-card rows out of the
-- enforcement window until their 24h TTL. next_attempt_at pushes a deferred
-- row into the future; the sweep orders never-attempted rows (NULL) FIRST, so
-- fresh rows are always enforced ahead of stuck ones.
-- ----------------------------------------------------------------------------

ALTER TABLE trial_signals ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

-- The sweep selects due 'pending' trial rows; keep that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_trial_signals_enforce_due
	ON trial_signals (next_attempt_at)
	WHERE kind = 'trial' AND decision = 'pending';
