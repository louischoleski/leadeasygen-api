import 'dotenv/config';
import { FonderieApp, defineConfig } from '@fonderie/core';
import { InternalMigrationRunner, PGAdapter } from '@fonderie/store';
import { AuthModule } from '@fonderie/auth';
import { getMigrationsPath as authMigrationsPath } from '@fonderie/auth/migrations';
import { getMigrationsPath as eventsMigrationsPath } from '@fonderie/events/migrations';
import { EventsModule, MemoryTransport } from '@fonderie/events';
import { CourierModule } from '@fonderie/courier';
import { getMigrationsPath as courierMigrationsPath } from '@fonderie/courier/migrations';
import { BillingModule, StripeProvider, MESSAGE_KEYS as BILLING_MESSAGE_KEYS, DEFAULT_TEMPLATES as BILLING_DEFAULT_TEMPLATES } from '@fonderie/billing';
import { getMigrationsPath as billingMigrationsPath } from '@fonderie/billing/migrations';
import type { ResolveRecipient } from '@fonderie/billing';
import { mount } from '@fonderie/adapter-express';
import express from 'express';

import { getAppMigrationsPath } from './db/migrations/index.js';
import { requireAuth } from './auth/requireAuth.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { PLANS, CREDIT_PACKS, WALLET_CURRENCY, WALLET_PRECISION } from './billing/catalog.js';

async function main() {
	const app = express();

	// CORS — the browser frontend (a separate origin) needs this to send the
	// Authorization header to the API. Reflect the request origin (dev-friendly)
	// and short-circuit preflight before bridge/mount (which 404 on OPTIONS).
	// Registered first so it applies to every route, including the webhook.
	app.use((req, res, next) => {
		const origin = req.headers.origin;
		if (origin) {
			res.setHeader('Access-Control-Allow-Origin', origin);
			res.setHeader('Vary', 'Origin');
			res.setHeader('Access-Control-Allow-Credentials', 'true');
			res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
		}
		if (req.method === 'OPTIONS') {
			res.statusCode = 204;
			res.end();
			return;
		}
		next();
	});

	// Fonderie is mounted only when a database is configured. Without
	// DATABASE_URL we degrade gracefully: the server still boots and serves
	// /health and /, so you can `npm run dev` immediately after scaffolding.
	const databaseUrl = process.env.DATABASE_URL;
	let modules: string[] = [];

	if (databaseUrl) {
		const store = new PGAdapter(databaseUrl);
		if (!(await store.testConnection())) {
			throw new Error('Cannot connect to the database — check DATABASE_URL.');
		}

		// Run migrations before boot. Auth owns the `fonderie_users` table; our
		// own migration only adds the product-specific `credits` column to it.
		// Both use InternalMigrationRunner because they touch fonderie_* tables.
		await new InternalMigrationRunner(store, authMigrationsPath()).run();
		await new InternalMigrationRunner(store, eventsMigrationsPath()).run();
		await new InternalMigrationRunner(store, getAppMigrationsPath()).run();
		// Courier owns message_logs + the seeded transactional templates that
		// the auth notification types (email-verification, password-reset, …)
		// are rendered from.
		await new InternalMigrationRunner(store, courierMigrationsPath()).run();
			// Billing owns fonderie_plans / fonderie_subscriptions and the
			// stored-value wallet tables (fonderie_wallet_*). Created alongside the
			// legacy credits tables during the migration — nothing reads the wallet
			// through billing yet (see src/billing/catalog.ts).
			await new InternalMigrationRunner(store, billingMigrationsPath()).run();

		// Credit-pack purchases and their payment webhook belong to
		// @fonderie/billing now: POST /billing/wallet/checkout and
		// POST /billing/webhook/payment, configured on the BillingModule below
		// (wallet.creditPacks from the shared catalog, wallet.webhookSecret =
		// STRIPE_WALLET_WEBHOOK_SECRET) and mounted with the rest of the Fonderie
		// routes. No hand-rolled Stripe checkout, no raw `stripe` SDK.
		const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';

		// NOTE: do NOT add express.json() here. Fonderie's Express adapter reads
		// the raw request stream itself (bridge → expressRequestToWeb → readStream)
		// and then populates req.body from Fonderie's own body parser. Running
		// express.json() first drains the stream, so the adapter's re-read never
		// receives an 'end' event and every POST with a body (e.g. /auth/register)
		// hangs until the client times out. Billing's payment webhook verifies the
		// Stripe signature off the raw body via ctx.request.text(); core's body
		// parser clones the request before reading, so the raw bytes survive — no
		// pre-bridge express.raw() route needed.

		// Transactional email via @fonderie/courier. Auth publishes a notification
		// event (verification pin, password-reset pin, …) onto an EventBus; courier
		// subscribes and renders+sends it over SMTP using the DB-seeded templates.
		// Both modules must share ONE bus, so we own it here (in-process memory
		// transport — notifications are fire-and-forget, no durability needed) and
		// hand the same instance to auth and courier. Without SMTP_HOST we skip
		// courier entirely and degrade gracefully: auth still records pins in the DB.
		const smtpHost = process.env.SMTP_HOST;
		const eventsModule = new EventsModule({ transport: new MemoryTransport() });
		const notifyBus = smtpHost ? eventsModule.bus : undefined;

		// Billing's money flows are webhook-driven (no session) — map a subscriber
		// id to the address courier should reach for receipts / dunning / low
		// balance. LeadEasyGen bills users directly (no workspaces), so resolve the
		// user's own email; a workspace subscriber can't occur here.
		const resolveRecipient: ResolveRecipient = async (subscriberType, id) => {
			if (subscriberType !== 'user') return null;
			const [row] = await store.query<{ email: string | null; phone: string | null }>(
				'SELECT email, phone FROM fonderie_users WHERE id = $1 AND deleted_at IS NULL',
				[id],
			);
			return row && (row.email || row.phone)
				? { email: row.email, phone: row.phone, deviceToken: null }
				: null;
		};

		// Standard Fonderie auth mold: stateless JWT sessions, email provider.
		// (Clerk is not a Fonderie brick; @fonderie/auth is the default.)
		// Registers POST /auth/register, POST /auth/login, POST /auth/refresh,
		// POST /auth/logout, GET /users (user.me), etc.
		let fonderieApp = new FonderieApp(defineConfig({ db: { url: databaseUrl } })).register(
			new AuthModule(
				store,
				{
					jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me-min-32-chars-long',
					appName: 'LeadEasyGen',
					providers: ['email'],
					requireVerification: false,
				},
				notifyBus,
			),
		);

		// Billing: subscriptions (the Unlimited plan) AND the credit wallet, driven
		// from one catalog (src/billing/catalog.ts). Registered alongside the legacy
		// src/credits system during the migration — nothing debits the wallet
		// through billing yet, so this is additive: it creates the tables + syncs
		// the plan catalog, but the running app is unchanged until cutover.
		fonderieApp = fonderieApp.register(
			new BillingModule(
				store,
				{
					provider: new StripeProvider(
						process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder',
						process.env.STRIPE_WEBHOOK_SECRET,
					),
					webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
					plans: PLANS,
					wallet: {
						currency: WALLET_CURRENCY,
						precision: WALLET_PRECISION,
						creditPacks: CREDIT_PACKS,
						webhookSecret: process.env.STRIPE_WALLET_WEBHOOK_SECRET,
						// Unlimited already includes credits, so block pack purchases
						// for an active/trialing paid subscriber (server-enforced; the
						// app also hides packs from them in the UI). Free/pay-as-you-go
						// buyers are unaffected.
						blockPacksWhileSubscribed: true,
					},
					resolveRecipient,
					successUrl: `${frontendUrl}/billing?checkout=success`,
					// 'cancelled' (not 'cancel') to match the app's return handler.
					cancelUrl: `${frontendUrl}/billing?checkout=cancelled`,
				},
				notifyBus,
			),
		);

		// Guard on smtpHost (not notifyBus) so its type narrows to string below;
		// the two are truthy together, since notifyBus is set iff smtpHost is.
		if (smtpHost) {
			// Every auth message type routed to the email channel. Courier skips any
			// whose recipient has no email address (e.g. phone-only OTP).
			const emailOnly = ['email'] as const;
			fonderieApp = fonderieApp.register(eventsModule).register(
				new CourierModule(
					{
						channels: {
							'email-verification': [...emailOnly],
							'email-registration': [...emailOnly],
							'password-reset': [...emailOnly],
							'email-changed': [...emailOnly],
							'phone-changed': [...emailOnly],
							'mfa-enabled': [...emailOnly],
							'mfa-disabled': [...emailOnly],
							'mfa-backup-codes-regenerated': [...emailOnly],
							// Billing money-flow notices (subscription + wallet). Bodies
							// come from billing's DEFAULT_TEMPLATES (wired below) rendered
							// in the DB-seeded layout; no per-key template to author here.
							[BILLING_MESSAGE_KEYS.subscriptionCanceled]: [...emailOnly],
							[BILLING_MESSAGE_KEYS.paymentFailed]: [...emailOnly],
							[BILLING_MESSAGE_KEYS.trialEnding]: [...emailOnly],
							[BILLING_MESSAGE_KEYS.renewalReceipt]: [...emailOnly],
							[BILLING_MESSAGE_KEYS.creditsLow]: [...emailOnly],
							[BILLING_MESSAGE_KEYS.paymentReceipt]: [...emailOnly],
							[BILLING_MESSAGE_KEYS.refundProcessed]: [...emailOnly],
							[BILLING_MESSAGE_KEYS.autoRechargeFailed]: [...emailOnly],
						},
						email: {
							provider: 'smtp',
							from: process.env.SMTP_FROM ?? process.env.SMTP_USER!,
							smtp: {
								host: smtpHost,
								port: Number(process.env.SMTP_PORT ?? 587),
								secure: process.env.SMTP_SECURE === 'true',
								user: process.env.SMTP_USER!,
								pass: process.env.SMTP_PASS!,
							},
						},
						// DB-seeded auth templates (present) win; billing's notices have
						// no DB seed, so they fall back to billing's shipped defaults.
						templates: { source: 'db', defaults: [BILLING_DEFAULT_TEMPLATES] },
					},
					store,
					notifyBus,
				),
			);
		} else {
			console.warn('⚠️  SMTP_HOST not set — transactional email disabled (pins recorded in DB only).');
		}

		const fonderie = await fonderieApp.boot();

		// mount() wires body parsing, context (bridge), and the auth routes onto
		// Express. bridge runs first, so custom routes added below see req._fonderie.
		mount(app, fonderie);

		// GET /auth/me — requireAuth, returns the current user. The credit balance
		// is NOT here anymore: it lives on the billing wallet, which the client
		// reads via GET /billing/wallet (@fonderie/react-billing's useWallet).
		app.get('/auth/me', ...requireAuth(store), (req, res) => {
			res.json({ user: req.user });
		});

		// PATCH /v1/users/me — update the editable display name.
		app.patch('/v1/users/me', ...requireAuth(store), async (req, res) => {
			const body = (req.body ?? {}) as { displayName?: unknown };
			const displayName =
				typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 120) : '';
			try {
				await store.query(
					'UPDATE fonderie_users SET display_name = $1, updated_at = now() WHERE id = $2',
					[displayName || null, req.user!.id],
				);
				return res.json({ success: true, displayName });
			} catch (err) {
				console.error('PATCH /v1/users/me failed:', err);
				return res.status(500).json({ error: 'Internal Server Error' });
			}
		});

		// Task management API under /v1/tasks.
		registerTaskRoutes(app, store);

		// The credit balance is billing's now — the app reads GET /billing/wallet
		// (via @fonderie/client / @fonderie/react-billing). The old
		// /v1/credits/balance compatibility shim was removed in the phase-E client
		// cutover; nothing under /v1/credits remains.

		modules = ['auth', 'tasks', 'billing'];
	} else {
		console.warn(
			'⚠️  DATABASE_URL is not set — Fonderie modules are disabled. ' +
				'Copy .env.example to .env and set DATABASE_URL to enable /auth routes.',
		);
	}

	app.get('/health', (_req, res) => {
		res.json({ status: 'ok', fonderie: true, modules });
	});

	app.get('/', (_req, res) => {
		res.json({
			message: 'LeadEasyGen backend is running',
			version: '0.1.0',
			try: ['GET /health', 'POST /auth/register', 'POST /auth/login', 'GET /auth/me'],
		});
	});

	const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
	app.listen(port, () => {
		console.log(`🚀 Server ready at http://localhost:${port}`);
		console.log(`📚 Auth routes: http://localhost:${port}/auth`);
	});
}

main().catch(console.error);
