import 'dotenv/config';
import { FonderieApp, defineConfig, isServerlessRuntime } from '@fonderie/core';
import { InternalMigrationRunner, PGAdapter } from '@fonderie/store';
import { AuthModule } from '@fonderie/auth';
import { getMigrationsPath as authMigrationsPath } from '@fonderie/auth/migrations';
import { getMigrationsPath as eventsMigrationsPath } from '@fonderie/events/migrations';
import {
	buildCourierModule,
	createNotifyBus,
	drainAfterResponse,
	explainDrainFailure,
	installPlatformBackgroundRunner,
} from './notifications.js';
import { getMigrationsPath as courierMigrationsPath } from '@fonderie/courier/migrations';
import { BillingModule, StripeProvider, SUPPORTED_PAYMENT_OPTIONS } from '@fonderie/billing';
import { getMigrationsPath as billingMigrationsPath } from '@fonderie/billing/migrations';
import type { ResolveRecipient } from '@fonderie/billing';
import { MediaModule, DbBlobProvider } from '@fonderie/media';
import { getMigrationsPath as mediaMigrationsPath } from '@fonderie/media/migrations';
import { getMigrationsPath as storageMigrationsPath } from '@fonderie/storage/migrations';
import { adapt, cors, mount } from '@fonderie/adapter-express';
import { DEFAULT_CORS_HEADERS } from '@fonderie/core/middlewares';
import { byIp, rateLimit, StoreAdapterStore } from '@fonderie/rate-limit';
import express, { type Express } from 'express';

import { getAppMigrationsPath } from './db/migrations/index.js';
import { requireAuth } from './auth/requireAuth.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { PLANS, CREDIT_PACKS, WALLET_CURRENCY, WALLET_PRECISION } from './billing/catalog.js';
import { RiskEngine, DEFAULT_RULESETS } from '@fonderie/risk';
import { getMigrationsPath as riskMigrationsPath } from '@fonderie/risk/migrations';
import { trialCheckoutGate } from './risk/gate.js';

export interface ConfigureAppOptions {
	/** The Express app to wire. The entry owns it so it can be exported before boot completes. */
	app: Express;
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
 * Wire every module onto the given Express app. Never listens — `src/index.ts`
 * owns the app, exports it for Vercel, and starts a server only off-platform.
 */
export async function configureApp(options: ConfigureAppOptions) {
	const { app, poolMax } = options;

	// Lets background work outlive the response on platforms that offer it
	// (Vercel's waitUntil). Off such a platform this is a no-op.
	await installPlatformBackgroundRunner();

	// CORS — app-level so it covers EVERY route, including the ones outside the
	// fonderie pipeline (custom routes, /health, the Stripe webhooks). The
	// adapter's defaults already allow every header @fonderie/client sends and
	// stay in lockstep with it, so a client upgrade can no longer break the
	// preflight the way it did before. X-Device-Fingerprint is this app's own
	// trial-risk signal, EXTENDING the defaults rather than replacing them. The
	// client always fetches with credentials, so the origin must be explicit.
	const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
	app.use(
		cors({
			credentials: true,
			origin: frontendUrl,
			headers: [...DEFAULT_CORS_HEADERS, 'X-Device-Fingerprint'],
		}),
	);

	// Fonderie is mounted only when a database is configured. Without
	// DATABASE_URL we degrade gracefully: the server still boots and serves
	// /health and /, so you can `npm run dev` immediately after scaffolding.
	let engine: RiskEngine | null = null;
	const databaseUrl = process.env.DATABASE_URL;
	let modules: string[] = [];
	// What the login screen may offer. Declared out here because /config is
	// served whether or not a database is configured.
	let authProviders: string[] = ['email'];

	if (databaseUrl) {
		const store = new PGAdapter(
			poolMax ? { connectionString: databaseUrl, max: poolMax } : databaseUrl,
		);
		if (!(await store.testConnection())) {
			throw new Error('Cannot connect to the database — check DATABASE_URL.');
		}

		// Migrations do NOT run here. Every serverless cold start would re-run
		// them on the request path and concurrent instances would race, so the
		// schema is owned out of band by `npm run migrate` (which runs this same
		// sequence once, against the direct connection).

		// Credit-pack purchases and their payment webhook belong to
		// @fonderie/billing now: POST /billing/wallet/checkout and
		// POST /billing/webhook/payment, configured on the BillingModule below
		// (wallet.creditPacks from the shared catalog, wallet.webhookSecret =
		// STRIPE_WALLET_WEBHOOK_SECRET) and mounted with the rest of the Fonderie
		// routes. No hand-rolled Stripe checkout, no raw `stripe` SDK.
		// (frontendUrl is declared above, for CORS — same value, same meaning.)

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
		// Both modules must share ONE bus, so we own it here and hand the same
		// instance to auth and courier. The bus is backed by the Postgres outbox,
		// NOT memory: fire-and-forget was exactly the bug — the send began after
		// the response and died with the frozen instance. Without SMTP_HOST we skip
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
		// DURABLE, and producer-only. The API writes notification rows inside the
		// request but runs no consumer: a poll loop can't run where the process
		// must return, and LISTEN is rejected by the transaction-mode pooler
		// production connects through. Delivery is a separate step — the worker,
		// or a bounded drain from this process (both below). Before this the
		// transport was in-memory, so a send begun after the response was
		// abandoned when the instance froze — the user was told to check an email
		// that never left.
		const { module: eventsModule, transport: notifications } = createNotifyBus(databaseUrl, {
			consume: false,
		});
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

		// Google sign-in, configured only when all three values are present.
		//
		// Env-gated on purpose, rather than a boolean flag: a half-configured
		// OAuth provider is worse than an absent one — the button appears, the
		// user commits to a redirect, and the failure lands on Google's error
		// page where the app cannot explain it. Requiring all three means the
		// route only exists when it can actually complete, and /auth/providers
		// (below) tells the frontend which buttons to render, so the UI can
		// never offer one that would dead-end.
		//
		// GOOGLE_REDIRECT_URI must match the Authorized redirect URI in the
		// Google Cloud console EXACTLY — scheme, host, path, no trailing slash.
		const googleOAuth =
			process.env.GOOGLE_CLIENT_ID &&
			process.env.GOOGLE_CLIENT_SECRET &&
			process.env.GOOGLE_REDIRECT_URI
				? {
						clientId: process.env.GOOGLE_CLIENT_ID,
						clientSecret: process.env.GOOGLE_CLIENT_SECRET,
						redirectUri: process.env.GOOGLE_REDIRECT_URI,
					}
				: null;
		if (!googleOAuth && (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_SECRET)) {
			console.warn(
				'⚠️  Google sign-in is PARTIALLY configured and therefore disabled — ' +
					'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI are all required.',
			);
		}
		if (googleOAuth) authProviders = ['email', 'google'];

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
					providers: googleOAuth ? ['email', 'google'] : ['email'],
					...(googleOAuth ? { google: googleOAuth } : {}),
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

		// The bus itself always exists — only the email consumer (courier) is
		// SMTP-gated.
		if (smtpHost) {
			// Courier must be registered HERE, on the publisher, even though this
			// process may never send: consumer rows are written at publish time
			// from the publisher's own subscriptions, so without it every
			// notification is stored owing nobody. See notifications.ts.
			fonderieApp = fonderieApp
				.register(eventsModule)
				.register(buildCourierModule(store, notifyBus));

			// Who actually delivers depends on the deployment, and the app has to
			// say which it is. Locally `npm run dev` starts the worker, which
			// LISTENs and sends within milliseconds. On Vercel there is no worker
			// and nothing else would ever read the outbox — so the API consumes
			// what it produced, after its own response. Set NOTIFY_DRAIN_IN_API to
			// force either behaviour (a serverless deploy that DOES run a worker,
			// or a long-running one that does not).
			const drainInApi = process.env.NOTIFY_DRAIN_IN_API
				? process.env.NOTIFY_DRAIN_IN_API === 'true'
				: isServerlessRuntime();
			if (drainInApi) {
				app.use(drainAfterResponse(notifyBus));
				console.log('📧 no worker here — the API drains its own notification queue');
			}
		} else {
			// Worth being blunt: this is not "email is off for now". Consumer rows
			// are written by the PUBLISHER at publish time, so with courier absent
			// here every notification is stored owing nobody — configuring SMTP on
			// the worker later will not deliver a single one of them.
			console.warn(
				'⚠️  SMTP_HOST not set — transactional email disabled. Events published now get NO consumer row and can never be delivered, even after SMTP is configured later.',
			);
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
		engine = new RiskEngine(store, {
			rulesets: DEFAULT_RULESETS,
			pepper: process.env.RISK_PEPPER,
		});
		const riskEngine = engine;
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
		// The retention purge runs on a timer — NOT on the request path (an
		// attacker who never checks out would never trigger it). Owning a timer
		// needs process lifetime, so the long-running entry (index.ts) starts it
		// from the returned engine; a frozen serverless instance can't be trusted
		// with one and pings the cron route below instead.

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

				// Drain before reporting, for two reasons: the numbers below then
				// describe what is genuinely stuck rather than what merely had not
				// been picked up yet, and this is the backstop for anything the
				// per-response drain missed — a row whose instance died mid-send,
				// or one published while no traffic followed to trigger a drain.
				//
				// Whether it SUCCEEDED is reported below. A drain must never fail the
				// cron, but swallowing it silently would recreate the exact blindness
				// this route exists to remove: a queue that cannot be consumed at all
				// — an unapplied migration, a revoked credential — looks identical to
				// an idle one, since `pending` stays 0 only because nothing was ever
				// claimed. The response says which.
				const transport = notifications;
				let drainError: string | null = null;
				await transport.drain({ maxMs: 20_000 }).catch((err) => {
					drainError = explainDrainFailure(err);
					console.error('[queue] cron drain failed:', drainError);
				});

				// Surface the queue's health while we're here. A dead row is durable,
				// was retried, and will never be delivered — but until something
				// LOOKS, a queue that has stopped delivering is indistinguishable
				// from one with nothing to do. Logged loudly so it reaches the
				// platform logs rather than dying in a table nobody queries.
				//
				// `delivered` reads COURIER'S log, not the outbox — they disagree,
				// and only one of them is about email.
				//
				// Courier catches a send failure, records it, and does NOT rethrow
				// (dispatcher.ts), so the event handler resolves and the outbox
				// marks the row `processed`. An SMTP rejection therefore looks
				// exactly like a success in fonderie_event_consumers, and the
				// outbox's retry/dead-letter machinery never sees it — `dead` stays
				// 0 no matter how badly email is failing. Counting processed rows
				// answers "was the event dispatched", which is not the question.
				//
				// fonderie_message_log is where the send outcome actually lands:
				// status 'sent' or 'failed', with the provider's error.
				const [dead, pending, delivered] = await Promise.all([
					transport.deadLetters(10),
					transport.pendingCount(),
					store
						.query<{ status: string; count: string; last: Date | null; err: string | null }>(
							`SELECT status, count(*)::text AS count, max(created_at) AS last,
							        (array_agg(error ORDER BY created_at DESC) FILTER (WHERE error IS NOT NULL))[1] AS err
							   FROM fonderie_message_log
							  WHERE created_at > now() - interval '24 hours'
							  GROUP BY status`,
						)
						.then((rows) => {
							const of = (s: string) => rows.find((r) => r.status === s);
							const sent = of('sent');
							const failed = of('failed');
							return {
								sent24h: Number(sent?.count ?? 0),
								lastSentAt: sent?.last ? new Date(sent.last).toISOString() : null,
								failed24h: Number(failed?.count ?? 0),
								// WHEN it last failed decides whether a failure is history
								// or an outage: the same error from before a fix looks
								// identical to one happening right now.
								lastFailedAt: failed?.last ? new Date(failed.last).toISOString() : null,
								...(failed?.err ? { lastError: failed.err } : {}),
								pending24h: Number(of('pending')?.count ?? 0),
							};
						})
						.catch((err) => ({ error: err instanceof Error ? err.message : String(err) })),
				]);
				if (dead.length > 0) {
					console.error(
						`[queue] ${dead.length} dead notification(s) — these will NEVER be delivered:`,
						dead.map((d) => `${d.type} (${d.consumer}): ${d.lastError ?? 'no error recorded'}`),
					);
				}

				// The same question, asked of money.
				//
				// A stale STRIPE_WEBHOOK_SECRET is the worst kind of outage: Stripe
				// charges the card and reports success, our endpoint rejects the
				// signature with a 400 that only exists in a log, and the customer
				// is left paid-up with nothing credited. Nothing in the product
				// looks wrong until someone complains.
				//
				// These two timestamps are what a webhook actually MOVES, so they
				// answer it without Stripe API access: provider_event_at advances
				// only when a subscription webhook is accepted, and a purchase row
				// is written only when a payment webhook credits the wallet. After
				// re-pointing an endpoint or rotating a secret, send a test event
				// and watch them move.
				const billing = await Promise.all([
					// The count comes along because `lastWebhookAt: null` on its own
					// means two opposite things — nobody has ever subscribed, or
					// subscriptions exist and no webhook has ever been accepted for
					// them. Only the second is an outage, and the number is what
					// tells them apart.
					store.query<{ total: string; last: Date | null }>(
						`SELECT count(*)::text AS total, max(provider_event_at) AS last
						   FROM fonderie_subscriptions`,
					),
					store.query<{ count: string; last: Date | null }>(
						`SELECT count(*)::text AS count, max(created_at) AS last
						   FROM fonderie_wallet_ledger
						  WHERE type = 'purchase' AND created_at > now() - interval '24 hours'`,
					),
				])
					.then(([[sub], [buy]]) => ({
						subscriptions: Number(sub?.total ?? 0),
						lastWebhookAt: sub?.last ? new Date(sub.last).toISOString() : null,
						purchases: {
							last24h: Number(buy?.count ?? 0),
							lastAt: buy?.last ? new Date(buy.last).toISOString() : null,
						},
					}))
					.catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
				return res.json({
					ok: true,
					billing,
					email: delivered,
					queue: {
						dead: dead.length,
						pending,
						...(drainError ? { drainError } : {}),
					},
				});
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

	// Liveness probe. Minimal ON PURPOSE — it used to report `fonderie: true`
	// and the installed module list, which tells a scanner the stack AND that
	// auth/billing/media are present. That is the inventory an attacker wants;
	// a probe only needs the 200.
	app.get('/health', (_req, res) => {
		res.json({ status: 'ok' });
	});

	// What the frontend is allowed to offer, decided by the server.
	//
	// The alternative is a build-time VITE_ flag, which is the same fact stored
	// twice: the app would claim Google is available while the API had it
	// disabled, and the mismatch surfaces as a user hitting a dead redirect.
	// Asking the side that actually holds the credentials makes that
	// unrepresentable. Deliberately says nothing about the stack — no module
	// list, no versions, just the buttons to draw.
	app.get('/config', (_req, res) => {
		res.json({ auth: { providers: authProviders } });
	});

	// The API host is not a page. It used to answer with the product name, a
	// version and a list of the auth endpoints. A browser that lands here now
	// goes to the app; anything else sees what any unknown path returns.
	// Uniform for every caller on purpose: branching on Accept would itself be
	// a fingerprint, and it makes debugging with curl worse.
	app.get('/', (_req, res) => {
		if (frontendUrl) return res.redirect(302, frontendUrl);
		return res.status(404).json({ reason: 'NOT_FOUND', explanation: 'Not found' });
	});

	return { riskEngine: engine };
}
