// The trial-abuse gate — the app-level composition from the Trial-Abuse
// Defense spec. No brick imports another: billing grants the trial, this gate
// sits in front of it on the SAME route, composing signals from billing (card
// fingerprint), auth (account age, email verification), the request (IP,
// device header), and the app's own trial_signals memory.
//
// Three stages:
//   stage 1 (signup)    — captureSignupSignals on POST /auth/register records
//                         velocity signals for SUCCESSFUL registrations.
//   stage 2 (trial)     — trialCheckoutGate on POST /billing/checkout, the
//                         moment billing would grant plan.trialDays. Low risk
//                         passes through (a provisional 'pending' row); medium
//                         is CHALLENGED (verify your email); high gets no free
//                         trial but CAN still subscribe paid (skipTrial).
//   stage 3 (webhook)   — subscribeTrialEnforcement: when Stripe reports the
//                         trialing subscription and its card, promote the
//                         pending row to granted — or, if that card already
//                         carried a trial on another account, revoke the
//                         subscription. This is the ENFORCEMENT point for the
//                         card signal: at gate time a fresh signup has no
//                         Stripe customer yet, so the card can only be judged
//                         after checkout collects it.
//
// The gate exploits the adapter's mount() ordering: bridge() runs at mount
// time but the fonderie route handler is only appended at listen() — so
// routes registered between mount() and listen() run after the bridge (full
// ctx) and before billing's controller, and fall through with next().
import type { NextFunction } from 'express';
import type { ExpressRequest, ExpressResponse } from '@fonderie/adapter-express';
import type { IStoreAdapter } from '@fonderie/store/types';
import type { StripeProvider } from '@fonderie/billing';
import { EVENT_KEYS } from '@fonderie/billing';
import type { EventBus } from '@fonderie/events';

import type { AuthedUser } from '../auth/requireAuth.js';
import { PLANS } from '../billing/catalog.js';
import { scoreTrial } from './trial-risk.js';
import {
	cardSeenElsewhere,
	clearPendingTrialDecision,
	deviceFingerprintFrom,
	emailDomain,
	gatherReuseSignals,
	hashIp,
	hashSignal,
	isDisposableDomain,
	markTrialRevoked,
	promotePendingToGranted,
	recordSignupSignals,
	recordTrialDecision,
} from './signals.js';

interface TrialRiskDeps {
	store: IStoreAdapter;
	provider: StripeProvider;
}

// Billing's own live-subscription set (see its checkout controller): a
// subscriber in any of these states gets an in-place plan change or a billing
// error — never a new trial — so the gate must not score them.
const LIVE_SUBSCRIPTION_STATUSES = new Set([
	'active',
	'trialing',
	'past_due',
	'unpaid',
	'paused',
]);

function clientIp(req: ExpressRequest): string | null {
	const ip = req._fonderie?.meta['clientIp'];
	return typeof ip === 'string' && ip.length > 0 ? ip : null;
}

function headers(req: ExpressRequest): Record<string, unknown> {
	return (req as { headers?: Record<string, unknown> }).headers ?? {};
}

// The fonderie API envelope — the shape @fonderie/client's FonderieApiError
// and the shipped screens parse. Everything else in this app answers with it;
// the gate must too or the challenge UX renders `undefined` toasts.
function fail(
	res: ExpressResponse,
	status: number,
	reason: string,
	explanation: string,
	details?: Record<string, unknown>,
): void {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ reason, explanation, ...(details ? { details } : {}) }));
}

// ── stage 1: signup capture ───────────────────────────────────────

/**
 * Register on POST /auth/register (between mount() and listen()). Records the
 * velocity signals — hashed IP, hashed device fingerprint, hashed email
 * domain — for registrations that SUCCEED (response < 400), by deferring the
 * write to the response 'finish' event. Failed/throttled attempts write
 * nothing: recording raw attempts would hand unauthenticated floods an
 * unthrottled table write (auth's own limiter runs INSIDE the fonderie
 * handler, after this middleware). Fire-and-forget: a signals hiccup must
 * never break registration.
 */
export function captureSignupSignals(deps: TrialRiskDeps) {
	return (req: ExpressRequest, res: ExpressResponse, next: NextFunction): void => {
		try {
			const ip = clientIp(req);
			const device = deviceFingerprintFrom(headers(req));
			const email = (req.body as { email?: unknown } | undefined)?.email;
			const domain = emailDomain(typeof email === 'string' ? email : null);
			(res as unknown as NodeJS.EventEmitter).once('finish', () => {
				if (res.statusCode >= 400) return;
				void recordSignupSignals(deps.store, {
					ipHash: ip ? hashIp(ip) : null,
					deviceHash: device ? hashSignal('device', device) : null,
					emailDomainHash: domain ? hashSignal('domain', domain) : null,
				}).catch((err) => console.error('trial_signals signup capture failed:', err));
			});
		} catch (err) {
			console.error('trial_signals signup capture failed:', err);
		}
		next();
	};
}

// ── the card-on-file lookups ──────────────────────────────────────

/**
 * Gate-time lookup (opportunistic, wallet-first): a caller who previously
 * bought a credit pack has a consented card the wallet knows. A FRESH signup
 * has no Stripe customer at all yet — checkout creates it after the gate — so
 * null here is the NORMAL case, not a defense: the card signal's enforcement
 * point is stage 3. Null also means "unknown" (billing's lookup is tolerant/
 * fail-open), never "verified clean".
 */
async function cardFingerprintHash(deps: TrialRiskDeps, userId: string): Promise<string | null> {
	try {
		const [wallet] = await deps.store.query<{
			provider_customer_id: string;
			payment_method_id: string | null;
		}>(
			`SELECT provider_customer_id, payment_method_id FROM fonderie_wallet_customers
			 WHERE subscriber_type = 'user' AND subscriber_id = $1 LIMIT 1`,
			[userId],
		);
		let customerId: string | null = wallet?.provider_customer_id ?? null;
		let paymentMethodId: string | null = wallet?.payment_method_id ?? null;
		if (!customerId) {
			const [sub] = await deps.store.query<{ provider_customer_id: string | null }>(
				`SELECT provider_customer_id FROM fonderie_subscriptions
				 WHERE subscriber_type = 'user' AND subscriber_id = $1
				 ORDER BY created_at DESC LIMIT 1`,
				[userId],
			);
			customerId = sub?.provider_customer_id ?? null;
			paymentMethodId = null;
		}
		if (!customerId) return null;
		const card = await deps.provider.getPaymentMethod({ customerId, paymentMethodId });
		const fingerprint = card?.fingerprint;
		return typeof fingerprint === 'string' && fingerprint.length > 0
			? hashSignal('card', fingerprint)
			: null;
	} catch (err) {
		console.error('trial risk: card lookup failed (degrading to null):', err);
		return null;
	}
}

/**
 * Webhook-time lookup (subscription-first): the card THIS checkout collected
 * lives on the subscription's customer as its default/newest method. The
 * wallet's consented pack-purchase card may be a different physical card, so
 * it is deliberately NOT preferred here.
 */
async function subscriptionCardFingerprintHash(
	deps: TrialRiskDeps,
	subscriberId: string,
): Promise<string | null> {
	try {
		const [sub] = await deps.store.query<{ provider_customer_id: string | null }>(
			`SELECT provider_customer_id FROM fonderie_subscriptions
			 WHERE subscriber_type = 'user' AND subscriber_id = $1
			 ORDER BY created_at DESC LIMIT 1`,
			[subscriberId],
		);
		const customerId = sub?.provider_customer_id ?? null;
		if (!customerId) return null;
		const card = await deps.provider.getPaymentMethod({ customerId, paymentMethodId: null });
		const fingerprint = card?.fingerprint;
		return typeof fingerprint === 'string' && fingerprint.length > 0
			? hashSignal('card', fingerprint)
			: null;
	} catch (err) {
		console.error('trial risk: subscription card lookup failed:', err);
		return null;
	}
}

// ── stage 2: the trial checkout gate ──────────────────────────────

/** Serialize the assessment on every identity it reads: parallel checkouts
 * sharing a user/device/IP/card take the same transaction-scoped advisory
 * locks and run one at a time, so N-at-once can't all read "no prior trial".
 * Keys are sorted for a deterministic lock order (no deadlocks). */
async function lockSignalKeys(
	tx: Pick<IStoreAdapter, 'query'>,
	keys: Array<string | null>,
): Promise<void> {
	const present = keys.filter((k): k is string => k !== null).sort();
	for (const key of present) {
		await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
	}
}

/**
 * Register on POST /billing/checkout after ...requireAuth(store), so
 * `req.user` is present. Bites ONLY when billing would actually grant a
 * trial: the requested plan carries trialDays, the subscriber has no LIVE
 * subscription (billing would do an in-place change, not a trial), and they
 * have never consumed a trial — every other checkout falls straight through.
 */
export function trialCheckoutGate(deps: TrialRiskDeps) {
	return async (
		req: ExpressRequest & { user?: AuthedUser },
		res: ExpressResponse,
		next: NextFunction,
	): Promise<void> => {
		try {
			const user = req.user;
			if (!user) return next(); // requireAuth handles auth; never double-guard

			const body = (req.body ?? {}) as { plan?: unknown; skipTrial?: unknown };
			const plan = PLANS.find(
				(p) => typeof body.plan === 'string' && p.name.toLowerCase() === body.plan.toLowerCase(),
			);
			if (!plan?.trialDays) return next(); // no trial at stake (absent or 0)

			// Billing's live-subscription branch never grants a trial (in-place
			// change / its own 422s) — replicate it so paid upgrades are never
			// risk-scored, challenged, or recorded as trials.
			const [current] = await deps.store.query<{
				status: string;
				provider_subscription_id: string | null;
			}>(
				`SELECT status, provider_subscription_id FROM fonderie_subscriptions
				 WHERE subscriber_type = 'user' AND subscriber_id = $1
				 ORDER BY created_at DESC LIMIT 1`,
				[user.id],
			);
			if (
				current?.provider_subscription_id &&
				LIVE_SUBSCRIPTION_STATUSES.has(current.status)
			) {
				return next();
			}

			const consumed = await deps.store.query<{ one: number }>(
				`SELECT 1 AS one FROM fonderie_subscription_trials
				 WHERE subscriber_type = 'user' AND subscriber_id = $1`,
				[user.id],
			);
			if (consumed.length > 0) return next(); // billing won't grant a trial anyway

			// The explicit paid-without-trial opt-in (the 409 below points here):
			// consume the trial up-front — billing's schema strips unknown body
			// fields, and its createSession sees the consumed trial and builds a
			// plain paid checkout. Nothing to risk-score: no trial is granted.
			if (body.skipTrial === true) {
				await deps.store.query(
					`INSERT INTO fonderie_subscription_trials (subscriber_type, subscriber_id)
					 VALUES ('user', $1) ON CONFLICT (subscriber_type, subscriber_id) DO NOTHING`,
					[user.id],
				);
				return next();
			}

			const ip = clientIp(req);
			const device = deviceFingerprintFrom(headers(req));
			const ipHash = ip ? hashIp(ip) : null;
			const deviceHash = device ? hashSignal('device', device) : null;
			const domain = emailDomain(user.email);
			const domainHash = domain ? hashSignal('domain', domain) : null;
			const cardHash = await cardFingerprintHash(deps, user.id);

			const verdict: { outcome: 'granted' | 'challenged' | 'denied'; score: number } = {
				outcome: 'granted',
				score: 0,
			};
			await deps.store.transaction(async (tx) => {
				await lockSignalKeys(tx, [`user:${user.id}`, deviceHash, ipHash, cardHash]);
				// A stale in-flight row from an abandoned earlier attempt must not
				// block this (same-user) retry — the locks make this safe.
				await clearPendingTrialDecision(tx, user.id);

				const reuse = await gatherReuseSignals(tx, {
					userId: user.id,
					cardHash,
					deviceHash,
					ipHash,
				});
				const accountAgeMinutes = (Date.now() - new Date(user.createdAt).getTime()) / 60_000;
				const { score, tier } = scoreTrial({
					...reuse,
					disposableEmail: isDisposableDomain(domain),
					accountAgeMinutes,
				});
				verdict.score = score;

				if (tier === 'high') {
					verdict.outcome = 'denied';
				} else if (tier === 'medium') {
					// Challenge, don't block: a verified email satisfies the step-up
					// (the card itself is collected by checkout — trials are card-up).
					const [row] = await tx.query<{ email_verified_at: Date | null }>(
						'SELECT email_verified_at FROM fonderie_users WHERE id = $1',
						[user.id],
					);
					if (!row?.email_verified_at) verdict.outcome = 'challenged';
				}

				await recordTrialDecision(tx, {
					userId: user.id,
					cardHash,
					deviceHash,
					ipHash,
					emailDomainHash: domainHash,
					score,
					// A passing gate is only PROVISIONAL: the webhook promotes it to
					// 'granted' when the trial really starts; abandoned/rejected
					// checkouts age out instead of poisoning the velocity signals.
					decision: verdict.outcome === 'granted' ? 'pending' : verdict.outcome,
				});
			});

			if (verdict.outcome === 'denied') {
				fail(
					res,
					409,
					'TRIAL_NOT_AVAILABLE',
					'A free trial is not available for this account. You can still ' +
						'subscribe without a trial (billing starts immediately), or contact ' +
						'support if you believe this is a mistake.',
					{ retryWith: { skipTrial: true }, score: verdict.score },
				);
				return;
			}
			if (verdict.outcome === 'challenged') {
				fail(
					res,
					402,
					'TRIAL_RISK_CHALLENGE',
					'Verify your email address to start the free trial.',
					{ require: ['email-verification'] },
				);
				return;
			}

			// If billing rejects this checkout downstream (bad interval, Stripe
			// error, …) the provisional row must not linger as a phantom trial.
			(res as unknown as NodeJS.EventEmitter).once('finish', () => {
				if (res.statusCode >= 400) {
					void clearPendingTrialDecision(deps.store, user.id).catch((err) =>
						console.error('trial_signals pending cleanup failed:', err),
					);
				}
			});
			next();
		} catch (err) {
			// Fail-open: an assessment outage must not block a legitimate checkout.
			// The card signal still gets enforced at stage 3 (webhook time).
			console.error('trial risk gate failed (failing open):', err);
			next();
		}
	};
}

// ── stage 3: webhook-time promotion + enforcement ─────────────────

/**
 * Subscribe on the shared events bus. When billing reports a subscription
 * that is TRIALING, resolve the card the checkout just collected and:
 *
 *  - if that card's fingerprint already carries a trial on ANOTHER account →
 *    revoke: cancel the subscription immediately (nothing has been charged —
 *    it is day 0 of a trial) and mark the decision denied. This is the real
 *    cross-account card defense: at gate time a fresh signup has no Stripe
 *    customer yet, so only this point can see the card.
 *  - otherwise promote the provisional 'pending' row to 'granted' and stamp
 *    the fingerprint hash, so the NEXT account presenting this card scores
 *    cardFingerprintSeen.
 */
export function subscribeTrialEnforcement(bus: EventBus, deps: TrialRiskDeps): void {
	bus.on(
		EVENT_KEYS.subscriptionCreated,
		async (payload: unknown) => {
			try {
				const p = payload as {
					subscriberType?: string;
					subscriberId?: string;
					status?: string;
					providerSubscriptionId?: string | null;
				};
				if (p.subscriberType !== 'user' || !p.subscriberId || p.status !== 'trialing') return;

				const cardHash = await subscriptionCardFingerprintHash(deps, p.subscriberId);
				if (!cardHash) {
					// Trial is real regardless — promote so velocity signals stay
					// truthful; without a fingerprint there is nothing to compare.
					console.warn(
						`trial risk: no card fingerprint resolvable for trialing user ${p.subscriberId} — promoting without card stamp`,
					);
					await promotePendingToGranted(deps.store, p.subscriberId, null);
					return;
				}

				const reused = await cardSeenElsewhere(deps.store, cardHash, p.subscriberId);
				if (reused && p.providerSubscriptionId) {
					await deps.provider.cancelSubscription({
						subscriptionId: p.providerSubscriptionId,
						atPeriodEnd: false,
					});
					await markTrialRevoked(deps.store, p.subscriberId, cardHash);
					console.error(
						`trial risk: REVOKED trial for user ${p.subscriberId} — card fingerprint already used by another account's trial`,
					);
					return;
				}
				if (reused) {
					console.error(
						`trial risk: card reuse detected for user ${p.subscriberId} but no providerSubscriptionId to cancel — promoting with stamp; investigate`,
					);
				}
				await promotePendingToGranted(deps.store, p.subscriberId, cardHash);
			} catch (err) {
				console.error('trial enforcement failed:', err);
			}
		},
		'leadeasygen.trial-risk.enforcement',
	);
}
