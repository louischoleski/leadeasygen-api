import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { FonderieApp } from '@fonderie/core';
import type { IStoreAdapter } from '@fonderie/store/types';

/**
 * The browser half of Google sign-in.
 *
 * @fonderie/auth ships the OAuth mechanics — building the authorize URL,
 * binding a CSRF state cookie, exchanging the code, minting tokens. What it
 * cannot do is decide how a BROWSER should travel through that, because the
 * answer differs per client: a native app holds the tokens the callback
 * returns; a web SPA cannot, because it arrives there by redirect.
 *
 * Two routes bridge that, and each exists for a concrete reason:
 *
 *   GET /auth/google/start
 *     The SPA must NOT fetch() the authorize URL. googleInit sets `oauth_state`
 *     as a cookie on the API's domain, and a cross-site fetch from the app's
 *     domain cannot reliably store it — browsers block third-party cookie
 *     writes. The callback would then find no state and reject every sign-in.
 *     A top-level navigation here makes every cookie first-party.
 *
 *   GET /auth/google/callback
 *     Wraps the package's callback, which answers with the tokens as JSON —
 *     a browser would render credentials on screen. Instead the tokens are
 *     parked under a single-use code and the browser is redirected to the app,
 *     which exchanges the code over its own POST.
 */
const HANDOFF_TTL_SECONDS = 120;

export function registerGoogleRedirectRoutes(
	app: Express,
	fonderie: FonderieApp,
	store: IStoreAdapter,
	frontendUrl: string,
): void {
	// ── start ────────────────────────────────────────────────────────
	app.get('/auth/google/start', async (_req: Request, res: Response) => {
		const inner = await fonderie.handle(
			new Request('http://internal/auth/google', { method: 'GET' }),
		);
		const body = (await inner.json()) as { result?: { url?: string } };
		const url = body.result?.url;
		if (!url) return res.redirect(302, `${frontendUrl}/login?error=oauth_unavailable`);

		// Forward the state cookie VERBATIM. It is the CSRF binding the
		// callback checks; dropping it here turns every sign-in into a
		// "state mismatch" that looks like an attack rather than a bug.
		for (const cookie of inner.headers.getSetCookie?.() ?? []) {
			res.append('Set-Cookie', cookie);
		}
		return res.redirect(302, url);
	});

	// ── callback ─────────────────────────────────────────────────────
	app.get('/auth/google/callback', async (req: Request, res: Response) => {
		const target = new URL('http://internal/auth/google/callback');
		for (const [k, v] of Object.entries(req.query)) {
			if (typeof v === 'string') target.searchParams.set(k, v);
		}
		const inner = await fonderie.handle(
			new Request(target, { method: 'GET', headers: { cookie: req.headers.cookie ?? '' } }),
		);
		const body = (await inner.json()) as {
			reason?: string;
			result?: { tokens?: { access: string; refresh: string } };
		};

		if (!inner.ok || !body.result?.tokens) {
			// Never surface the provider's raw text to the browser — it is not
			// actionable by a user and may echo request details.
			console.error('[auth:google] callback failed:', inner.status, body.reason);
			return res.redirect(302, `${frontendUrl}/login?error=oauth_failed`);
		}

		const code = randomBytes(32).toString('hex');
		await store.query(
			`INSERT INTO oauth_handoff (code, payload, expires_at)
			 VALUES ($1, $2, now() + make_interval(secs => $3))`,
			[code, JSON.stringify(body.result.tokens), HANDOFF_TTL_SECONDS],
		);
		// Clear the state cookie: it has done its job and must not be replayable.
		res.append('Set-Cookie', 'oauth_state=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
		return res.redirect(302, `${frontendUrl}/auth/callback?code=${code}`);
	});
}

/**
 * Registered AFTER mount(), unlike the redirect routes above — and the
 * difference is not cosmetic.
 *
 * This app deliberately omits express.json() (it would drain the stream the
 * fonderie adapter re-reads), so `req.body` is populated by the adapter's
 * bridge(), which mount() installs. A route registered before mount() sees an
 * undefined body and rejects every valid code as missing — which is exactly
 * what happened on the first attempt.
 *
 * The redirect routes must come BEFORE mount() to beat its catch-all; this one
 * must come AFTER it to have a body. Both constraints are real.
 */
export function registerGoogleExchangeRoute(
	app: Express,
	store: IStoreAdapter,
): void {
	app.post('/auth/google/exchange', async (req: Request, res: Response) => {
		const code = (req.body as { code?: unknown } | undefined)?.code;
		if (typeof code !== 'string' || code.length < 32) {
			return res.status(400).json({ reason: 'INVALID_PARAMETER', explanation: 'Missing code' });
		}
		// Single-use enforced by the UPDATE itself: a replay matches no row,
		// so two requests can never both receive the tokens.
		const [row] = await store.query<{ payload: { access: string; refresh: string } }>(
			`UPDATE oauth_handoff
			    SET used_at = now()
			  WHERE code = $1 AND used_at IS NULL AND expires_at > now()
			 RETURNING payload`,
			[code],
		);
		if (!row) {
			return res
				.status(400)
				.json({ reason: 'INVALID_CODE', explanation: 'This sign-in link is no longer valid.' });
		}
		return res.json({ reason: 'GOOGLE_AUTH_OK', result: { tokens: row.payload } });
	});
}

/** Housekeeping for the cron: handoffs are worthless once expired. */
export async function purgeExpiredHandoffs(store: IStoreAdapter): Promise<void> {
	await store.query(`DELETE FROM oauth_handoff WHERE expires_at < now() - interval '1 day'`);
}
