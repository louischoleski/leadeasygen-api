import type { Express, Request, Response } from 'express';
import type { IStoreAdapter } from '@fonderie/store/types';

import { requireAuth } from '../auth/requireAuth.js';
import { enqueueScrapeTask } from '../queue/scrapeQueue.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Google Maps URL is one pointing at maps or the app short-link host. */
function isGoogleMapsUrl(url: string): boolean {
	return url.includes('google.com/maps') || url.includes('maps.app.goo.gl');
}

interface TaskRow {
	id: string;
	url: string;
	limit: number | null;
	status: string;
	results: unknown;
	error_message: string | null;
	created_at: Date;
	updated_at: Date;
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
	app.post('/v1/tasks/create', ...requireAuth(store), async (req: Request, res: Response) => {
		const userId = req.user!.id;
		const body = (req.body ?? {}) as { url?: unknown; limit?: unknown };

		if (typeof body.url !== 'string' || !isGoogleMapsUrl(body.url)) {
			return res.status(400).json({
				error: 'Invalid Google Maps URL',
				message: 'url must contain "google.com/maps" or "maps.app.goo.gl".',
			});
		}
		const url = body.url;

		let limit: number | null = null;
		if (body.limit !== undefined && body.limit !== null) {
			const n = Number(body.limit);
			if (!Number.isInteger(n) || n < 0) {
				return res.status(400).json({ error: 'limit must be a non-negative integer' });
			}
			limit = n;
		}

		// Fast fail using the credits attached to req.user by requireAuth.
		if ((req.user!.credits ?? 0) < 1) {
			return res.status(403).json({ error: 'Insufficient credits', balance: req.user!.credits });
		}

		try {
			// Authoritative balance check (from the ledger) + task insert, in one
			// transaction. No deduction here — the credit is charged on completion
			// by the worker, so a failed scrape never costs the user anything.
			const outcome = await store.transaction(async (tx) => {
				const rows = await tx.query<{ balance: number }>(
					'SELECT COALESCE(SUM(amount), 0)::int AS balance FROM credit_transactions WHERE user_id = $1',
					[userId],
				);
				const balance = rows[0]?.balance ?? 0;
				if (balance < 1) {
					return { ok: false as const, balance };
				}

				const inserted = await tx.query<{ id: string }>(
					'INSERT INTO scrape_tasks (user_id, url, "limit", status) VALUES ($1, $2, $3, $4) RETURNING id',
					[userId, url, limit, 'pending'],
				);

				// Balance is unchanged at creation (charged on completion).
				return { ok: true as const, taskId: inserted[0]!.id, remainingCredits: balance };
			});

			if (!outcome.ok) {
				return res.status(403).json({ error: 'Insufficient credits', balance: outcome.balance });
			}

			// Enqueue only after the transaction has committed.
			await enqueueScrapeTask(store, outcome.taskId);

			return res.status(201).json({
				taskId: outcome.taskId,
				status: 'pending',
				remainingCredits: outcome.remainingCredits,
			});
		} catch (err) {
			console.error('POST /v1/tasks/create failed:', err);
			return res.status(500).json({ error: 'Internal Server Error' });
		}
	});

	// GET /v1/tasks — list the authenticated user's tasks (summaries only).
	app.get('/v1/tasks', ...requireAuth(store), async (req: Request, res: Response) => {
		try {
			const rows = await store.query<Omit<TaskRow, 'results'>>(
				'SELECT id, url, "limit", status, error_message, created_at, updated_at ' +
					'FROM scrape_tasks WHERE user_id = $1 ORDER BY created_at DESC',
				[req.user!.id],
			);
			return res.json(
				rows.map((t) => ({
					id: t.id,
					url: t.url,
					limit: t.limit,
					status: t.status,
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
				'SELECT id, url, "limit", status, results, error_message, created_at, updated_at ' +
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
