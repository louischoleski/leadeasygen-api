import type { Express, Request, Response } from 'express';
import type { IStoreAdapter } from '@fonderie/store/types';
import type { IFonderieContext } from '@fonderie/core';
import { getWalletStatus } from '@fonderie/billing';

import { requireAuth } from '../auth/requireAuth.js';
import { enqueueScrapeTask } from '../queue/scrapeQueue.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the caller can afford one scrape, read from the billing wallet on
 * the request context (`withBilling` populates it for every authed request).
 * Returns true when there is nothing to gate on — no wallet, or an Unlimited
 * plan whose `scrape:task` rate is absent/zero — mirroring the authoritative
 * floor the worker's debit enforces at charge time (overdraftLimit). This is
 * the immediate UX guard, not the source of truth.
 */
function canAffordScrape(req: Request): boolean {
	const ctx = (req as Request & { _fonderie?: IFonderieContext })._fonderie;
	const wallet = ctx ? getWalletStatus(ctx) : null;
	const cost = wallet?.rates['scrape:task']?.cost;
	if (!wallet || cost === undefined || cost === 0n) return true;
	return wallet.balance - cost >= -wallet.overdraftLimit;
}

/** The caller's current wallet balance as a number, or null on Unlimited/none. */
function walletBalance(req: Request): number | null {
	const ctx = (req as Request & { _fonderie?: IFonderieContext })._fonderie;
	const wallet = ctx ? getWalletStatus(ctx) : null;
	return wallet ? Number(wallet.balance) : null;
}

/** A Google Maps URL is one pointing at maps or the app short-link host. */
function isGoogleMapsUrl(url: string): boolean {
	return url.includes('google.com/maps') || url.includes('maps.app.goo.gl');
}

interface TaskRow {
	id: string;
	url: string;
	limit: number | null;
	status: string;
	params: TaskParams | null;
	results: unknown;
	error_message: string | null;
	created_at: Date;
	updated_at: Date;
}

/** Structured form parameters stored alongside the derived Maps URL. */
interface TaskParams {
	location: string;
	keyword: string;
	radiusKm: number | null;
	category: string | null;
	groupId: string | null;
}

/** The Google Maps search URL the scraper engine will crawl for a keyword. */
function buildSearchUrl(keyword: string, location: string): string {
	return `https://www.google.com/maps/search/${encodeURIComponent(`${keyword} in ${location}`)}`;
}

/**
 * Validate a structured create body ({ location, keyword, ... }) into
 * TaskParams, or return an error string. Legacy bodies pass `url` instead
 * and skip this entirely.
 */
function parseTaskParams(body: Record<string, unknown>): TaskParams | { error: string } {
	if (typeof body.location !== 'string' || body.location.trim().length < 2) {
		return { error: 'location must be a string of at least 2 characters' };
	}
	if (typeof body.keyword !== 'string' || body.keyword.trim().length === 0) {
		return { error: 'keyword must be a non-empty string' };
	}
	let radiusKm: number | null = null;
	if (body.radiusKm !== undefined && body.radiusKm !== null) {
		const n = Number(body.radiusKm);
		if (!Number.isFinite(n) || n <= 0 || n > 500) {
			return { error: 'radiusKm must be a positive number up to 500' };
		}
		radiusKm = n;
	}
	let category: string | null = null;
	if (body.category !== undefined && body.category !== null) {
		if (typeof body.category !== 'string' || body.category.length > 100) {
			return { error: 'category must be a string of at most 100 characters' };
		}
		category = body.category;
	}
	let groupId: string | null = null;
	if (body.groupId !== undefined && body.groupId !== null) {
		if (typeof body.groupId !== 'string' || body.groupId.length === 0 || body.groupId.length > 64) {
			return { error: 'groupId must be a string of at most 64 characters' };
		}
		groupId = body.groupId;
	}
	return { location: body.location.trim(), keyword: body.keyword.trim(), radiusKm, category, groupId };
}

/**
 * Register the task management API under /v1/tasks. All queries are
 * parameterized; task reads are always scoped to the authenticated user.
 */
export function registerTaskRoutes(app: Express, store: IStoreAdapter): void {
	// Public health check. Registered before "/:id" so it isn't captured by it.
	app.get('/v1/tasks/healthcheck', (_req: Request, res: Response) => {
		res.json({ status: 'ok' });
	});

	// POST /v1/tasks/create — create a scrape task, spend a credit, enqueue it.
	// Accepts either a raw Google Maps `url` (legacy) or structured form
	// params ({ location, keyword, radiusKm?, category?, groupId? }); with
	// params, the search URL is derived server-side and the params stored for
	// rich listings.
	app.post('/v1/tasks/create', ...requireAuth(store), async (req: Request, res: Response) => {
		const userId = req.user!.id;
		const body = (req.body ?? {}) as Record<string, unknown>;

		let url: string;
		let params: TaskParams | null = null;
		if (body.url !== undefined) {
			if (typeof body.url !== 'string' || !isGoogleMapsUrl(body.url)) {
				return res.status(400).json({
					error: 'Invalid Google Maps URL',
					message: 'url must contain "google.com/maps" or "maps.app.goo.gl".',
				});
			}
			url = body.url;
		} else {
			const parsed = parseTaskParams(body);
			if ('error' in parsed) {
				return res.status(400).json({ error: parsed.error });
			}
			params = parsed;
			url = buildSearchUrl(parsed.keyword, parsed.location);
		}

		let limit: number | null = null;
		if (body.limit !== undefined && body.limit !== null) {
			const n = Number(body.limit);
			if (!Number.isInteger(n) || n < 0) {
				return res.status(400).json({ error: 'limit must be a non-negative integer' });
			}
			limit = n;
		}

		// Fast fail on the wallet balance. No deduction here — the credit is
		// charged on completion by the worker (so a failed scrape never costs the
		// user anything), and the worker's debit is the authoritative floor; this
		// is the immediate UX guard.
		if (!canAffordScrape(req)) {
			return res.status(403).json({ error: 'Insufficient credits', balance: walletBalance(req) });
		}

		try {
			const inserted = await store.query<{ id: string }>(
				'INSERT INTO scrape_tasks (user_id, url, "limit", status, params) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id',
				[userId, url, limit, 'pending', params === null ? null : JSON.stringify(params)],
			);
			const taskId = inserted[0]!.id;

			// Enqueue only after the insert has committed.
			await enqueueScrapeTask(store, taskId);

			return res.status(201).json({
				taskId,
				status: 'pending',
				params,
				remainingCredits: walletBalance(req),
			});
		} catch (err) {
			console.error('POST /v1/tasks/create failed:', err);
			return res.status(500).json({ error: 'Internal Server Error' });
		}
	});

	// POST /v1/tasks/:id/retry — re-run a failed task. The fresh task copies
	// the original's url/limit/params; the failed row is marked superseded so
	// listings show only the new attempt, never the stale failure.
	app.post('/v1/tasks/:id/retry', ...requireAuth(store), async (req: Request, res: Response) => {
		const { id } = req.params;
		if (!UUID_RE.test(id)) {
			return res.status(404).json({ error: 'Not found' });
		}
		const userId = req.user!.id;

		// Fast fail on the wallet balance, same as create (charged on completion).
		if (!canAffordScrape(req)) {
			return res.status(403).json({ error: 'Insufficient credits', balance: walletBalance(req) });
		}

		try {
			const outcome = await store.transaction(async (tx) => {
				const rows = await tx.query<Pick<TaskRow, 'id' | 'url' | 'limit' | 'status' | 'params'> & { superseded_by: string | null }>(
					'SELECT id, url, "limit", status, params, superseded_by FROM scrape_tasks WHERE id = $1 AND user_id = $2',
					[id, userId],
				);
				const task = rows[0];
				if (!task) return { kind: 'not-found' as const };
				if (task.status !== 'error' || task.superseded_by !== null) {
					return { kind: 'not-retryable' as const, status: task.status };
				}

				const inserted = await tx.query<{ id: string }>(
					'INSERT INTO scrape_tasks (user_id, url, "limit", status, params) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id',
					[userId, task.url, task.limit, 'pending', task.params === null ? null : JSON.stringify(task.params)],
				);
				const newTaskId = inserted[0]!.id;
				await tx.query(
					'UPDATE scrape_tasks SET superseded_by = $1, updated_at = now() WHERE id = $2',
					[newTaskId, task.id],
				);
				return { kind: 'ok' as const, taskId: newTaskId, params: task.params };
			});

			if (outcome.kind === 'not-found') {
				return res.status(404).json({ error: 'Not found' });
			}
			if (outcome.kind === 'not-retryable') {
				return res.status(409).json({ error: 'Only failed tasks can be retried', status: outcome.status });
			}

			// Enqueue only after the transaction has committed.
			await enqueueScrapeTask(store, outcome.taskId);

			return res.status(201).json({
				taskId: outcome.taskId,
				status: 'pending',
				params: outcome.params,
				remainingCredits: walletBalance(req),
			});
		} catch (err) {
			console.error('POST /v1/tasks/:id/retry failed:', err);
			return res.status(500).json({ error: 'Internal Server Error' });
		}
	});

	// GET /v1/tasks — list the authenticated user's tasks (summaries only).
	app.get('/v1/tasks', ...requireAuth(store), async (req: Request, res: Response) => {
		try {
			// Superseded rows are old failures replaced by a retry — hidden so a
			// retried job never lists alongside its past attempts.
			const rows = await store.query<Omit<TaskRow, 'results'>>(
				'SELECT id, url, "limit", status, params, error_message, created_at, updated_at ' +
					'FROM scrape_tasks WHERE user_id = $1 AND superseded_by IS NULL ORDER BY created_at DESC',
				[req.user!.id],
			);
			return res.json(
				rows.map((t) => ({
					id: t.id,
					url: t.url,
					limit: t.limit,
					status: t.status,
					params: t.params,
					errorMessage: t.error_message,
					createdAt: t.created_at,
					updatedAt: t.updated_at,
				})),
			);
		} catch (err) {
			console.error('GET /v1/tasks failed:', err);
			return res.status(500).json({ error: 'Internal Server Error' });
		}
	});

	// GET /v1/tasks/:id — a single task, scoped to its owner.
	app.get('/v1/tasks/:id', ...requireAuth(store), async (req: Request, res: Response) => {
		const { id } = req.params;
		if (!UUID_RE.test(id)) {
			return res.status(404).json({ error: 'Not found' });
		}

		try {
			const rows = await store.query<TaskRow>(
				'SELECT id, url, "limit", status, params, results, error_message, created_at, updated_at ' +
					'FROM scrape_tasks WHERE id = $1 AND user_id = $2',
				[id, req.user!.id],
			);
			const task = rows[0];
			if (!task) {
				return res.status(404).json({ error: 'Not found' });
			}

			return res.json({
				id: task.id,
				url: task.url,
				limit: task.limit,
				status: task.status,
				params: task.params,
				results: task.results ?? null,
				errorMessage: task.error_message,
				createdAt: task.created_at,
				updatedAt: task.updated_at,
			});
		} catch (err) {
			console.error('GET /v1/tasks/:id failed:', err);
			return res.status(500).json({ error: 'Internal Server Error' });
		}
	});

	// GET /v1/leads/:taskId — the scraped leads for a task, scoped to its owner.
	// Returns results only once the scrape is complete.
	app.get('/v1/leads/:taskId', ...requireAuth(store), async (req: Request, res: Response) => {
		const { taskId } = req.params;
		if (!UUID_RE.test(taskId)) {
			return res.status(404).json({ error: 'Not found' });
		}

		try {
			const rows = await store.query<{ status: string; results: unknown }>(
				'SELECT status, results FROM scrape_tasks WHERE id = $1 AND user_id = $2',
				[taskId, req.user!.id],
			);
			const task = rows[0];
			if (!task) {
				return res.status(404).json({ error: 'Not found' });
			}

			if (task.status === 'complete') {
				return res.json({ results: task.results ?? [] });
			}
			return res.json({ status: task.status, results: null });
		} catch (err) {
			console.error('GET /v1/leads/:taskId failed:', err);
			return res.status(500).json({ error: 'Internal Server Error' });
		}
	});
}
