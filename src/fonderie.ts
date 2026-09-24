import 'dotenv/config';
import { FonderieApp, defineConfig, installPlatformBackgroundRunner, isServerlessRuntime } from '@fonderie/core';
import { InternalMigrationRunner, PGAdapter } from '@fonderie/store';
import { AuthModule } from '@fonderie/auth';
import { buildCourierModule, createNotifyBus } from './notifications.js';
import { explainDrainFailure } from '@fonderie/events';
import { messageStats } from '@fonderie/courier';
import {
	BillingModule,
	StripeProvider,
	SUPPORTED_PAYMENT_OPTIONS,
	checkPriceConsistency,
	describePriceProblems,
	webhookStats,
} from '@fonderie/billing';
import type { ResolveRecipient } from '@fonderie/billing';
import { MediaModule, DbBlobProvider } from '@fonderie/media';
import { adapt, cors, drainQueue, mount } from '@fonderie/adapter-express';
import { DEFAULT_CORS_HEADERS } from '@fonderie/core/middlewares';
import { byIp, rateLimit, StoreAdapterStore } from '@fonderie/rate-limit';
import type { Express } from 'express';

import { requireAuth } from './auth/requireAuth.js';
import {
	purgeExpiredHandoffs,
	registerGoogleExchangeRoute,
	registerGoogleRedirectRoutes,
} from './auth/googleWeb.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { PLANS, CREDIT_PACKS, WALLET_CURRENCY, WALLET_PRECISION } from './billing/catalog.js';
import { MIGRATION_STEPS } from './db/migrations/steps.js';
import { AdminModule, collectChecks, runDoctor } from '@fonderie/admin';
import { RiskEngine, DEFAULT_RULESETS } from '@fonderie/risk';
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
		// A redirect URI that is merely PRESENT is not enough — Google compares
		// it LITERALLY, so a wrong one fails at the END of the flow, on Google's
		// error page, after the user has already committed. Cheap to catch here.
		//
		// Note `new URL()` is not the check: "https://https://host/path" parses
		// happily, with hostname "https" and the real host buried in the path.
		// And endsWith('/auth/google/callback') accepts "/v1/auth/google/callback"
		// too. Both of those were my first attempt, and both let the broken value
		// through — the path must match EXACTLY, and the scheme must appear once.
		if (googleOAuth) {
			const raw = googleOAuth.redirectUri;
			const problems: string[] = [];
			if (raw.split('://').length > 2) {
				problems.push('contains "://" more than once — the scheme is duplicated');
			}
			let parsed: URL | null = null;
			try {
				parsed = new URL(raw);
			} catch {
				problems.push('is not a valid URL');
			}
			if (parsed) {
				if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
					problems.push(`uses ${parsed.protocol}// — Google requires https outside localhost`);
				}
				if (parsed.pathname !== '/auth/google/callback') {
					problems.push(
						`has path "${parsed.pathname}" but this API serves auth at the ROOT, so it must be exactly /auth/google/callback (no /v1 here)`,
					);
				}
			}
			if (problems.length > 0) {
				console.warn(
					`⚠️  GOOGLE_REDIRECT_URI will be rejected by Google: it ${problems.join('; and it ')}. ` +
						`Value seen: ${raw}`,
				);
			}
		}
		if (!googleOAuth && (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_SECRET)) {
			console.warn(
				'⚠️  Google sign-in is PARTIALLY configured and therefore disabled — ' +
					'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI are all required.',
			);
		}

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
					// Where this API answers from, basePath included. Only used by
					// the doctor's webhook-registration check, which compares by
					// exact URL and must never guess a hostname. Unset ⇒ that check
					// reports itself skipped — and an endpoint registered at a stale
					// URL is silent until a payment goes missing.
					...(process.env.PUBLIC_API_URL ? { publicUrl: process.env.PUBLIC_API_URL } : {}),
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
				app.use(drainQueue(notifyBus));
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

		// The one check no brick can own: a brick knows its own migrations, not
		// which sets this deployment applies or in what order. Code goes live
		// ahead of the schema on every external-migration target, and the
		// symptom never mentions migrations — so it is asked here.
		//
		// Defined once and handed to both consumers: the dashboard's
		// /_admin/doctor and the cron below. Two copies would drift, and the
		// operator would be told one thing by the page and another by the log.
		const migrationsCheck = {
			name: 'app.migrations',
			run: async () => {
				const per = await Promise.all(
					MIGRATION_STEPS.map(async ([name, path]) => {
						const files = await new InternalMigrationRunner(store, path).pending();
						return { name, files };
					}),
				);
				const behind = per.filter((x) => x.files.length > 0);
				return {
					ok: behind.length === 0,
					findings: behind.map(
						(x) => `${x.name}: ${x.files.length} migration(s) not applied — ${x.files.join(', ')}`,
					),
				};
			},
		};

		// The operator's surface. Every brick DESCRIBES its admin routes and
		// checks; this module composes them behind one token at /_admin, logs
		// every request (including refused ones), and can mint scoped tokens so
		// a dashboard never holds the root. Unset ADMIN_TOKEN ⇒ no surface at
		// all (404), which is what preview deployments get.
		//
		// `env` is presence-only: /_admin/config reports whether each name is
		// set, never its value. Bricks never read process.env — config is
		// injected — so only this file can say which names matter.
		fonderieApp = fonderieApp.register(
			new AdminModule({
				...(process.env.ADMIN_TOKEN ? { adminToken: process.env.ADMIN_TOKEN } : {}),
				store,
				// Serve the dashboard at /_admin/ui. This app has no operator
				// frontend of its own — luna-app is the customer's — so without
				// this the surface is JSON only and the visibility it exists to
				// give would need curl.
				ui: true,
				// Answer only for the hostnames named here. Vercel routes every
				// alias and every preview URL to the same instance, so the surface
				// is otherwise reachable at addresses nobody thinks of as the API.
				// Unset ⇒ any host, which is the right default for local work.
				...(process.env.ADMIN_HOST
					? {
							host: process.env.ADMIN_HOST.split(',')
								.map((x) => x.trim())
								.filter(Boolean),
						}
					: {}),
				env: [
					'DATABASE_URL',
					'JWT_SECRET',
					'STRIPE_SECRET_KEY',
					'STRIPE_WEBHOOK_SECRET',
					'STRIPE_WALLET_WEBHOOK_SECRET',
					'SMTP_HOST',
					'SMTP_USER',
					'SMTP_PASS',
					'SMTP_FROM',
					'PUBLIC_API_URL',
					'FRONTEND_URL',
					'CRON_SECRET',
					'RISK_PEPPER',
					'ADMIN_TOKEN',
					'ADMIN_HOST',
				],
				checks: [migrationsCheck],
				// The SAME constant migrate.ts applies, so the panel can never
				// offer an order the applier would not run — and the reporter
				// above and the applier here cannot disagree about what exists.
				// Reports every module's pending files with their impact, and
				// applies a module whose pending set is entirely additive;
				// refuses anything that deletes data, and anything sitting
				// behind a module that is itself behind.
				migrations: MIGRATION_STEPS,
			}),
		);

		const fonderie = await fonderieApp.boot();

		// The same checks the /_admin/doctor page serves, for the cron below to
		// run and LOG. collectChecks reads every registered module's description,
		// so a brick added later is covered without touching this file.
		const adminChecks = collectChecks(fonderie, [migrationsCheck]);

		// The catalog declares a price AND Stripe holds one, and which of the two
		// the customer actually pays depends on the purchase path: hosted checkout
		// charges Stripe's price, while the saved-card and auto-recharge paths
		// charge the catalog's priceAmount/currency. Nothing made them agree, and
		// the failure is silent — each path is internally consistent, so the only
		// symptom is that the same pack costs different amounts depending on how
		// it was bought. (It really happened: the catalog said usd against Stripe
		// prices in cad, same figures, ~37% apart.)
		//
		// Deliberately fire-and-forget: reading prices is a network call, and a
		// diagnostic must not delay or fail a boot. Skipped without a real key —
		// the provider above falls back to a placeholder, and a check that cries
		// wolf on every local run is a check people learn to ignore.
		if (process.env.STRIPE_SECRET_KEY) {
			void checkPriceConsistency(stripeProvider, {
				plans: PLANS,
				wallet: { creditPacks: CREDIT_PACKS },
			})
				.then((report) => {
					for (const line of describePriceProblems(report)) {
						console.error('[billing] price mismatch:', line);
					}
				})
				.catch((err) => {
					console.error('[billing] price check failed:', err);
				});
		}

		// mount() wires body parsing, context (bridge), and the auth routes onto
		// Express. bridge runs first, so custom routes added below see req._fonderie.
		// BEFORE mount(): the catch-all would otherwise serve the package's
		// JSON callback, which renders tokens in the browser. Only registered
		// when Google is actually configured, so the routes cannot exist in a
		// state where they would fail.
		if (googleOAuth) {
			registerGoogleRedirectRoutes(app, fonderie, store, frontendUrl);
		}

		mount(app, fonderie);

		// AFTER mount(): this one needs the body bridge() parses.
		if (googleOAuth) registerGoogleExchangeRoute(app, store);

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
				await purgeExpiredHandoffs(store).catch((err) =>
					console.error('[auth:google] handoff purge failed:', err),
				);

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
				// courier's messageStats() is where the send outcome actually lands.
				//
				// Each number now comes from the package that OWNS the table. This
				// block used to hand-write SQL against other packages' schemas —
				// which is exactly how a wrong column name once shipped and threw
				// on every real database.
				// The five reconciliation checks, the outbox and the schema used to be
				// hand-wired here — 200 lines of them, reporting into console.error and
				// reachable only by curling this route. Every one of them is now
				// DESCRIBED by the brick that owns it (@fonderie/billing, courier,
				// events) or supplied by this app (migrations), and @fonderie/admin
				// serves them at GET /_admin/doctor with the same code this runs.
				//
				// The doctor is on demand; the cron is what ALERTS. So run the same
				// checks here and log what they find — a check nobody reads is not a
				// check. Report, do not repair: nothing below corrects anything.
				const report = await runDoctor(adminChecks, 20_000);
				for (const c of report.checks) {
					if (c.skipped) continue;
					for (const line of c.findings) {
						// A finding on a PASSING check is advice (a p=none DMARC policy, an
						// endpoint on another API version); only !ok is a hard failure.
						console[c.ok ? 'warn' : 'error'](`[doctor] ${c.name}: ${line}`);
					}
				}

				// Instruments, not checks: numbers with no pass/fail, kept because the
				// cron's log line is where this deployment watches them.
				const [email, billing] = await Promise.all([
					messageStats(store, { hours: 24 }).catch((err) => ({
						error: err instanceof Error ? err.message : String(err),
					})),
					webhookStats(store, { hours: 24 }).catch((err) => ({
						error: err instanceof Error ? err.message : String(err),
					})),
				]);

				return res.json({
					ok: report.ok,
					doctor: report,
					email,
					billing,
					...(drainError ? { drainError } : {}),
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
