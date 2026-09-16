import 'dotenv/config';
import { InternalMigrationRunner, PGAdapter } from '@fonderie/store';

import { MIGRATION_STEPS } from './db/migrations/steps.js';

/**
 * Schema owner for deployments that don't migrate at boot — i.e. serverless,
 * where every cold start would re-run migrations on the request path and
 * concurrent instances would race each other.
 *
 * Run it once per deploy, against the DIRECT database connection (a
 * transaction-mode pooler breaks DDL sessions):
 *
 *   DATABASE_URL=<direct-connection> npm run migrate
 *
 * The sequence itself lives in ./db/migrations/steps.ts, shared with the ops
 * route that REPORTS which of them a database is missing — one list, so the
 * applier and the reporter cannot disagree about what exists.
 */
async function main() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		console.error('DATABASE_URL is not set.');
		process.exit(1);
	}

	const store = new PGAdapter(databaseUrl);
	if (!(await store.testConnection())) {
		throw new Error('Cannot connect to the database — check DATABASE_URL.');
	}

	for (const [name, path] of MIGRATION_STEPS) {
		process.stdout.write(`  ${name} … `);
		await new InternalMigrationRunner(store, path).run();
		console.log('done');
	}
	console.log('✅ migrations complete');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
