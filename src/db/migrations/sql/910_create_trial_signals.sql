-- ----------------------------------------------------------------------------
-- 910_create_trial_signals
-- ----------------------------------------------------------------------------
-- App-owned memory for the trial-abuse defense (see the Trial-Abuse Defense
-- spec): which signals have already been granted a trial, so a new signup
-- reusing them scores as risky. Two kinds of row:
--
--   'signup' — recorded when a POST /auth/register SUCCEEDS (2xx — failed
--              attempts are auth's rate limiter's problem, and recording them
--              would let unauthenticated traffic grow this table): feeds the
--              signup-velocity signals.
--   'trial'  — one row per gate decision at trial checkout. A passing gate
--              writes decision 'pending' (short TTL); the subscription.created
--              bus subscriber promotes it to 'granted' and stamps the card
--              fingerprint once Stripe reports the trial actually started —
--              so abandoned/rejected checkouts never poison the signals.
--
-- PII firewall: every correlating value (IP, device, card, email domain) is
-- stored as sha256(pepper + value) — never raw. Rows expire (expires_at,
-- purged on an interval); legal basis is legitimate interest (fraud
-- prevention), and nothing here may flow into the pseudonymous
-- analytics/telemetry pipeline.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trial_signals (
	id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id                 UUID REFERENCES fonderie_users (id) ON DELETE SET NULL,
	kind                    TEXT NOT NULL CHECK (kind IN ('signup', 'trial')),
	card_fingerprint_hash   TEXT,
	device_fingerprint_hash TEXT,
	ip_hash                 TEXT,
	email_domain_hash       TEXT,
	risk_score              INTEGER,
	decision                TEXT CHECK (decision IN ('pending', 'granted', 'challenged', 'denied')),
	created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at              TIMESTAMPTZ NOT NULL
);

-- One in-flight (pending) trial decision per user: parallel checkouts from the
-- same account collapse to one row (the gate also serializes on advisory locks).
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_signals_one_pending
	ON trial_signals (user_id) WHERE kind = 'trial' AND decision = 'pending';

-- The reuse lookups: "has this card/device/IP been granted a trial before?"
CREATE INDEX IF NOT EXISTS idx_trial_signals_card_fp   ON trial_signals (card_fingerprint_hash) WHERE card_fingerprint_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trial_signals_device_fp ON trial_signals (device_fingerprint_hash) WHERE device_fingerprint_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trial_signals_ip        ON trial_signals (ip_hash) WHERE ip_hash IS NOT NULL;
-- Back-fill + per-user recall, and the retention purge.
CREATE INDEX IF NOT EXISTS idx_trial_signals_user      ON trial_signals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trial_signals_expires   ON trial_signals (expires_at);
