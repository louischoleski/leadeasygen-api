import app, { riskEngine } from './app.js';

/**
 * Local / Docker entry — a long-running server. Vercel serves `app.ts`
 * directly (searched before index), so it never runs this file.
 *
 * Process-lifetime concerns live here for that reason: the retention purge
 * needs a timer, which only a long-running process can be trusted with. On
 * Vercel the same work is driven by the cron ping declared in vercel.json
 * (POST /internal/cron/purge).
 */
const engine = riskEngine;
if (engine) {
	setInterval(() => void engine.purgeExpired(), 6 * 60 * 60 * 1000).unref();
	void engine.purgeExpired();
}

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
app.listen(port, () => {
	console.log(`🚀 Server ready at http://localhost:${port}`);
	console.log(`📚 Auth routes: http://localhost:${port}/auth`);
});
