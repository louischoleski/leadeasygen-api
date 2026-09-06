import type { NextFunction } from 'express';
import {
	requireAuth as fonderieRequireAuth,
	type ExpressRequest,
	type ExpressResponse,
} from '@fonderie/adapter-express';
import type { IStoreAdapter } from '@fonderie/store/types';

/** The current user attached to the request after `requireAuth`. */
export interface AuthedUser {
	id: string;
	email: string | null;
	displayName: string | null;
	createdAt: Date;
}

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			user?: AuthedUser;
		}
	}
}

interface UserRow {
	id: string;
	email: string | null;
	display_name: string | null;
	created_at: Date;
}

function unauthorized(res: ExpressResponse): void {
	res.statusCode = 401;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Unauthorized' }));
}

/**
 * Loads the authenticated user's record from `fonderie_users` and attaches it
 * to `req.user`. Runs only after `fonderieRequireAuth` has validated the
 * session, so the fonderie context and its user id are guaranteed present.
 *
 * The credit balance is NOT read here anymore: `@fonderie/billing`'s
 * `withBilling` middleware (registered globally) applies the free plan's
 * monthly grant and exposes the live balance on the request context, which the
 * read sites pull via `getWalletStatus(ctx)`. There is no product `credits`
 * column to load and no grant to trigger.
 */
function attachUser(store: IStoreAdapter) {
	return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction): Promise<void> => {
		const userId = (req._fonderie as { user?: { id?: string } } | undefined)?.user?.id;

		if (!userId) {
			unauthorized(res);
			return;
		}

		try {
			const rows = await store.query<UserRow>(
				'SELECT id, email, display_name, created_at FROM fonderie_users WHERE id = $1 AND deleted_at IS NULL',
				[userId],
			);
			const row = rows[0];

			if (!row) {
				unauthorized(res);
				return;
			}

			(req as ExpressRequest & { user?: AuthedUser }).user = {
				id: row.id,
				email: row.email,
				displayName: row.display_name,
				createdAt: row.created_at,
			};
			next();
		} catch (err) {
			next(err);
		}
	};
}

/**
 * `requireAuth` for custom Express routes: validates the Fonderie session
 * (401 on failure) and then attaches `req.user`. The credit balance lives on
 * the billing wallet (read via `getWalletStatus`), not on `req.user`.
 * Spread into a route: `app.get('/x', ...requireAuth(store), handler)`.
 */
export function requireAuth(store: IStoreAdapter) {
	return [fonderieRequireAuth, attachUser(store)];
}

export default requireAuth;
