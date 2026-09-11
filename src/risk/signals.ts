// Signal capture + recall for the trial-abuse defense. This is the PII
// firewall in code: every correlating value (IP, device fingerprint, card
// fingerprint, email domain) is peppered-hashed BEFORE it touches the
// database, rows carry an expiry, and nothing in this module is ever exported
// to the analytics/telemetry pipeline. See
// src/db/migrations/sql/910_create_trial_signals.sql.
import { createHash } from 'node:crypto';
import type { IStoreAdapter } from '@fonderie/store/types';

// Accept either the adapter or a transaction handle — everything here only queries.
type Queryable = Pick<IStoreAdapter, 'query'>;

// ── hashing ───────────────────────────────────────────────────────

// Peppers that must never run outside development: the shipped .env.example
// placeholder and the dev fallback itself. A deployment that copies
// .env.example verbatim would otherwise run production with a public pepper —
// sha256(known-pepper + candidate) over the IPv4 space de-anonymizes every
// ip_hash offline.
const PLACEHOLDER_PEPPERS = new Set([
	'change-me-long-random-string',
	'dev-trial-risk-pepper-change-me',
]);

const pepper = (() => {
	const p = process.env.TRIAL_RISK_PEPPER;
	if (p && p.length >= 32 && !PLACEHOLDER_PEPPERS.has(p)) return p;
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'TRIAL_RISK_PEPPER must be a unique random value of at least 32 characters ' +
				'in production (the .env.example placeholder does not count) — without it, ' +
				'trial_signals hashes are dictionary-attackable offline.',
		);
	}
	console.warn(
		'⚠️  TRIAL_RISK_PEPPER not set (or placeholder/short) — using a dev pepper. ' +
			'Set a long random value in production: without it, trial_signals hashes ' +
			'are dictionary-attackable offline.',
	);
	return 'dev-trial-risk-pepper-change-me';
})();

/** sha256(pepper ‖ kind ‖ value) — domain-separated so an IP hash can never
 * collide with a card hash. Peppered so a leaked table can't be reversed by
 * hashing candidate values. */
export function hashSignal(kind: 'ip' | 'device' | 'card' | 'domain', value: string): string {
	return createHash('sha256').update(`${pepper}\0${kind}\0${value}`).digest('hex');
}

/** IPv6 addresses are hashed at /64 (the customary end-site prefix — one
 * subscriber can rotate the low 64 bits freely, which would defeat per-address
 * velocity), mirroring @fonderie/rate-limit's byIp bucketing so both layers
 * see the same "address". IPv4 passes through whole. */
export function ipBucket(ip: string): string {
	if (!ip.includes(':')) return ip;
	const [head] = ip.split('%');
	// IPv4-mapped IPv6 (::ffff:a.b.c.d) is an IPv4 address wearing a v6 hat —
	// return the embedded IPv4 whole (as @fonderie/core's resolveClientIp
	// already does upstream). Without this the dotted-quad tail stays one
	// "group", so slice(0,4) yields 0:0:0:0::/64 for EVERY such client,
	// merging unrelated users into one velocity bucket.
	const v4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(head ?? '');
	if (v4Mapped) return v4Mapped[1] as string;
	const groups = (head ?? '').split('::');
	let left = groups[0] ? groups[0].split(':') : [];
	const right = groups[1] ? groups[1].split(':') : [];
	if (groups.length === 2) {
		const fill = 8 - left.length - right.length;
		left = [...left, ...Array<string>(Math.max(0, fill)).fill('0'), ...right];
	}
	return left.slice(0, 4).join(':') + '::/64';
}

export function hashIp(ip: string): string {
	return hashSignal('ip', ipBucket(ip));
}

export function emailDomain(email: string | null | undefined): string | null {
	if (!email) return null;
	const at = email.lastIndexOf('@');
	if (at < 0) return null;
	const domain = email.slice(at + 1).trim().toLowerCase();
	return domain.length > 0 && domain.length <= 255 ? domain : null;
}

// A deny-list of throwaway-mail domains — deliberately small and cheap; a
// vendor list can replace it without touching the scoring. Weight is modest
// (+20), so a miss here only shifts, never decides.
const DISPOSABLE_DOMAINS = new Set([
	'mailinator.com',
	'guerrillamail.com',
	'10minutemail.com',
	'tempmail.com',
	'temp-mail.org',
	'yopmail.com',
	'sharklasers.com',
	'trashmail.com',
	'dispostable.com',
	'getnada.com',
	'maildrop.cc',
	'throwawaymail.com',
]);

export function isDisposableDomain(domain: string | null): boolean {
	if (domain === null) return false;
	// Match subdomains and trailing dots too: mail.yopmail.com. is still yopmail.
	const normalized = domain.replace(/\.+$/, '');
	if (DISPOSABLE_DOMAINS.has(normalized)) return true;
	for (const listed of DISPOSABLE_DOMAINS) {
		if (normalized.endsWith(`.${listed}`)) return true;
	}
	return false;
}

/** The optional client-supplied device fingerprint — an opaque hash from the
 * frontend (or a vendor SDK), passed as a header. Absence is fine: the score
 * degrades to the other signals. Capped so an oversized header can't reach
 * the hash unbounded. */
export function deviceFingerprintFrom(headers: Record<string, unknown>): string | null {
	const raw = headers['x-device-fingerprint'];
	const v = Array.isArray(raw) ? raw[0] : raw;
	if (typeof v !== 'string') return null;
	const trimmed = v.trim().slice(0, 256);
	return trimmed.length >= 8 ? trimmed : null;
}

// ── retention ─────────────────────────────────────────────────────

// Trial rows live for the window in which "this card/device already got a
// trial" is a meaningful signal; signup rows only feed short-horizon velocity;
// pending rows are in-flight checkouts and age out fast when abandoned.
const TRIAL_ROW_TTL = '90 days';
const SIGNUP_ROW_TTL = '7 days';
const PENDING_ROW_TTL = '24 hours';

/** Retention purge. Wired on a timer at boot (see index.ts) — NOT on the
 * request path, where an attacker who never checks out would simply never
 * trigger it. */
export function purgeExpiredSignals(store: Queryable): void {
	void store
		.query('DELETE FROM trial_signals WHERE expires_at < now()')
		.catch((err) => console.error('trial_signals purge failed:', err));
}

// ── recording ─────────────────────────────────────────────────────

/** One row per SUCCESSFUL registration (the caller gates on the response
 * status). Velocity of successes is what farming needs anyway; recording raw
 * attempts would hand unauthenticated traffic an unthrottled table write. */
export async function recordSignupSignals(
	store: Queryable,
	s: { ipHash: string | null; deviceHash: string | null; emailDomainHash: string | null },
): Promise<void> {
	await store.query(
		`INSERT INTO trial_signals (kind, ip_hash, device_fingerprint_hash, email_domain_hash, expires_at)
		 VALUES ('signup', $1, $2, $3, now() + interval '${SIGNUP_ROW_TTL}')`,
		[s.ipHash, s.deviceHash, s.emailDomainHash],
	);
}

export type TrialDecision = 'pending' | 'granted' | 'challenged' | 'denied';

/** 'pending' rows are provisional (short TTL, promoted to 'granted' by the
 * subscription webhook; deleted when billing rejects the checkout). The other
 * decisions are final records with the full trial TTL. */
export async function recordTrialDecision(
	store: Queryable,
	s: {
		userId: string;
		cardHash: string | null;
		deviceHash: string | null;
		ipHash: string | null;
		emailDomainHash: string | null;
		score: number;
		decision: TrialDecision;
	},
): Promise<void> {
	const ttl = s.decision === 'pending' ? PENDING_ROW_TTL : TRIAL_ROW_TTL;
	await store.query(
		`INSERT INTO trial_signals
		   (kind, user_id, card_fingerprint_hash, device_fingerprint_hash, ip_hash,
		    email_domain_hash, risk_score, decision, expires_at)
		 VALUES ('trial', $1, $2, $3, $4, $5, $6, $7, now() + interval '${ttl}')
		 ON CONFLICT (user_id) WHERE kind = 'trial' AND decision = 'pending' DO NOTHING`,
		[s.userId, s.cardHash, s.deviceHash, s.ipHash, s.emailDomainHash, s.score, s.decision],
	);
}

/** Drop the user's in-flight pending row — used when billing rejects the
 * checkout downstream (4xx/5xx after the gate passed), and before re-scoring
 * a retry so the unique pending index can't block it. */
export async function clearPendingTrialDecision(
	store: Queryable,
	userId: string,
): Promise<void> {
	await store.query(
		`DELETE FROM trial_signals WHERE kind = 'trial' AND decision = 'pending' AND user_id = $1`,
		[userId],
	);
}

/** Has this user's trial already been resolved to a durable outcome? Used by
 * enforcement to short-circuit idempotently (a user gets at most one trial in
 * their lifetime — billing's fonderie_subscription_trials enforces that). */
export async function hasResolvedTrialDecision(
	store: Queryable,
	userId: string,
): Promise<boolean> {
	const rows = await store.query<{ one: number }>(
		`SELECT 1 AS one FROM trial_signals
		 WHERE kind = 'trial' AND user_id = $1 AND decision IN ('granted', 'denied') LIMIT 1`,
		[userId],
	);
	return rows.length > 0;
}

/** Back off a still-pending enforcement so the reconciliation sweep doesn't
 * re-hit it every tick (which would starve fresh rows). next_attempt_at is
 * pushed into the future; the sweep processes never-attempted (NULL) rows
 * first, so deferring rows never crowd out new ones. */
export async function deferTrialEnforcement(
	store: Queryable,
	userId: string,
	backoff = '5 minutes',
): Promise<void> {
	await store.query(
		`UPDATE trial_signals SET next_attempt_at = now() + interval '${backoff}'
		 WHERE kind = 'trial' AND decision = 'pending' AND user_id = $1`,
		[userId],
	);
}

/** The subscription webhook's promotion: the trial REALLY started. Flip the
 * pending row to a durable granted record and stamp the card fingerprint
 * Stripe just reported. Falls back to stamping the newest granted row missing
 * a hash (a redelivered webhook after promotion, or a purged pending). */
export async function promotePendingToGranted(
	store: Queryable,
	userId: string,
	cardHash: string | null,
): Promise<void> {
	const promoted = await store.query<{ id: string }>(
		`UPDATE trial_signals
		 SET decision = 'granted',
		     card_fingerprint_hash = COALESCE($2, card_fingerprint_hash),
		     expires_at = now() + interval '${TRIAL_ROW_TTL}'
		 WHERE kind = 'trial' AND decision = 'pending' AND user_id = $1
		 RETURNING id`,
		[userId, cardHash],
	);
	if (promoted.length > 0 || !cardHash) return;
	await store.query(
		`UPDATE trial_signals SET card_fingerprint_hash = $2
		 WHERE id = (
		   SELECT id FROM trial_signals
		   WHERE kind = 'trial' AND decision = 'granted' AND user_id = $1
		     AND card_fingerprint_hash IS NULL
		   ORDER BY created_at DESC LIMIT 1
		 )`,
		[userId, cardHash],
	);
}

/** Post-webhook enforcement record: the trial started but the card had already
 * been through a trial on another account — the subscription was revoked. */
export async function markTrialRevoked(
	store: Queryable,
	userId: string,
	cardHash: string,
): Promise<void> {
	await store.query(
		`UPDATE trial_signals
		 SET decision = 'denied',
		     card_fingerprint_hash = COALESCE(card_fingerprint_hash, $2),
		     expires_at = now() + interval '${TRIAL_ROW_TTL}'
		 WHERE kind = 'trial' AND user_id = $1 AND decision IN ('pending', 'granted')`,
		[userId, cardHash],
	);
}

/** Has this card hash been granted (or is mid-granting) a trial by another
 * account? Used by both the gate and the post-webhook enforcement. */
export async function cardSeenElsewhere(
	store: Queryable,
	cardHash: string,
	userId: string,
): Promise<boolean> {
	const rows = await store.query<{ n: string | number }>(
		`SELECT count(*) AS n FROM trial_signals
		 WHERE kind = 'trial' AND decision IN ('granted', 'pending')
		   AND card_fingerprint_hash = $1
		   AND (user_id IS NULL OR user_id <> $2)`,
		[cardHash, userId],
	);
	return Number(rows[0]?.n ?? 0) > 0;
}

// ── recall (the velocity/reuse queries behind the score) ──────────

async function count(store: Queryable, sql: string, params: unknown[]): Promise<number> {
	const rows = await store.query<{ n: string | number }>(sql, params);
	return Number(rows[0]?.n ?? 0);
}

/** All reuse counters look at 'granted' AND 'pending' rows: granted is a
 * consummated trial, pending is one mid-checkout — counting it is what closes
 * the fire-N-parallel-checkouts race. Denied/challenged rows never count as
 * "already got a trial" (they didn't). Runs sequentially so it can share a
 * transaction's single connection. */
export async function gatherReuseSignals(
	store: Queryable,
	s: { userId: string; cardHash: string | null; deviceHash: string | null; ipHash: string | null },
): Promise<{
	cardFingerprintSeen: boolean;
	deviceFingerprintSeen: boolean;
	signupsFromDevice1h: number;
	ipTrials24h: number;
}> {
	const cardSeen = s.cardHash ? await cardSeenElsewhere(store, s.cardHash, s.userId) : false;
	const deviceSeen = s.deviceHash
		? await count(
				store,
				`SELECT count(*) AS n FROM trial_signals
				 WHERE kind = 'trial' AND decision IN ('granted', 'pending')
				   AND device_fingerprint_hash = $1
				   AND (user_id IS NULL OR user_id <> $2)`,
				[s.deviceHash, s.userId],
			)
		: 0;
	const deviceSignups = s.deviceHash
		? await count(
				store,
				`SELECT count(*) AS n FROM trial_signals
				 WHERE kind = 'signup' AND device_fingerprint_hash = $1
				   AND created_at > now() - interval '1 hour'`,
				[s.deviceHash],
			)
		: 0;
	const ipTrials = s.ipHash
		? await count(
				store,
				`SELECT count(*) AS n FROM trial_signals
				 WHERE kind = 'trial' AND decision IN ('granted', 'pending') AND ip_hash = $1
				   AND created_at > now() - interval '24 hours'
				   AND (user_id IS NULL OR user_id <> $2)`,
				[s.ipHash, s.userId],
			)
		: 0;
	return {
		cardFingerprintSeen: cardSeen,
		deviceFingerprintSeen: deviceSeen > 0,
		signupsFromDevice1h: deviceSignups,
		ipTrials24h: ipTrials,
	};
}
