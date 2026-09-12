import 'dotenv/config';
import express from 'express';

import { configureApp } from './app.js';

/**
 * The one entry, for both homes:
 *
 *   • Vercel — detects the Express app and serves the default export below.
 *     Migrations do NOT run on cold start (every instance would re-run them
 *     and race), and the in-process timers are off (an instance is frozen
 *     between requests) — `npm run migrate` and the cron in vercel.json own
 *     those instead. Each instance holds ONE connection, since it serves one
 *     request at a time and every warm instance would otherwise keep pg's
 *     default pool of 10 against the shared pooler.
 *   • Local / Docker — runs a long-running server via listen() below;
 *     migrations and timers run at boot for convenience.
 */
const app = express();

const onVercel = !!process.env.VERCEL;

await configureApp({
	app,
	migrate: !onVercel,
	timers: !onVercel,
	...(onVercel ? { poolMax: Number(process.env.PG_POOL_MAX ?? 1) } : {}),
});

// Vercel entrypoint: default-export the Express app.
export default app;

// Local / Docker: start a long-running server (skipped on Vercel).
if (!onVercel) {
	const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
	app.listen(port, () => {
		console.log(`🚀 Server ready at http://localhost:${port}`);
		console.log(`📚 Auth routes: http://localhost:${port}/auth`);
	});
}
