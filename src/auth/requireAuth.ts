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
	credits: number;
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
	credits: number;
	created_at: Date;
}

function unauthorized(res: ExpressResponse): void {
	res.statusCode = 401;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Unauthorized' }));
}

/**
 * Loads the authenticated user's full record (including the product-specific
 * `credits` balance) from `fonderie_users` and attaches it to `req.user`.
 * Runs only after `fonderieRequireAuth` has validated the session, so the
 * fonderie context and its user id are guaranteed present.
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
				'SELECT id, email, display_name, credits, created_at FROM fonderie_users WHERE id = $1 AND deleted_at IS NULL',
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
				credits: row.credits,
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
 * (401 on failure) and then attaches the full `req.user` (with `credits`).
 * Spread into a route: `app.get('/x', ...requireAuth(store), handler)`.
 */
export function requireAuth(store: IStoreAdapter) {
	return [fonderieRequireAuth, attachUser(store)];
}

export default requireAuth;
