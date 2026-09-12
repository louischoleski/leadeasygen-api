import 'dotenv/config';
import { createApp } from './index.js';

/**
 * Long-lived server entry: local dev (`npm run dev`) and the container on a
 * box. Owns migrations and the in-process timers — the serverless entry
 * (api/index.ts) deliberately does neither.
 */
async function main() {
	const app = await createApp();
	const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
	app.listen(port, () => {
		console.log(`🚀 Server ready at http://localhost:${port}`);
		console.log(`📚 Auth routes: http://localhost:${port}/auth`);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
