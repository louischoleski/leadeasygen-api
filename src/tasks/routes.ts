import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { IStoreAdapter } from '@fonderie/store/types';
import type { IFonderieContext } from '@fonderie/core';
import { getSubscription, getWalletStatus, requireWalletBalance } from '@fonderie/billing';
import { adapt } from '@fonderie/adapter-express';

import { requireAuth } from '../auth/requireAuth.js';
import { effectivePlanName, resolveActiveJobsLimit } from '../billing/catalog.js';
import { enqueueScrapeTask } from '../queue/scrapeQueue.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The scrape affordability gate is billing's own requireWalletBalance middleware
// (adapted onto Express), applied to the create/retry routes below: it reads the
// wallet on the request ctx, and returns 402 INSUFFICIENT_CREDITS when the
// balance can't cover the plan's `scrape:task` rate (Unlimited plans have no
// rate, so it no-ops). The worker's debit remains the authoritative floor.
const requireScrapeCredit = adapt(requireWalletBalance('scrape:task'));

/** The caller's current wallet balance as a number, or null on Unlimited/none. */
function walletBalance(req: Request): number | null {
	const ctx = (req as Request & { _fonderie?: IFonderieContext })._fonderie;
	const wallet = ctx ? getWalletStatus(ctx) : null;
	return wallet ? Number(wallet.balance) : null;
}

/**
 * Serialize a user's concurrent task creates for the duration of the
 * transaction. Both guards below (dedup, active-job limit) read counts/rows
 * that another in-flight create may not have committed yet — under READ
 * COMMITTED neither would see the other's uncommitted row, so two simultaneous
 * submits could both slip past. Taking a per-user advisory lock first forces
 * them to run one at a time. Transaction-scoped: releases on commit/rollback
 * with nothing to clean up. Call once, before the guards.
 */
async function lockUser(tx: Pick<IStoreAdapter, 'query'>, userId: string): Promise<void> {
	await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId]);
}

/**
 * Plan-policy gate on concurrently active tasks, run inside the same
 * transaction as the insert it guards. The app's form mirrors this check, but
 * the server is the enforcement — a direct API caller must not be able to
 * stuff the queue past the plan's activeJobs limit.
 *
 * Assumes the caller already holds the per-user lock (see lockUser) so the
 * count is stable against a concurrent create.
 *
 * Returns true when the caller is at their limit (caller responds 409).
 */
async function atActiveJobLimit(
	tx: Pick<IStoreAdapter, 'query'>,
	userId: string,
	limit: number | null,
): Promise<boolean> {
	if (limit === null) return false;
	const counted = await tx.query<{ n: number }>(
		"SELECT count(*)::int AS n FROM scrape_tasks WHERE user_id = $1 AND status IN ('pending', 'scraping')",
		[userId],
	);
	return counted[0]!.n >= limit;
}

/**
 * Normalize a free-text field so trivially-different spellings of the same
 * search collapse to one key ("Austin, TX" == "  austin,  tx ").
 */
function normalizeText(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Time-independent signature of what a structured scrape actually searches for
 * — keyword + location + radius. Same search, same user → same key, whenever it
 * ran. The "recent" part is a rolling window applied at query time (see
 * DEDUP_WINDOW), deliberately NOT baked in here: a calendar bucket would
 * misalign with per-user credit cycles that don't start on the 1st, and freshness
 * is what we're really guarding. Radius is included as the caller proposed,
 * though only keyword+location currently drive the Maps URL.
 */
function computeSearchKey(params: TaskParams): string {
	const signature = JSON.stringify([
		normalizeText(params.keyword),
		normalizeText(params.location),
		params.radiusKm ?? null,
	]);
	return createHash('sha256').update(signature).digest('hex');
}

// Rolling duplicate window: an identical search counts as a duplicate only if
// one ran within this span. The single knob for day/week/month — tune here.
const DEDUP_WINDOW = '30 days';

/** The 409 body for a creation attempt past the plan's activeJobs limit. */
function activeJobLimitBody(limit: number) {
	// Envelope shape (reason/explanation/details) so @fonderie/client's
	// FonderieApiError carries a distinct code the app can tell apart from other
	// 409s (e.g. RECENT_DUPLICATE) and show a limit-specific message.
	return {
		reason: 'ACTIVE_JOB_LIMIT',
		explanation: `Your plan allows ${limit} active job${limit === 1 ? '' : 's'}. Wait for it to finish or upgrade.`,
		details: { limit },
	};
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
	app.post('/v1/tasks/create', ...requireAuth(store), requireScrapeCredit, async (req: Request, res: Response) => {
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

		// force:true is the caller's explicit "yes, run this same search again"
		// after being warned it's a duplicate — it bypasses the dedup check below.
		const force = body.force === true;
		// Only structured jobs get a dedup key; legacy url-only jobs are never deduped.
		const dedupKey = params === null ? null : computeSearchKey(params);

		// Affordability was gated by requireScrapeCredit (402) before this handler.
		// No deduction here — the credit is charged on completion by the worker
		// (a failed scrape never costs the user), and that debit is the
		// authoritative floor.
		try {
			const activeLimit = resolveActiveJobsLimit(effectivePlanName(await getSubscription('user', userId, store)));
			const outcome = await store.transaction(async (tx) => {
				await lockUser(tx, userId);
				// Duplicate check first: it's the more actionable signal (points the
				// caller at the job they already have), and for a free user at their
				// one-active-job limit the duplicate IS that active job.
				if (dedupKey !== null && !force) {
					const dup = await tx.query<{ id: string; status: string }>(
						`SELECT id, status FROM scrape_tasks
						   WHERE user_id = $1 AND dedup_key = $2 AND superseded_by IS NULL
						     AND status <> 'error'
						     AND created_at > now() - $3::interval
						     -- A finished run that found nothing shouldn't block a retry — only
						     -- in-progress runs and completed runs that actually returned leads
						     -- count as a duplicate worth warning about.
						     AND (status <> 'complete'
						          OR jsonb_array_length(CASE WHEN jsonb_typeof(results) = 'array' THEN results ELSE '[]'::jsonb END) > 0)
						   ORDER BY created_at DESC LIMIT 1`,
						[userId, dedupKey, DEDUP_WINDOW],
					);
					if (dup[0]) {
						return { kind: 'duplicate' as const, existingTaskId: dup[0].id, existingStatus: dup[0].status };
					}
				}
				if (await atActiveJobLimit(tx, userId, activeLimit)) {
					return { kind: 'at-limit' as const };
				}
				const inserted = await tx.query<{ id: string }>(
					'INSERT INTO scrape_tasks (user_id, url, "limit", status, params, dedup_key) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id',
					[userId, url, limit, 'pending', params === null ? null : JSON.stringify(params), dedupKey],
				);
				return { kind: 'ok' as const, taskId: inserted[0]!.id };
			});
			if (outcome.kind === 'duplicate') {
				// Envelope shape (reason/explanation/details) so @fonderie/client's
				// FonderieApiError carries the existing task id to the app.
				return res.status(409).json({
					reason: 'RECENT_DUPLICATE',
					explanation: 'You already ran this search recently. Open the existing job, or run it again anyway.',
					details: { existingTaskId: outcome.existingTaskId, status: outcome.existingStatus },
				});
			}
			if (outcome.kind === 'at-limit') {
				return res.status(409).json(activeJobLimitBody(activeLimit!));
			}

			// Enqueue only after the insert has committed.
			await enqueueScrapeTask(store, outcome.taskId);

			return res.status(201).json({
				taskId: outcome.taskId,
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
	app.post('/v1/tasks/:id/retry', ...requireAuth(store), requireScrapeCredit, async (req: Request, res: Response) => {
		const { id } = req.params;
		if (!UUID_RE.test(id)) {
			return res.status(404).json({ error: 'Not found' });
		}
		const userId = req.user!.id;

		// Affordability gated by requireScrapeCredit (402) before this handler;
		// charged on completion by the worker, same as create. The retried row
		// is a fresh active task, so it counts against activeJobs like a create
		// (the failed original is 'error' — never in the active count).
		try {
			const activeLimit = resolveActiveJobsLimit(effectivePlanName(await getSubscription('user', userId, store)));
			const outcome = await store.transaction(async (tx) => {
				await lockUser(tx, userId);
				const rows = await tx.query<Pick<TaskRow, 'id' | 'url' | 'limit' | 'status' | 'params'> & { superseded_by: string | null }>(
					'SELECT id, url, "limit", status, params, superseded_by FROM scrape_tasks WHERE id = $1 AND user_id = $2',
					[id, userId],
				);
				const task = rows[0];
				if (!task) return { kind: 'not-found' as const };
				if (task.status !== 'error' || task.superseded_by !== null) {
					return { kind: 'not-retryable' as const, status: task.status };
				}
				if (await atActiveJobLimit(tx, userId, activeLimit)) {
					return { kind: 'at-limit' as const };
				}

				// A retry is an explicit re-run, so it isn't dedup-checked; the fresh row
				// still gets a search key so a later duplicate submit within the window
				// finds it.
				const retryDedupKey = task.params ? computeSearchKey(task.params) : null;
				const inserted = await tx.query<{ id: string }>(
					'INSERT INTO scrape_tasks (user_id, url, "limit", status, params, dedup_key) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id',
					[userId, task.url, task.limit, 'pending', task.params === null ? null : JSON.stringify(task.params), retryDedupKey],
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
			if (outcome.kind === 'at-limit') {
				return res.status(409).json(activeJobLimitBody(activeLimit!));
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
