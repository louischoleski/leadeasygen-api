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
	deferTrialEnforcement,
	deviceFingerprintFrom,
	emailDomain,
	gatherReuseSignals,
	hasResolvedTrialDecision,
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

			// The explicit paid-without-trial opt-in (the 409 below points here).
			// Billing's ONLY lever to suppress the trial is the consumed marker
			// (createSession applies trialDays unless hasConsumedTrial), so we must
			// write it BEFORE billing builds the checkout. To avoid forfeiting a
			// (false-positive) user's future trial eligibility when no paid
			// subscription results, the marker is written only if it wasn't
			// already present, and REMOVED when billing fails to issue a checkout
			// (response < 200 or >= 400). Residual: a checkout that is created
			// (2xx) then abandoned can't be detected synchronously — that case is
			// reconciled by the checkout.session.expired / incomplete-subscription
			// sweep tracked with the durable-enforcement work.
			if (body.skipTrial === true) {
				const inserted = await deps.store.query<{ subscriber_id: string }>(
					`INSERT INTO fonderie_subscription_trials (subscriber_type, subscriber_id)
					 VALUES ('user', $1) ON CONFLICT (subscriber_type, subscriber_id) DO NOTHING
					 RETURNING subscriber_id`,
					[user.id],
				);
				// Only OUR insert is reversible — never delete a marker a real
				// prior trial/skip already set.
				if (inserted.length > 0) {
					(res as unknown as NodeJS.EventEmitter).once('finish', () => {
						if (res.statusCode < 200 || res.statusCode >= 400) {
							void deps.store
								.query(
									`DELETE FROM fonderie_subscription_trials
									 WHERE subscriber_type = 'user' AND subscriber_id = $1`,
									[user.id],
								)
								.catch((err) =>
									console.error('trial skip-consume rollback failed:', err),
								);
						}
					});
				}
				return next();
			}

			const ip = clientIp(req);
			const device = deviceFingerprintFrom(headers(req));
			const ipHash = ip ? hashIp(ip) : null;
			const deviceHash = device ? hashSignal('device', device) : null;
			const domain = emailDomain(user.email);
			const domainHash = domain ? hashSignal('domain', domain) : null;
			const cardHash = await cardFingerprintHash(deps, user.id);

			// The score is recorded on the trial_signals row (internal) but is
			// deliberately never returned to the caller — echoing it turns the
			// gate into a scoring oracle a farmer can tune evasion against.
			const verdict: { outcome: 'granted' | 'challenged' | 'denied' } = {
				outcome: 'granted',
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
					{ retryWith: { skipTrial: true } },
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
			// Fail-CLOSED: this gate is the only place a 'pending' enforcement row
			// is written before billing grants the trial, and stage-3 enforcement
			// keys off that row. If we failed open here, an assessment error
			// (transient DB, pool exhaustion) would let billing start a trial that
			// no pending row — and therefore no enforcement — ever covers, leaking
			// an un-enforced (possibly reused-card) trial. A trial is not a
			// time-critical purchase: 503-and-retry is the safe posture. Non-trial
			// checkouts (upgrades, paid-only) never reach here — they return next()
			// above before any of the throwing queries.
			console.error('trial risk gate failed (failing closed):', err);
			fail(
				res,
				503,
				'TRIAL_GATE_UNAVAILABLE',
				'We could not start your free trial right now. Please try again in a moment.',
				{ retryable: true },
			);
		}
	};
}

// ── stage 3: webhook-time promotion + enforcement ─────────────────

export type EnforceOutcome = 'granted' | 'revoked' | 'deferred' | 'skip';

/**
 * Resolve a single user's provisional ('pending') trial decision — the real
 * cross-account card defense. At gate time a fresh signup has no Stripe
 * customer, so the card can only be judged here, once checkout has collected
 * it. IDEMPOTENT and fail-CLOSED, so it is safe to call from both the
 * subscription webhook (low latency) and the reconciliation sweep (durability
 * against the at-most-once, non-durable event transport).
 *
 * Correctness rules that fixed the audit's critical findings:
 *  - Serializes on a CARD-hash advisory lock (not per-user): two accounts
 *    sharing one card that check out concurrently no longer both pass the
 *    reuse check before either stamps — they run one at a time, so the second
 *    sees the first's stamped row and is revoked.
 *  - Reads the subscription (status + provider id) from the DB, never the
 *    event payload — a missing/odd event field can't turn enforcement into a
 *    silent grant.
 *  - If the card can't be resolved (transient Stripe/DB error, or not attached
 *    yet) → DEFER: leave the row pending and let the sweep retry. Never
 *    promote an un-enforced trial.
 *  - Revoke = cancel FIRST, mark denied only on success, both inside the
 *    locked transaction: a cancel failure rolls back (nothing written, row
 *    stays pending) and the sweep retries — the subscription is never left
 *    live-and-marked-granted.
 */
export async function enforceTrialForUser(
	deps: TrialRiskDeps,
	userId: string,
): Promise<EnforceOutcome> {
	// Source of truth is the stored subscription (unique per subscriber), not
	// the event. fonderie_subscriptions has UNIQUE (subscriber_type,
	// subscriber_id), so this is the one row.
	const [sub] = await deps.store.query<{
		status: string;
		provider_subscription_id: string | null;
	}>(
		`SELECT status, provider_subscription_id FROM fonderie_subscriptions
		 WHERE subscriber_type = 'user' AND subscriber_id = $1`,
		[userId],
	);
	if (!sub || sub.status !== 'trialing') return 'skip'; // not a trial (yet), or already resolved

	// Already resolved? A user gets one trial ever (billing's own guard), so a
	// granted/denied row means enforcement is done — idempotent no-op.
	if (await hasResolvedTrialDecision(deps.store, userId)) return 'skip';

	// Something still pending to decide? (the gate always writes one before
	// billing grants the trial — the gate fails CLOSED otherwise, so a trialing
	// sub with no pending row is an anomaly the sweep leaves alone.)
	const [pending] = await deps.store.query<{ one: number }>(
		`SELECT 1 AS one FROM trial_signals
		 WHERE kind = 'trial' AND decision = 'pending' AND user_id = $1 LIMIT 1`,
		[userId],
	);
	if (!pending) return 'skip';

	// The card this checkout collected. Null = unknown (transient error OR not
	// attached yet) — fail closed: back off and let the sweep retry, never grant
	// blind.
	const cardHash = await subscriptionCardFingerprintHash(deps, userId);
	if (!cardHash) {
		await deferTrialEnforcement(deps.store, userId);
		return 'deferred';
	}

	// DECIDE under a card-hash advisory lock — serialized across accounts so two
	// same-card checkouts can't both pass the reuse check. NO external call
	// inside the transaction (that would pin a pooled connection + the lock
	// across a Stripe round-trip); the cancel happens after commit.
	const decision = await deps.store.transaction(async (tx): Promise<'granted' | 'reuse' | 'skip'> => {
		await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
			`trial-card:${cardHash}`,
		]);
		const [stillPending] = await tx.query<{ one: number }>(
			`SELECT 1 AS one FROM trial_signals
			 WHERE kind = 'trial' AND decision = 'pending' AND user_id = $1 LIMIT 1`,
			[userId],
		);
		if (!stillPending) return 'skip';
		if (!(await cardSeenElsewhere(tx, cardHash, userId))) {
			await promotePendingToGranted(tx, userId, cardHash);
			return 'granted';
		}
		return 'reuse'; // decided reused; the row stays pending until the cancel confirms
	});
	if (decision !== 'reuse') return decision;

	// REVOKE, outside the lock/transaction. The row is still 'pending', so a
	// failed cancel simply gets retried by the sweep — the subscription is never
	// left silently live-and-granted, and no un-enforced trial slips through.
	const subId = sub.provider_subscription_id;
	if (!subId) {
		await deferTrialEnforcement(deps.store, userId); // billing hasn't stored the id yet
		return 'deferred';
	}
	try {
		await deps.provider.cancelSubscription({ subscriptionId: subId, atPeriodEnd: false });
	} catch (err) {
		// "Already canceled" means our earlier attempt (whose mark then failed)
		// actually worked — treat as success and fall through to mark denied.
		// Any other error: back off and let the sweep retry the cancel
		// idempotently (never mark denied while the sub may still be live).
		if (!isAlreadyCanceled(err)) {
			console.error(`trial risk: cancel failed for user ${userId}, will retry:`, err);
			await deferTrialEnforcement(deps.store, userId);
			return 'deferred';
		}
	}
	await markTrialRevoked(deps.store, userId, cardHash); // pending → denied
	console.error(
		`trial risk: REVOKED trial for user ${userId} — card already used by another account's trial`,
	);
	return 'revoked';
}

/** Stripe surfaces canceling an already-canceled/absent subscription as an
 * error; that state is our success condition on a retry, so recognize it
 * rather than looping. Matches on the provider's message (kept broad). */
function isAlreadyCanceled(err: unknown): boolean {
	const msg = (err as { message?: string })?.message?.toLowerCase() ?? '';
	return (
		msg.includes('already canceled') ||
		msg.includes('already cancelled') ||
		msg.includes('no such subscription') ||
		msg.includes('canceled subscription')
	);
}

/**
 * Low-latency path: enforce as soon as billing reports the trialing
 * subscription. Thin wrapper over the idempotent enforceTrialForUser; the
 * sweep below is the durability backstop for anything this misses (dropped
 * at-most-once event, transient error, card not attached yet, a crash).
 */
export function subscribeTrialEnforcement(bus: EventBus, deps: TrialRiskDeps): void {
	bus.on(
		EVENT_KEYS.subscriptionCreated,
		async (payload: unknown) => {
			try {
				const p = payload as { subscriberType?: string; subscriberId?: string };
				if (p.subscriberType !== 'user' || !p.subscriberId) return;
				await enforceTrialForUser(deps, p.subscriberId);
			} catch (err) {
				console.error('trial enforcement (event) failed:', err);
			}
		},
		'leadeasygen.trial-risk.enforcement',
	);
}

/**
 * Durable reconciliation: the event bus is in-process and at-most-once, so a
 * dropped event, a transient Stripe/DB error, an unattached-card defer, or a
 * crash would otherwise leave a trial un-enforced forever. This sweep re-runs
 * enforceTrialForUser (idempotent) for every still-pending trial whose
 * subscription is trialing, catching all of those. Returns a stop handle.
 */
export function startTrialReconciliation(
	deps: TrialRiskDeps,
	intervalMs = 60_000,
): () => void {
	const tick = async (): Promise<void> => {
		try {
			// created_at grace lets the low-latency event handler win the happy
			// path; LIMIT bounds the scan. Pending rows past their 24h TTL are
			// left for the purge (a fingerprint that never resolved can't be
			// enforced).
			const rows = await deps.store.query<{ user_id: string }>(
				`SELECT ts.user_id
				   FROM trial_signals ts
				   JOIN fonderie_subscriptions s
				     ON s.subscriber_type = 'user' AND s.subscriber_id = ts.user_id
				  WHERE ts.kind = 'trial' AND ts.decision = 'pending'
				    AND s.status = 'trialing'
				    AND ts.created_at < now() - interval '30 seconds'
				    AND (ts.next_attempt_at IS NULL OR ts.next_attempt_at <= now())
				  -- Never-attempted rows (NULL) first, so a batch of stuck/deferring
				  -- rows can't starve a fresh reused-card row out of the window.
				  ORDER BY ts.next_attempt_at ASC NULLS FIRST, ts.created_at ASC
				  LIMIT 50`,
			);
			for (const r of rows) {
				await enforceTrialForUser(deps, r.user_id).catch((err) =>
					console.error(`trial reconciliation: enforce failed for ${r.user_id}:`, err),
				);
			}
		} catch (err) {
			console.error('trial reconciliation sweep failed:', err);
		}
	};
	const handle = setInterval(() => void tick(), intervalMs);
	handle.unref();
	return () => clearInterval(handle);
}
