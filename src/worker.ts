import 'dotenv/config';
import { PGAdapter } from '@fonderie/store';
import { FonderieApp, defineConfig } from '@fonderie/core';
import { buildCourierModule, createNotifyBus, emailConfigured } from './notifications.js';
import {
	debitWallet,
	getSubscription,
	InsufficientFundsError,
	currentGrantPeriod,
	startOfNextPeriod,
} from '@fonderie/billing';

import {
	createScrapeBus,
	SCRAPE_TASK_EVENT,
	SCRAPE_CONSUMER,
	type ScrapeTaskJob,
} from './queue/scrapeQueue.js';
import { scrapeGoogleMaps } from './scraper/engine.js';
import { effectivePlanName, resolveScrapeCharge } from './billing/catalog.js';

/**
 * Human ledger line for a completed scrape. Prefers the task's structured form
 * params; legacy url-only tasks fall back to the Maps URL's decoded search
 * text. Never the raw URL — that stays in the debit's metadata, not in a
 * user-facing ledger description.
 */
export function scrapeDescription(
	params: { keyword?: string; location?: string } | null,
	url: string,
): string {
	if (params?.keyword && params.location) {
		return `Scrape completed: ${params.keyword} — ${params.location}`;
	}
	const search = url.match(/\/maps\/search\/([^/?#]+)/);
	if (search) {
		try {
			return `Scrape completed: ${decodeURIComponent(search[1]!).replace(/\+/g, ' ')}`;
		} catch {
			// Malformed escape in a hand-crafted URL — fall through to the bare line.
		}
	}
	return 'Scrape completed';
}

/**
 * Scrape-task queue worker. Runs as its own process (`npm run worker`),
 * consuming scrape jobs from the durable Postgres event bus and driving the
 * Playwright scraper engine, persisting results back onto the task row.
 */
async function main() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		console.error('DATABASE_URL is not set — the worker needs it to read the job queue.');
		process.exit(1);
	}

	const store = new PGAdapter(databaseUrl);
	const bus = createScrapeBus(databaseUrl);

	// ── Notification consumer ────────────────────────────────────────
	// The API publishes notification rows durably but never consumes them: a
	// serverless instance is frozen the moment it responds, so a send started
	// there is abandoned. This process outlives its work, so it owns delivery —
	// it LISTENs for new rows and sends, and a failure is RETRIED rather than
	// lost, which is the part awaiting inside the request could never give us.
	//
	// Needs the DIRECT connection: LISTEN is not supported through a
	// transaction-mode pooler.
	if (emailConfigured()) {
		const { module: notifications } = createNotifyBus(databaseUrl, { consume: true });
		await new FonderieApp(defineConfig({ db: { url: databaseUrl } }))
			.register(notifications)
			.register(buildCourierModule(store, notifications.bus))
			.boot();
		console.log('📧 notification consumer started — delivering queued email');
	} else {
		console.warn('⚠️  SMTP_HOST not set — queued notifications will not be delivered.');
	}

	bus.on<ScrapeTaskJob>(
		SCRAPE_TASK_EVENT,
		async ({ taskId }) => {
			console.log(`Processing task ${taskId}`);

			try {
				const rows = await store.query<{
					user_id: string;
					url: string;
					limit: number | null;
					params: { keyword?: string; location?: string } | null;
				}>('SELECT user_id, url, "limit", params FROM scrape_tasks WHERE id = $1', [taskId]);
				const task = rows[0];
				if (!task) {
					console.warn(`Task ${taskId} not found — skipping.`);
					return;
				}

				await store.query(
					"UPDATE scrape_tasks SET status = 'scraping', updated_at = now() WHERE id = $1",
					[taskId],
				);

				const leads = await scrapeGoogleMaps({
					url: task.url,
					limit: task.limit ?? undefined,
				});

				// Success = charge the plan's per-scrape rate through the billing
				// wallet, then mark the task complete. The debit is idempotent
				// (idempotencyKey = taskId → a queue redelivery never double-charges)
				// and floored (overdraftLimit from the plan → the balance can never
				// go negative). A failed scrape (catch below) never reaches here, so
				// it is never charged; a completed scrape the wallet can't cover is
				// marked 'error' rather than delivered for free. Unlimited plans have
				// no rate (resolveScrapeCharge → null), so scraping is free for them.
				const sub = await getSubscription('user', task.user_id, store);
				// Status-aware: a canceled/lapsed subscription entitles nothing — its row
				// still names the plan, so keying on plan alone would scrape free forever.
				const charge = resolveScrapeCharge(effectivePlanName(sub));
				if (charge) {
					try {
						await debitWallet(
							{
								subscriberType: 'user',
								subscriberId: task.user_id,
								currency: charge.currency,
								amount: charge.cost,
								idempotencyKey: taskId,
								overdraftLimit: charge.overdraftLimit,
								type: 'usage',
								description: scrapeDescription(task.params, task.url),
								metadata: { taskId, url: task.url },
								// Settle a stale allowance in the same tx as the spend, so a
								// scrape that completes after a period rollover can't spend
								// last period's expired free credits.
								allowance: {
									period: currentGrantPeriod(charge.grantPeriod),
									rollover: charge.grantRollover,
									expiresAt: startOfNextPeriod(charge.grantPeriod),
								},
							},
							store,
						);
					} catch (chargeErr) {
						if (chargeErr instanceof InsufficientFundsError) {
							await store.query(
								"UPDATE scrape_tasks SET status = 'error', error_message = $1, updated_at = now() WHERE id = $2",
								['Insufficient credits', taskId],
							);
							console.warn(
								`Task ${taskId} scraped but the wallet can't cover it — marked error, not charged.`,
							);
							return;
						}
						throw chargeErr;
					}
				}
				await store.query(
					"UPDATE scrape_tasks SET results = $1::jsonb, status = 'complete', updated_at = now() WHERE id = $2",
					[JSON.stringify(leads), taskId],
				);
				console.log(
					`Task ${taskId} complete — ${leads.length} lead(s)` +
						(charge ? `, ${charge.cost} credit(s) charged.` : ' (unlimited plan, no charge).'),
				);
			} catch (err) {
				// Record the failure on the task and swallow the error so the job is
				// marked processed rather than retried forever by the transport.
				const message = err instanceof Error ? err.message : String(err);
				console.error(`Task ${taskId} failed:`, message);
				try {
					await store.query(
						"UPDATE scrape_tasks SET status = 'error', error_message = $1, updated_at = now() WHERE id = $2",
						[message, taskId],
					);
				} catch (updateErr) {
					console.error(`Failed to record error for task ${taskId}:`, updateErr);
				}
			}
		},
		SCRAPE_CONSUMER,
	);

	await bus.start();
	console.log('🛠️  scrape-task worker started — waiting for jobs…');

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		// A second signal (or a wrapper like `tsx watch`) forces immediate exit.
		if (shuttingDown) process.exit(1);
		shuttingDown = true;
		console.log(`\n${signal} received — stopping worker…`);

		// Hard fallback: if graceful stop stalls (e.g. an in-flight Playwright
		// scrape keeps a Chrome subprocess alive and the event loop busy), exit
		// anyway so the process never hangs a watcher/supervisor. `.unref()` keeps
		// this timer from itself holding the process open.
		const forceExit = setTimeout(() => {
			console.error('Graceful shutdown timed out — forcing exit.');
			process.exit(1);
		}, 3000);
		forceExit.unref();

		try {
			await bus.stop();
		} catch (err) {
			console.error('Error during shutdown:', err);
		} finally {
			clearTimeout(forceExit);
			process.exit(0);
		}
	};
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
	console.error('Worker failed to start:', err);
	process.exit(1);
});
