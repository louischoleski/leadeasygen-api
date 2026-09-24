import { getMigrationsPath as authMigrationsPath } from '@fonderie/auth/migrations';
import { getMigrationsPath as eventsMigrationsPath } from '@fonderie/events/migrations';
import { getMigrationsPath as courierMigrationsPath } from '@fonderie/courier/migrations';
import { getMigrationsPath as billingMigrationsPath } from '@fonderie/billing/migrations';
import { getMigrationsPath as mediaMigrationsPath } from '@fonderie/media/migrations';
import { getMigrationsPath as storageMigrationsPath } from '@fonderie/storage/migrations';
import { getMigrationsPath as riskMigrationsPath } from '@fonderie/risk/migrations';
import { getMigrationsPath as adminMigrationsPath } from '@fonderie/admin/migrations';
import { getMigrationsPath as rateLimitMigrationsPath } from '@fonderie/rate-limit/migrations';

import { getAppMigrationsPath } from './index.js';

/**
 * Every migration set this deployment owns, in the order they must be applied.
 *
 * Order matters: auth owns fonderie_users, which the app migration extends, and
 * media's assets reference storage's blobs.
 *
 * A package being INSTALLED does not put it here — but a package whose tables
 * this app reads at runtime must be. rate-limit was missing for exactly that
 * reason: it is imported and configured with a Postgres-backed store, and its
 * migration was never listed, so fonderie_rate_limits did not exist. The
 * limiter fails OPEN, so the checkout brake was silently allowing everything
 * with nothing in any log to show it.
 *
 * Shared deliberately. `migrate.ts` APPLIES these and the ops route REPORTS on
 * them, and a list copied into both would be one package-add away from
 * disagreeing — at which point the reporter says "up to date" about a set it
 * does not know exists. That is the same declared-vs-actual gap the ops route
 * exists to close, so it should not be reintroduced inside it.
 */
export const MIGRATION_STEPS: ReadonlyArray<readonly [name: string, path: string]> = [
	// No foreign keys of its own, so it can go first.
	['rate-limit', rateLimitMigrationsPath()],
	['auth', authMigrationsPath()],
	['events', eventsMigrationsPath()],
	['app', getAppMigrationsPath()],
	['risk', riskMigrationsPath()],
	// The admin surface's own tables: the request log and the scoped tokens.
	['admin', adminMigrationsPath()],
	['courier', courierMigrationsPath()],
	['billing', billingMigrationsPath()],
	['storage', storageMigrationsPath()],
	['media', mediaMigrationsPath()],
];
