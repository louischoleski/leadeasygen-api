import { getMigrationsPath as authMigrationsPath } from '@fonderie/auth/migrations';
import { getMigrationsPath as eventsMigrationsPath } from '@fonderie/events/migrations';
import { getMigrationsPath as courierMigrationsPath } from '@fonderie/courier/migrations';
import { getMigrationsPath as billingMigrationsPath } from '@fonderie/billing/migrations';
import { getMigrationsPath as mediaMigrationsPath } from '@fonderie/media/migrations';
import { getMigrationsPath as storageMigrationsPath } from '@fonderie/storage/migrations';
import { getMigrationsPath as riskMigrationsPath } from '@fonderie/risk/migrations';

import { getAppMigrationsPath } from './index.js';

/**
 * Every migration set this deployment owns, in the order they must be applied.
 *
 * Order matters: auth owns fonderie_users, which the app migration extends, and
 * media's assets reference storage's blobs.
 *
 * Shared deliberately. `migrate.ts` APPLIES these and the ops route REPORTS on
 * them, and a list copied into both would be one package-add away from
 * disagreeing — at which point the reporter says "up to date" about a set it
 * does not know exists. That is the same declared-vs-actual gap the ops route
 * exists to close, so it should not be reintroduced inside it.
 */
export const MIGRATION_STEPS: ReadonlyArray<readonly [name: string, path: string]> = [
	['auth', authMigrationsPath()],
	['events', eventsMigrationsPath()],
	['app', getAppMigrationsPath()],
	['risk', riskMigrationsPath()],
	['courier', courierMigrationsPath()],
	['billing', billingMigrationsPath()],
	['storage', storageMigrationsPath()],
	['media', mediaMigrationsPath()],
];
