import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/index.js';

/**
 * Vercel serverless entry. Everything under vercel.json's rewrite lands here
 * and is handed to the same Express app the long-lived server uses.
 *
 * The app is built ONCE per instance and cached as a promise: a warm
 * invocation reuses it (no re-boot, no new PG pool), and concurrent cold
 * requests await the same build instead of racing to boot several copies.
 *
 * migrate:false / timers:false are the serverless contract — schema changes
 * belong to `npm run migrate`, and the retention purge to the cron ping, since
 * an instance is frozen between requests.
 */
let appPromise: ReturnType<typeof createApp> | undefined;

function getApp() {
	appPromise ??= createApp({
		migrate: false,
		timers: false,
		// One connection per instance: a function serves one request at a time,
		// and every warm instance would otherwise hold pg's default pool of 10
		// against the shared pooler.
		poolMax: Number(process.env.PG_POOL_MAX ?? 1),
	}).catch((err) => {
		// Don't cache a failed boot — the next request should retry rather than
		// serve a permanently broken instance from a transient DB hiccup.
		appPromise = undefined;
		throw err;
	});
	return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
	const app = await getApp();
	app(req, res);
}
