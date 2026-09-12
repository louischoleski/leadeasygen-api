// The trial-abuse gate — now a thin consumer of @fonderie/risk. The engine
// DECIDES (reads signals, returns a graded verdict); this gate ENFORCES (maps
// the verdict to an HTTP action) on the same /billing/checkout route, in front
// of billing's controller.
//
// It bites ONLY when billing would actually grant a trial: the requested plan
// carries trialDays, the subscriber has no LIVE subscription, and they have
// never consumed a trial. Low → fall through; medium → 402 verify-email
// challenge; high → 409 (no free trial, but paid checkout stays open via
// skipTrial). Card-reuse revocation is deliberately OUT of scope here — a fresh
// signup has no Stripe customer at gate time, so the card is rarely available;
// that enforcement is a separate, later concern (see docs/RISK-BRICK-DESIGN.md).
//
// The gate exploits the adapter's mount() ordering: routes registered between
// mount() and listen() run after bridge() (full ctx) and before billing's
// controller, falling through with next().
import type { NextFunction } from 'express';
import type { ExpressRequest, ExpressResponse } from '@fonderie/adapter-express';
import type { StripeProvider } from '@fonderie/billing';
import type { IStoreAdapter } from '@fonderie/store/types';
import type { Identifier, RiskEngine } from '@fonderie/risk';

import type { AuthedUser } from '../auth/requireAuth.js';
import { PLANS } from '../billing/catalog.js';

interface TrialGateDeps {
	store: IStoreAdapter;
	provider: StripeProvider;
	risk: RiskEngine;
}

// Billing's live-subscription set: a subscriber in any of these gets an in-place
// change or a billing error — never a new trial — so the gate must not score them.
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);

// A small throwaway-mail deny-list; the engine reads the boolean as a signal.
const DISPOSABLE_DOMAINS = new Set([
	'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
	'temp-mail.org', 'yopmail.com', 'sharklasers.com', 'trashmail.com',
	'dispostable.com', 'getnada.com', 'maildrop.cc', 'throwawaymail.com',
]);

function emailDomain(email: string | null | undefined): string | null {
	if (!email) return null;
	const at = email.lastIndexOf('@');
	if (at < 0) return null;
	const d = email.slice(at + 1).trim().toLowerCase();
	return d.length > 0 && d.length <= 255 ? d : null;
}

function isDisposable(domain: string | null): boolean {
	if (!domain) return false;
	const d = domain.replace(/\.+$/, '');
	if (DISPOSABLE_DOMAINS.has(d)) return true;
	for (const listed of DISPOSABLE_DOMAINS) if (d.endsWith(`.${listed}`)) return true;
	return false;
}

function clientIp(req: ExpressRequest): string | null {
	const ip = req._fonderie?.meta['clientIp'];
	return typeof ip === 'string' && ip.length > 0 ? ip : null;
}

function deviceFingerprint(req: ExpressRequest): string | null {
	const raw = (req as { headers?: Record<string, unknown> }).headers?.['x-device-fingerprint'];
	const v = Array.isArray(raw) ? raw[0] : raw;
	if (typeof v !== 'string') return null;
	const t = v.trim().slice(0, 256);
	return t.length >= 8 ? t : null;
}

// The fonderie {reason, explanation, details} envelope the shipped frontend parses.
function fail(res: ExpressResponse, status: number, reason: string, explanation: string, details?: Record<string, unknown>): void {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ reason, explanation, ...(details ? { details } : {}) }));
}

/** Opportunistic card fingerprint (RAW — the engine hashes it). A returning
 * pack-buyer has a wallet customer; a fresh signup has no Stripe customer yet,
 * so this is usually null at gate time — expected, not a failure. */
async function cardFingerprint(deps: TrialGateDeps, userId: string): Promise<string | null> {
	try {
		const [wallet] = await deps.store.query<{ provider_customer_id: string; payment_method_id: string | null }>(
			`SELECT provider_customer_id, payment_method_id FROM fonderie_wallet_customers
			 WHERE subscriber_type = 'user' AND subscriber_id = $1 LIMIT 1`,
			[userId],
		);
		const customerId = wallet?.provider_customer_id ?? null;
		if (!customerId) return null;
		const card = await deps.provider.getPaymentMethod({ customerId, paymentMethodId: wallet?.payment_method_id ?? null });
		return card?.fingerprint && card.fingerprint.length > 0 ? card.fingerprint : null;
	} catch (err) {
		console.error('trial gate: card lookup failed (degrading to null):', err);
		return null;
	}
}

/**
 * Register on POST /billing/checkout after ...requireAuth(store). Assesses the
 * trial via @fonderie/risk and maps the verdict to an action.
 */
export function trialCheckoutGate(deps: TrialGateDeps) {
	return async (req: ExpressRequest & { user?: AuthedUser }, res: ExpressResponse, next: NextFunction): Promise<void> => {
		try {
			const user = req.user;
			if (!user) return next(); // requireAuth owns auth; never double-guard

			const body = (req.body ?? {}) as { plan?: unknown; skipTrial?: unknown };
			const plan = PLANS.find(
				(p) => typeof body.plan === 'string' && p.name.toLowerCase() === body.plan.toLowerCase(),
			);
			if (!plan?.trialDays) return next(); // no trial at stake

			// Billing's live-subscription branch never grants a trial — don't score it.
			const [current] = await deps.store.query<{ status: string; provider_subscription_id: string | null }>(
				`SELECT status, provider_subscription_id FROM fonderie_subscriptions
				 WHERE subscriber_type = 'user' AND subscriber_id = $1`,
				[user.id],
			);
			if (current?.provider_subscription_id && LIVE_SUBSCRIPTION_STATUSES.has(current.status)) return next();

			const consumed = await deps.store.query(
				`SELECT 1 FROM fonderie_subscription_trials WHERE subscriber_type = 'user' AND subscriber_id = $1`,
				[user.id],
			);
			if (consumed.length > 0) return next(); // billing won't grant a trial anyway

			// Explicit paid-without-trial opt-in (the 409 below points here). Consume
			// the trial up-front so billing builds a plain paid checkout; reversible
			// if billing never issues one.
			if (body.skipTrial === true) {
				const inserted = await deps.store.query<{ subscriber_id: string }>(
					`INSERT INTO fonderie_subscription_trials (subscriber_type, subscriber_id)
					 VALUES ('user', $1) ON CONFLICT (subscriber_type, subscriber_id) DO NOTHING
					 RETURNING subscriber_id`,
					[user.id],
				);
				if (inserted.length > 0) {
					(res as unknown as NodeJS.EventEmitter).once('finish', () => {
						if (res.statusCode < 200 || res.statusCode >= 400) {
							void deps.store
								.query(`DELETE FROM fonderie_subscription_trials WHERE subscriber_type = 'user' AND subscriber_id = $1`, [user.id])
								.catch((err) => console.error('trial skip-consume rollback failed:', err));
						}
					});
				}
				return next();
			}

			// Gather signals for the engine. Card is opportunistic (usually null at
			// gate time). Device/IP drive reuse+velocity; attributes drive the rest.
			const domain = emailDomain(user.email);
			const device = deviceFingerprint(req);
			const ip = clientIp(req);
			const card = await cardFingerprint(deps, user.id);
			const identifiers: Identifier[] = [];
			if (card) identifiers.push({ kind: 'card', value: card });
			if (device) identifiers.push({ kind: 'device', value: device });
			if (ip) identifiers.push({ kind: 'ip', value: ip });
			if (domain) identifiers.push({ kind: 'email-domain', value: domain });

			const verdict = await deps.risk.assess('trial.start', {
				actorId: user.id,
				identifiers,
				attributes: {
					disposableEmail: isDisposable(domain),
					accountAgeMinutes: (Date.now() - new Date(user.createdAt).getTime()) / 60_000,
				},
			});

			if (verdict.tier === 'high') {
				await deps.risk.record(verdict.assessmentId, 'blocked');
				fail(res, 409, 'TRIAL_NOT_AVAILABLE',
					'A free trial is not available for this account. You can still subscribe without a trial (billing starts immediately), or contact support if you believe this is a mistake.',
					{ retryWith: { skipTrial: true } });
				return;
			}
			if (verdict.tier === 'medium') {
				const [row] = await deps.store.query<{ email_verified_at: Date | null }>(
					'SELECT email_verified_at FROM fonderie_users WHERE id = $1', [user.id],
				);
				if (!row?.email_verified_at) {
					await deps.risk.record(verdict.assessmentId, 'challenged');
					fail(res, 402, 'TRIAL_RISK_CHALLENGE', 'Verify your email address to start the free trial.', { require: ['email-verification'] });
					return;
				}
			}

			await deps.risk.record(verdict.assessmentId, 'allowed');
			// If billing rejects this checkout downstream, the 'allowed' record is
			// harmless — it only makes the identifiers "seen"; no trial was granted.
			next();
		} catch (err) {
			// Fail CLOSED: a trial is not a time-critical purchase, and an
			// assessment outage must not silently grant an un-scored trial.
			console.error('trial gate failed (failing closed):', err);
			fail(res, 503, 'TRIAL_GATE_UNAVAILABLE', 'We could not start your free trial right now. Please try again in a moment.', { retryable: true });
		}
	};
}
