// Signal capture + recall for the trial-abuse defense. This is the PII
// firewall in code: every correlating value (IP, device fingerprint, card
// fingerprint) is peppered-hashed BEFORE it touches the database, rows carry
// an expiry, and nothing in this module is ever exported to the analytics/
// telemetry pipeline. See src/db/migrations/sql/910_create_trial_signals.sql.
import { createHash } from 'node:crypto';
import type { IStoreAdapter } from '@fonderie/store/types';

// ── hashing ───────────────────────────────────────────────────────

const pepper = (() => {
	const p = process.env.TRIAL_RISK_PEPPER;
	if (p && p.length >= 16) return p;
	console.warn(
		'⚠️  TRIAL_RISK_PEPPER not set (or too short) — using a dev pepper. ' +
			'Set a long random value in production: without it, trial_signals hashes ' +
			'are dictionary-attackable offline.',
	);
	return 'dev-trial-risk-pepper-change-me';
})();

/** sha256(pepper ‖ kind ‖ value) — domain-separated so an IP hash can never
 * collide with a card hash. Peppered so a leaked table can't be reversed by
 * hashing candidate values. */
export function hashSignal(kind: 'ip' | 'device' | 'card', value: string): string {
	return createHash('sha256').update(`${pepper}\0${kind}\0${value}`).digest('hex');
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
	return domain !== null && DISPOSABLE_DOMAINS.has(domain);
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
// trial" is a meaningful signal; signup rows only feed short-horizon velocity.
const TRIAL_ROW_TTL = '90 days';
const SIGNUP_ROW_TTL = '7 days';

/** Opportunistic retention purge — cheap, fire-and-forget, called on the gate
 * path so no scheduler is needed. */
export function purgeExpiredSignals(store: IStoreAdapter): void {
	void store
		.query('DELETE FROM trial_signals WHERE expires_at < now()')
		.catch((err) => console.error('trial_signals purge failed:', err));
}

// ── recording ─────────────────────────────────────────────────────

/** One row per registration ATTEMPT (the user may not exist yet — velocity
 * wants attempts, not successes). */
export async function recordSignupSignals(
	store: IStoreAdapter,
	s: { ipHash: string | null; deviceHash: string | null; emailDomain: string | null },
): Promise<void> {
	await store.query(
		`INSERT INTO trial_signals (kind, ip_hash, device_fingerprint_hash, email_domain, expires_at)
		 VALUES ('signup', $1, $2, $3, now() + interval '${SIGNUP_ROW_TTL}')`,
		[s.ipHash, s.deviceHash, s.emailDomain],
	);
}

export async function recordTrialDecision(
	store: IStoreAdapter,
	s: {
		userId: string;
		cardHash: string | null;
		deviceHash: string | null;
		ipHash: string | null;
		emailDomain: string | null;
		score: number;
		decision: 'granted' | 'challenged' | 'denied';
	},
): Promise<void> {
	await store.query(
		`INSERT INTO trial_signals
		   (kind, user_id, card_fingerprint_hash, device_fingerprint_hash, ip_hash,
		    email_domain, risk_score, decision, expires_at)
		 VALUES ('trial', $1, $2, $3, $4, $5, $6, $7, now() + interval '${TRIAL_ROW_TTL}')`,
		[s.userId, s.cardHash, s.deviceHash, s.ipHash, s.emailDomain, s.score, s.decision],
	);
}

/** Once Stripe reports the trial subscription's card (checkout collects it
 * up-front), stamp its fingerprint hash onto the user's latest granted-trial
 * row — the forward defense: the NEXT account reusing this card scores +60. */
export async function backfillCardFingerprint(
	store: IStoreAdapter,
	userId: string,
	cardHash: string,
): Promise<void> {
	await store.query(
		`UPDATE trial_signals SET card_fingerprint_hash = $2
		 WHERE id = (
		   SELECT id FROM trial_signals
		   WHERE kind = 'trial' AND user_id = $1 AND card_fingerprint_hash IS NULL
		   ORDER BY created_at DESC LIMIT 1
		 )`,
		[userId, cardHash],
	);
}

// ── recall (the velocity/reuse queries behind the score) ──────────

async function count(store: IStoreAdapter, sql: string, params: unknown[]): Promise<number> {
	const rows = await store.query<{ n: string | number }>(sql, params);
	return Number(rows[0]?.n ?? 0);
}

export async function gatherReuseSignals(
	store: IStoreAdapter,
	s: { userId: string; cardHash: string | null; deviceHash: string | null; ipHash: string | null },
): Promise<{
	cardFingerprintSeen: boolean;
	deviceFingerprintSeen: boolean;
	signupsFromDevice1h: number;
	ipTrials24h: number;
}> {
	const [cardSeen, deviceSeen, deviceSignups, ipTrials] = await Promise.all([
		s.cardHash
			? count(
					store,
					`SELECT count(*) AS n FROM trial_signals
					 WHERE kind = 'trial' AND card_fingerprint_hash = $1
					   AND (user_id IS NULL OR user_id <> $2)`,
					[s.cardHash, s.userId],
				)
			: Promise.resolve(0),
		s.deviceHash
			? count(
					store,
					`SELECT count(*) AS n FROM trial_signals
					 WHERE kind = 'trial' AND decision = 'granted'
					   AND device_fingerprint_hash = $1
					   AND (user_id IS NULL OR user_id <> $2)`,
					[s.deviceHash, s.userId],
				)
			: Promise.resolve(0),
		s.deviceHash
			? count(
					store,
					`SELECT count(*) AS n FROM trial_signals
					 WHERE kind = 'signup' AND device_fingerprint_hash = $1
					   AND created_at > now() - interval '1 hour'`,
					[s.deviceHash],
				)
			: Promise.resolve(0),
		s.ipHash
			? count(
					store,
					`SELECT count(*) AS n FROM trial_signals
					 WHERE kind = 'trial' AND decision = 'granted' AND ip_hash = $1
					   AND created_at > now() - interval '24 hours'
					   AND (user_id IS NULL OR user_id <> $2)`,
					[s.ipHash, s.userId],
				)
			: Promise.resolve(0),
	]);
	return {
		cardFingerprintSeen: cardSeen > 0,
		deviceFingerprintSeen: deviceSeen > 0,
		signupsFromDevice1h: deviceSignups,
		ipTrials24h: ipTrials,
	};
}
