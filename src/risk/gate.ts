// The trial-abuse gate — the app-level composition from the Trial-Abuse
// Defense spec. No brick imports another: billing grants the trial, this gate
// sits in front of it on the SAME route, composing signals from billing (card
// fingerprint), auth (account age, email verification), the request (IP,
// device header), and the app's own trial_signals memory.
//
// Two stages:
//   stage 1 (signup)    — captureSignupSignals on POST /auth/register records
//                         cheap velocity signals; blatant burst abuse is
//                         already rate-limited inside @fonderie/auth.
//   stage 2 (trial)     — trialCheckoutGate on POST /billing/checkout, the
//                         moment billing would grant plan.trialDays. Low risk
//                         passes through; medium is CHALLENGED (verify your
//                         email), high gets no free trial.
//
// The gate exploits the adapter's mount() ordering: bridge() runs at mount
// time but the fonderie route handler is only appended at listen() — so
// routes registered between mount() and listen() run after the bridge (full
// ctx) and before billing's controller, and fall through with next().
import type { NextFunction } from 'express';
import type { ExpressRequest, ExpressResponse } from '@fonderie/adapter-express';
import type { IStoreAdapter } from '@fonderie/store/types';
import type { StripeProvider } from '@fonderie/billing';
import type { EventBus } from '@fonderie/events';

import type { AuthedUser } from '../auth/requireAuth.js';
import { PLANS } from '../billing/catalog.js';
import { scoreTrial } from './trial-risk.js';
import {
	backfillCardFingerprint,
	deviceFingerprintFrom,
	emailDomain,
	gatherReuseSignals,
	hashSignal,
	isDisposableDomain,
	purgeExpiredSignals,
	recordSignupSignals,
	recordTrialDecision,
} from './signals.js';

interface TrialRiskDeps {
	store: IStoreAdapter;
	provider: StripeProvider;
}

function clientIp(req: ExpressRequest): string | null {
	const ip = req._fonderie?.meta['clientIp'];
	return typeof ip === 'string' && ip.length > 0 ? ip : null;
}

function headers(req: ExpressRequest): Record<string, unknown> {
	return (req as { headers?: Record<string, unknown> }).headers ?? {};
}

function json(res: ExpressResponse, status: number, body: unknown): void {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(body));
}

// ── stage 1: signup capture ───────────────────────────────────────

/**
 * Register on POST /auth/register (between mount() and listen()). Records the
 * ATTEMPT's velocity signals — hashed IP, hashed device fingerprint, email
 * domain — and always falls through to auth's controller. Fire-and-forget: a
 * signals hiccup must never break registration.
 */
export function captureSignupSignals(deps: TrialRiskDeps) {
	return (req: ExpressRequest, _res: ExpressResponse, next: NextFunction): void => {
		try {
			const ip = clientIp(req);
			const device = deviceFingerprintFrom(headers(req));
			const email = (req.body as { email?: unknown } | undefined)?.email;
			void recordSignupSignals(deps.store, {
				ipHash: ip ? hashSignal('ip', ip) : null,
				deviceHash: device ? hashSignal('device', device) : null,
				emailDomain: emailDomain(typeof email === 'string' ? email : null),
			}).catch((err) => console.error('trial_signals signup capture failed:', err));
		} catch (err) {
			console.error('trial_signals signup capture failed:', err);
		}
		next();
	};
}

// ── the card-on-file lookup (strongest signal) ────────────────────

/**
 * Resolve the caller's saved card, if any, and return the peppered hash of
 * its Stripe fingerprint. Wallet customer first (it knows the consented card
 * id from a pack purchase), then the subscription's customer. Tolerant: any
 * miss degrades to null and the score leans on the other signals.
 *
 * `fingerprint` is read structurally: it ships in @fonderie/billing after the
 * card-fingerprint field-add (PR #278); on an older billing it is simply
 * absent and this resolves null.
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
				 WHERE subscriber_type = 'user' AND subscriber_id = $1 LIMIT 1`,
				[userId],
			);
			customerId = sub?.provider_customer_id ?? null;
			paymentMethodId = null;
		}
		if (!customerId) return null;
		const card = await deps.provider.getPaymentMethod({ customerId, paymentMethodId });
		const fingerprint = (card as { fingerprint?: string | null } | null)?.fingerprint;
		return typeof fingerprint === 'string' && fingerprint.length > 0
			? hashSignal('card', fingerprint)
			: null;
	} catch (err) {
		console.error('trial risk: card lookup failed (degrading to null):', err);
		return null;
	}
}

// ── stage 2: the trial checkout gate ──────────────────────────────

/**
 * Register on POST /billing/checkout after ...requireAuth(store), so
 * `req.user` is present. Bites ONLY when billing would actually grant a
 * trial: the requested plan carries trialDays and this subscriber has never
 * consumed one (billing's own same-account guard) — every other checkout
 * falls straight through.
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

			const planName = (req.body as { plan?: unknown } | undefined)?.plan;
			const plan = PLANS.find(
				(p) => typeof planName === 'string' && p.name.toLowerCase() === planName.toLowerCase(),
			);
			if (plan?.trialDays === undefined) return next(); // no trial at stake

			const consumed = await deps.store.query<{ one: number }>(
				`SELECT 1 AS one FROM fonderie_subscription_trials
				 WHERE subscriber_type = 'user' AND subscriber_id = $1`,
				[user.id],
			);
			if (consumed.length > 0) return next(); // billing won't grant a trial anyway

			purgeExpiredSignals(deps.store); // opportunistic retention

			const ip = clientIp(req);
			const device = deviceFingerprintFrom(headers(req));
			const ipHash = ip ? hashSignal('ip', ip) : null;
			const deviceHash = device ? hashSignal('device', device) : null;
			const domain = emailDomain(user.email);
			const cardHash = await cardFingerprintHash(deps, user.id);

			const reuse = await gatherReuseSignals(deps.store, {
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

			const record = (decision: 'granted' | 'challenged' | 'denied') =>
				recordTrialDecision(deps.store, {
					userId: user.id,
					cardHash,
					deviceHash,
					ipHash,
					emailDomain: domain,
					score,
					decision,
				}).catch((err) => console.error('trial_signals record failed:', err));

			if (tier === 'high') {
				await record('denied');
				json(res, 409, {
					error: 'TRIAL_NOT_AVAILABLE',
					message:
						'A free trial is not available for this account. You can subscribe ' +
						'directly, or contact support if you believe this is a mistake.',
				});
				return;
			}

			if (tier === 'medium') {
				// Challenge, don't block: a verified email satisfies the step-up
				// (the card itself is collected by checkout — trials are card-up).
				const [row] = await deps.store.query<{ email_verified_at: Date | null }>(
					'SELECT email_verified_at FROM fonderie_users WHERE id = $1',
					[user.id],
				);
				if (!row?.email_verified_at) {
					await record('challenged');
					json(res, 402, {
						error: 'TRIAL_RISK_CHALLENGE',
						require: ['email-verification'],
						message: 'Verify your email address to start the free trial.',
					});
					return;
				}
			}

			await record('granted');
			next();
		} catch (err) {
			// Fail-open: an assessment outage must not block a legitimate checkout.
			console.error('trial risk gate failed (failing open):', err);
			next();
		}
	};
}

// ── the card back-fill (closes the loop) ──────────────────────────

/**
 * Subscribe on the shared events bus. When billing reports a subscription
 * that is TRIALING, fetch the card checkout just saved and stamp its
 * fingerprint hash onto the user's granted-trial row — so the NEXT account
 * that presents this card scores cardFingerprintSeen (+60).
 */
export function subscribeTrialCardBackfill(bus: EventBus, deps: TrialRiskDeps): void {
	bus.on(
		'fonderie.billing.subscription.created',
		async (payload: unknown) => {
			try {
				const p = payload as {
					subscriberType?: string;
					subscriberId?: string;
					status?: string;
				};
				if (p.subscriberType !== 'user' || !p.subscriberId || p.status !== 'trialing') return;
				const cardHash = await cardFingerprintHash(deps, p.subscriberId);
				if (cardHash) await backfillCardFingerprint(deps.store, p.subscriberId, cardHash);
			} catch (err) {
				console.error('trial card back-fill failed:', err);
			}
		},
		'leadeasygen.trial-risk.card-backfill',
	);
}
