import express, { type Express, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import type { IStoreAdapter } from '@fonderie/store/types';

import { requireAuth } from '../auth/requireAuth.js';
import { ensureMonthlyGrant } from './monthlyGrant.js';
import { isPack, type Pack, type PackDef } from './packs.js';

interface CreditRoutesConfig {
	stripe: Stripe;
	packs: Record<Pack, PackDef>;
	frontendUrl: string;
}

/**
 * Register the Stripe webhook (`POST /v1/webhooks/stripe`).
 *
 * IMPORTANT: call this BEFORE `express.json()` and BEFORE `mount()`. Signature
 * verification needs the raw request body, so this route uses `express.raw`
 * and must win the match before any middleware consumes the stream.
 */
export function registerStripeWebhook(
	app: Express,
	store: IStoreAdapter,
	config: { stripe: Stripe; webhookSecret: string; packs: Record<Pack, PackDef> },
): void {
	const { stripe, webhookSecret, packs } = config;

	app.post(
		'/v1/webhooks/stripe',
		express.raw({ type: 'application/json' }),
		async (req: Request, res: Response) => {
			const signature = req.headers['stripe-signature'];
			let event: Stripe.Event;

			try {
				event = stripe.webhooks.constructEvent(
					req.body as Buffer,
					signature as string,
					webhookSecret,
				);
			} catch (err) {
				console.error('Stripe webhook signature verification failed:', err);
				return res.status(400).json({ error: 'Webhook signature verification failed' });
			}

			if (event.type === 'checkout.session.completed') {
				const session = event.data.object as Stripe.Checkout.Session;
				const sessionId = session.id;
				const userId = session.client_reference_id;
				const packName = session.metadata?.pack;

				// Credits/amount come from our trusted catalogue, keyed by the pack
				// name we stamped into metadata at checkout — never from a raw number.
				const pack = isPack(packName) ? packs[packName] : undefined;

				if (!userId || !pack) {
					// Nothing we can safely credit. Ack anyway so Stripe stops retrying.
					console.warn(
						`checkout.session.completed ${sessionId}: missing user (${userId}) or pack (${packName}); skipping.`,
					);
					return res.status(200).json({ received: true });
				}

				try {
					// Idempotent grant: insert the session row; only credit the balance
					// when the insert actually happened (first delivery). A duplicate
					// webhook hits ON CONFLICT DO NOTHING → zero rows → no re-credit.
					await store.transaction(async (tx) => {
						const inserted = await tx.query<{ session_id: string }>(
							'INSERT INTO credit_purchases (session_id, user_id, pack, credits, amount_cents) ' +
								'VALUES ($1, $2, $3, $4, $5) ON CONFLICT (session_id) DO NOTHING ' +
								'RETURNING session_id',
							[sessionId, userId, packName, pack.credits, pack.amountCents],
						);

						if (inserted.length > 0) {
							// Ledger row (source of truth) + cache update, together.
							await tx.query(
								"INSERT INTO credit_transactions (user_id, type, amount, description) " +
									"VALUES ($1, 'purchase', $2, $3)",
								[userId, pack.credits, `Stripe pack: ${packName}`],
							);
							await tx.query(
								'UPDATE fonderie_users SET credits = credits + $1, updated_at = now() WHERE id = $2',
								[pack.credits, userId],
							);
						}
					});
				} catch (err) {
					// Fail loud so Stripe retries rather than silently dropping a purchase.
					console.error(`Failed to grant credits for session ${sessionId}:`, err);
					return res.status(500).json({ error: 'Internal Server Error' });
				}
			}

			return res.status(200).json({ received: true });
		},
	);
}

/**
 * Register the authenticated credit routes: checkout + balance.
 * Call this AFTER `mount()` (like the other authed product routes).
 */
export function registerCreditRoutes(
	app: Express,
	store: IStoreAdapter,
	config: CreditRoutesConfig,
): void {
	const { stripe, packs, frontendUrl } = config;

	// POST /v1/credits/checkout — start a one-time credit-pack purchase.
	app.post('/v1/credits/checkout', ...requireAuth(store), async (req: Request, res: Response) => {
		const packName = (req.body ?? {}).pack;
		if (!isPack(packName)) {
			return res.status(400).json({ error: "pack must be one of 'small', 'medium', 'large'" });
		}
		const pack = packs[packName];
		if (!pack.priceId) {
			console.error(`No Stripe Price ID configured for pack '${packName}'.`);
			return res.status(500).json({ error: 'Credit pack is not configured' });
		}

		try {
			const session = await stripe.checkout.sessions.create({
				mode: 'payment',
				line_items: [{ price: pack.priceId, quantity: 1 }],
				client_reference_id: req.user!.id,
				metadata: { userId: req.user!.id, pack: packName, credits: String(pack.credits) },
				success_url: `${frontendUrl}/credits/success?session_id={CHECKOUT_SESSION_ID}`,
				cancel_url: `${frontendUrl}/credits/cancel`,
			});

			return res.json({ url: session.url });
		} catch (err) {
			console.error('Failed to create Stripe checkout session:', err);
			return res.status(500).json({ error: 'Internal Server Error' });
		}
	});

	// GET /v1/credits/balance — current credit balance, derived from the ledger
	// (source of truth). fonderie_users.credits is only a cache.
	app.get('/v1/credits/balance', ...requireAuth(store), async (req: Request, res: Response) => {
		try {
			// Free-plan monthly credits land lazily on the first balance read of
			// the month (which for a fresh signup is the first dashboard load).
			await ensureMonthlyGrant(store, req.user!.id);
			const rows = await store.query<{ balance: number }>(
				'SELECT COALESCE(SUM(amount), 0)::int AS balance FROM credit_transactions WHERE user_id = $1',
				[req.user!.id],
			);
			return res.json({ credits: rows[0]?.balance ?? 0 });
		} catch (err) {
			console.error('GET /v1/credits/balance failed:', err);
			return res.status(500).json({ error: 'Internal Server Error' });
		}
	});

	// GET /v1/credits/transactions — the user's ledger (most recent 50).
	app.get('/v1/credits/transactions', ...requireAuth(store), async (req: Request, res: Response) => {
		try {
			await ensureMonthlyGrant(store, req.user!.id);
			const rows = await store.query<{
				id: string;
				task_id: string | null;
				type: string;
				amount: number;
				description: string | null;
				created_at: Date;
			}>(
				'SELECT id, task_id, type, amount, description, created_at ' +
					'FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
				[req.user!.id],
			);
			return res.json(
				rows.map((t) => ({
					id: t.id,
					taskId: t.task_id,
					type: t.type,
					amount: t.amount,
					description: t.description,
					createdAt: t.created_at,
				})),
			);
		} catch (err) {
			console.error('GET /v1/credits/transactions failed:', err);
			return res.status(500).json({ error: 'Internal Server Error' });
		}
	});
}
