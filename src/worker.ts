import 'dotenv/config';
import { PGAdapter } from '@fonderie/store';

import {
	createScrapeBus,
	SCRAPE_TASK_EVENT,
	SCRAPE_CONSUMER,
	type ScrapeTaskJob,
} from './queue/scrapeQueue.js';
import { scrapeGoogleMaps } from './scraper/engine.js';

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

	bus.on<ScrapeTaskJob>(
		SCRAPE_TASK_EVENT,
		async ({ taskId }) => {
			console.log(`Processing task ${taskId}`);

			try {
				const rows = await store.query<{ user_id: string; url: string; limit: number | null }>(
					'SELECT user_id, url, "limit" FROM scrape_tasks WHERE id = $1',
					[taskId],
				);
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

				// Success = charge exactly one credit, atomically with the status
				// update: mark complete, append a 'usage' ledger row, decrement the
				// cache. A failed scrape (catch below) never reaches here, so it is
				// never charged.
				await store.transaction(async (tx) => {
					await tx.query(
						"UPDATE scrape_tasks SET results = $1::jsonb, status = 'complete', updated_at = now() WHERE id = $2",
						[JSON.stringify(leads), taskId],
					);
					await tx.query(
						"INSERT INTO credit_transactions (user_id, task_id, type, amount, description) " +
							"VALUES ($1, $2, 'usage', -1, $3)",
						[task.user_id, taskId, `Scrape completed: ${task.url}`],
					);
					await tx.query(
						'UPDATE fonderie_users SET credits = credits - 1, updated_at = now() WHERE id = $1',
						[task.user_id],
					);
				});
				console.log(`Task ${taskId} complete — ${leads.length} lead(s), 1 credit charged.`);
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
