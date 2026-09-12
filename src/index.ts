import 'dotenv/config';
import { FonderieApp, defineConfig } from '@fonderie/core';
import { InternalMigrationRunner, PGAdapter } from '@fonderie/store';
import { AuthModule } from '@fonderie/auth';
import { getMigrationsPath as authMigrationsPath } from '@fonderie/auth/migrations';
import { getMigrationsPath as eventsMigrationsPath } from '@fonderie/events/migrations';
import { EventsModule, MemoryTransport } from '@fonderie/events';
import { CourierModule } from '@fonderie/courier';
import { getMigrationsPath as courierMigrationsPath } from '@fonderie/courier/migrations';
import { BillingModule, StripeProvider, SUPPORTED_PAYMENT_OPTIONS, MESSAGE_KEYS as BILLING_MESSAGE_KEYS, DEFAULT_TEMPLATES as BILLING_DEFAULT_TEMPLATES } from '@fonderie/billing';
import { getMigrationsPath as billingMigrationsPath } from '@fonderie/billing/migrations';
import type { ResolveRecipient } from '@fonderie/billing';
import { MediaModule, DbBlobProvider } from '@fonderie/media';
import { getMigrationsPath as mediaMigrationsPath } from '@fonderie/media/migrations';
import { getMigrationsPath as storageMigrationsPath } from '@fonderie/storage/migrations';
import { adapt, mount } from '@fonderie/adapter-express';
import { byIp, rateLimit, StoreAdapterStore } from '@fonderie/rate-limit';
import express from 'express';

import { getAppMigrationsPath } from './db/migrations/index.js';
import { requireAuth } from './auth/requireAuth.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { PLANS, CREDIT_PACKS, WALLET_CURRENCY, WALLET_PRECISION } from './billing/catalog.js';
import { RiskEngine, DEFAULT_RULESETS } from '@fonderie/risk';
import { getMigrationsPath as riskMigrationsPath } from '@fonderie/risk/migrations';
import { trialCheckoutGate } from './risk/gate.js';

export interface CreateAppOptions {
	/**
	 * Run the module migrations during boot. True for a long-lived server
	 * (local dev, the container on the box); FALSE on serverless, where every
	 * cold start would re-run them on the request path and concurrent instances
	 * would race. There, `npm run migrate` owns schema changes instead.
	 */
	migrate?: boolean;
	/**
	 * Start the in-process background timers (the risk retention purge). A
	 * serverless instance is frozen between requests, so its timers never fire
	 * reliably — the deployment drives the purge with a cron ping instead
	 * (POST /internal/cron/purge).
	 */
	timers?: boolean;
	/**
	 * Max Postgres connections THIS instance may hold. pg defaults to 10, which
	 * is right for one long-lived server but wrong for serverless: every warm
	 * instance keeps its own pool, so N instances × 10 exhausts the upstream
	 * pooler's client limit. A Vercel function handles one request at a time,
	 * so 1 is enough there.
	 */
	poolMax?: number;
}

/**
 * Build the Express app with every module wired, WITHOUT listening. Both
 * entry points share it: `src/server.ts` (local/container — listens) and
 * `api/index.ts` (Vercel — exports it as a serverless handler).
 */
export async function createApp(options: CreateAppOptions = {}) {
	const { migrate = true, timers = true, poolMax } = options;
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
			// X-Device-Fingerprint: the optional trial-risk device signal.
			// X-Request-ID: sent by @fonderie/client >=0.19 on every call (request
			// correlation); traceparent: sent by >=0.20 (W3C tracing).
			// X-Workspace-ID: sent when a workspace is selected.
			// A header missing here makes the preflight reject the whole request.
			res.setHeader(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, X-Device-Fingerprint, X-Request-ID, X-Workspace-ID, traceparent',
			);
			// Let browser JS read the echoed correlation id (FonderieApiError.requestId).
			res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID');
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
		const store = new PGAdapter(
			poolMax ? { connectionString: databaseUrl, max: poolMax } : databaseUrl,
		);
		if (!(await store.testConnection())) {
			throw new Error('Cannot connect to the database — check DATABASE_URL.');
		}

		// Run migrations before boot. Auth owns the `fonderie_users` table; our
		// own migration only adds the product-specific `credits` column to it.
		// Both use InternalMigrationRunner because they touch fonderie_* tables.
		// Skipped on serverless (see CreateAppOptions.migrate) — `npm run migrate`
		// runs this same sequence once, out of band.
		if (migrate) {
		await new InternalMigrationRunner(store, authMigrationsPath()).run();
		await new InternalMigrationRunner(store, eventsMigrationsPath()).run();
		await new InternalMigrationRunner(store, getAppMigrationsPath()).run();
			// @fonderie/risk owns risk_events (the hashed-identity store the trial
			// gate's assessments read/write). Replaces the app's old trial_signals.
			await new InternalMigrationRunner(store, riskMigrationsPath()).run();
		// Courier owns message_logs + the seeded transactional templates that
		// the auth notification types (email-verification, password-reset, …)
		// are rendered from.
		await new InternalMigrationRunner(store, courierMigrationsPath()).run();
			// Billing owns fonderie_plans / fonderie_subscriptions and the
			// stored-value wallet tables (fonderie_wallet_*). Created alongside the
			// legacy credits tables during the migration — nothing reads the wallet
			// through billing yet (see src/billing/catalog.ts).
			await new InternalMigrationRunner(store, billingMigrationsPath()).run();
			// Media owns fonderie_media_assets (avatar/image metadata); the bytes
			// live in @fonderie/storage's fonderie_storage_blobs (DbBlobProvider,
			// below) — so storage's migration must run too. Zero extra infra: the
			// images sit in Postgres, no S3/MinIO at this stage.
			await new InternalMigrationRunner(store, storageMigrationsPath()).run();
			await new InternalMigrationRunner(store, mediaMigrationsPath()).run();
		}

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
		// Payments are configured below, billing's dunning/receipt notices ride
		// this bus, and the trial gate's email-verification challenge must be
		// DELIVERABLE. Without SMTP a production deploy would boot green while
		// customer notices drop into a consumer-less transport and the challenge
		// becomes a silent permanent deny — so fail the boot instead.
		if (!smtpHost && process.env.NODE_ENV === 'production') {
			throw new Error(
				'SMTP_HOST is required in production: billing customer notices and the ' +
					'trial email-verification challenge need a deliverable email path.',
			);
		}
		const eventsModule = new EventsModule({ transport: new MemoryTransport() });
		// The bus goes to auth + billing UNCONDITIONALLY (not only with SMTP):
		// they publish domain events — fonderie.user.registered,
		// fonderie.billing.subscription.* — that the trial-risk defense below
		// subscribes to. Courier (the email consumer) stays SMTP-gated for dev
		// convenience; production without SMTP fails the boot above.
		const notifyBus = eventsModule.bus;

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
		// One provider instance, shared between billing and the trial-risk gate
		// below (the gate reads the saved card's fingerprint through it).
		const stripeProvider = new StripeProvider(
			process.env.STRIPE_SECRET_KEY ?? 'sk_test_placeholder',
			process.env.STRIPE_WEBHOOK_SECRET,
			// In-app card entry offers card only — a concrete, displayable,
			// off-session-chargeable payment method. Excludes wallets like Link
			// (whose type:'link' PM has no card details to show as a card on file).
			{ setupPaymentMethodTypes: [SUPPORTED_PAYMENT_OPTIONS.CARD] },
		);

		fonderieApp = fonderieApp.register(
			new BillingModule(
				store,
				{
					provider: stripeProvider,
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

		// Guard on smtpHost so its type narrows to string below. The bus itself
		// always exists now — only the email consumer (courier) is SMTP-gated.
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

		// Avatar / image uploads via @fonderie/media. DbBlobProvider stores the
		// bytes in Postgres (fonderie_storage_blobs) — zero infra; swap in an
		// S3Provider later with one line. Default policy: a user uploads their
		// own avatar (ownerType 'user', ownerId = caller), 1 MB cap, magic-byte
		// sniffed (SVG rejected = stored-XSS). Registers POST /media, PUBLIC
		// cached GET /media/:id (an <img src> can't send a Bearer token), and
		// uploader-only DELETE /media/:id.
		fonderieApp = fonderieApp.register(
			new MediaModule(store, { provider: new DbBlobProvider(store) }),
		);

		const fonderie = await fonderieApp.boot();

		// mount() wires body parsing, context (bridge), and the auth routes onto
		// Express. bridge runs first, so custom routes added below see req._fonderie.
		mount(app, fonderie);

		// ── Trial-abuse defense (src/risk/) ──────────────────────────────
		// Routes registered between mount() and listen() run AFTER bridge()
		// (full fonderie ctx) and BEFORE the fonderie route handler — so these
		// compose in front of the brick routes and fall through with next().
		// The generic decision engine (@fonderie/risk). It DECIDES; this app
		// ENFORCES. Ships the trial.start ruleset; pepper from env (fails closed
		// in production). Signals/scoring/hashing + the risk_events store that used
		// to live in src/risk/ now live in the brick.
		const riskEngine = new RiskEngine(store, {
			rulesets: DEFAULT_RULESETS,
			pepper: process.env.RISK_PEPPER,
		});
		const risk = { store, provider: stripeProvider, risk: riskEngine };
		// The real gate, at the moment billing would grant
		// plan.trialDays. Auth first (an unauthenticated flood must cost 401s,
		// not rate-limit tokens), then a PER-USER velocity brake (per-IP would
		// collapse to one shared bucket behind a proxy with TRUST_PROXY unset,
		// and to an attacker-chosen key with it set on a directly-reachable
		// app), then the risk assessment: low → fall through · medium → 402
		// verify-email challenge · high → 409 no free trial (paid stays open).
		app.post(
			'/billing/checkout',
			...requireAuth(store),
			adapt(
				rateLimit({
					// Postgres-backed, NOT in-memory: a serverless instance is
					// discarded between requests, so a MemoryStore bucket resets
					// constantly and the brake silently stops braking. The store-backed
					// bucket is shared by every instance and survives cold starts.
					store: new StoreAdapterStore(store),
					// 10 checkout attempts per user per hour — generous for humans,
					// hostile to scripted farming. Durable cross-account velocity
					// lives in trial_signals; this is just a per-account brake.
					rule: { capacity: 10, refillPerSec: 10 / 3600 },
					key: (ctx) =>
						ctx.user?.id ? `trial-checkout:user:${ctx.user.id}` : byIp('trial-checkout')(ctx),
				}),
			),
			trialCheckoutGate(risk),
		);
		// Card-reuse REVOCATION (detect a reused card after checkout and cancel
		// the trialing subscription) is deliberately out of scope here — it's the
		// hard, money-path piece that belongs in a separately-designed effort. The
		// gate above catches the high-volume abuse synchronously; the engine
		// records the card for when that enforcement lands. See
		// docs/RISK-BRICK-DESIGN.md (fonderie repo).
		//
		// Retention purge on a timer — NOT on the request path (an attacker who
		// never checks out would never trigger it). A serverless instance is
		// frozen between invocations so its timers can't be trusted; there the
		// deployment pings the cron route below instead (options.timers = false).
		if (timers) {
			setInterval(() => void riskEngine.purgeExpired(), 6 * 60 * 60 * 1000).unref();
			void riskEngine.purgeExpired();
		}

		// Cron-driven equivalent of the timer above. Guarded by CRON_SECRET so it
		// is not a public "do work" button; Vercel Cron sends it as a Bearer
		// token. Returns 503 rather than running unguarded when the secret is
		// unset, so a misconfigured deploy fails loudly instead of silently
		// exposing the route.
		app.post('/internal/cron/purge', async (req, res) => {
			const secret = process.env.CRON_SECRET;
			if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not configured' });
			if (req.headers.authorization !== `Bearer ${secret}`) {
				return res.status(401).json({ error: 'Unauthorized' });
			}
			try {
				await riskEngine.purgeExpired();
				return res.json({ ok: true });
			} catch (err) {
				console.error('cron purge failed:', err);
				return res.status(500).json({ error: 'Purge failed' });
			}
		});

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

		modules = ['auth', 'tasks', 'billing', 'media'];
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

	return app;
}
