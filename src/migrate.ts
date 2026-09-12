import 'dotenv/config';
import { InternalMigrationRunner, PGAdapter } from '@fonderie/store';
import { getMigrationsPath as authMigrationsPath } from '@fonderie/auth/migrations';
import { getMigrationsPath as eventsMigrationsPath } from '@fonderie/events/migrations';
import { getMigrationsPath as courierMigrationsPath } from '@fonderie/courier/migrations';
import { getMigrationsPath as billingMigrationsPath } from '@fonderie/billing/migrations';
import { getMigrationsPath as mediaMigrationsPath } from '@fonderie/media/migrations';
import { getMigrationsPath as storageMigrationsPath } from '@fonderie/storage/migrations';
import { getMigrationsPath as riskMigrationsPath } from '@fonderie/risk/migrations';

import { getAppMigrationsPath } from './db/migrations/index.js';

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
 * Order matters: auth owns fonderie_users, which the app migration extends,
 * and media's assets reference storage's blobs. Same sequence the long-lived
 * server runs at boot, kept here as the single source of truth.
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

	const steps: Array<[string, string]> = [
		['auth', authMigrationsPath()],
		['events', eventsMigrationsPath()],
		['app', getAppMigrationsPath()],
		['risk', riskMigrationsPath()],
		['courier', courierMigrationsPath()],
		['billing', billingMigrationsPath()],
		['storage', storageMigrationsPath()],
		['media', mediaMigrationsPath()],
	];

	for (const [name, path] of steps) {
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
