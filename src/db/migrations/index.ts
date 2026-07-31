import { createMigrationsPath } from '@fonderie/store/migrations';

/**
 * Absolute path to this app's own SQL migrations (the `sql/` folder beside
 * this file). Feed it to a store MigrationRunner. Because our migrations
 * touch the fonderie_-prefixed `fonderie_users` table, they must be run with
 * `InternalMigrationRunner`, not the public `MigrationRunner`.
 */
export function getAppMigrationsPath(): string {
	return createMigrationsPath(import.meta.url);
}
