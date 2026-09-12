import 'dotenv/config';
import express from 'express';

import { configureApp } from './fonderie.js';

/**
 * The Vercel entrypoint. Its Node web-server builder searches `app.*` →
 * `index.*` → `server.*` and serves the **default export**, so this file
 * default-exports the Express app and never listens — the long-running server
 * lives in `index.ts`, which Vercel therefore never runs.
 *
 * Importing `express` directly here is load-bearing: that import is how Vercel
 * detects which server to run.
 */
const app = express();

export const { riskEngine } = await configureApp({
	app,
	// One connection per serverless instance: it serves one request at a time,
	// and every warm instance would otherwise hold pg's default pool of 10
	// against the shared pooler. A long-running host keeps the default.
	...(process.env.VERCEL ? { poolMax: Number(process.env.PG_POOL_MAX ?? 1) } : {}),
});

export default app;
