import { randomUUID } from 'node:crypto';
import { EventBus, PGTransport } from '@fonderie/events';
import type { IStoreAdapter } from '@fonderie/store/types';

/**
 * Scrape job queue, built on Fonderie's durable Postgres-backed event bus
 * (@fonderie/events PGTransport). Jobs survive restarts and are delivered
 * across processes — the API publishes, the worker (a separate process)
 * consumes — using the same database, with no extra infrastructure.
 */

/** Event type used as the scrape job "topic". */
export const SCRAPE_TASK_EVENT = 'scrape-task';

/** Consumer name for the scrape worker (its offset in the outbox). */
export const SCRAPE_CONSUMER = 'scrape-worker';

/** Payload carried by a scrape-task job. */
export interface ScrapeTaskJob {
	taskId: string;
}

/**
 * Create an EventBus bound to Postgres. Both the API and the worker call this
 * (each in its own process) against the same DATABASE_URL.
 */
export function createScrapeBus(connectionUrl: string): EventBus {
	return new EventBus(new PGTransport({ connectionUrl }));
}

/**
 * Enqueue a scrape job for the given task id.
 *
 * We deliberately do NOT use EventBus.emit() here. PGTransport.publish() only
 * creates fonderie_event_consumers rows for consumers subscribed on the
 * *publishing* bus (matchingConsumers), and the API process never subscribes
 * 'scrape-worker' — that runs in the separate worker process. So an emit() from
 * the API would insert the event with zero consumers and the worker would never
 * see it. Instead we write the outbox rows directly, mirroring publish() but
 * with an explicit 'scrape-worker' consumer row, then NOTIFY so a listening
 * worker wakes immediately. Same three statements publish() runs — no polling
 * bus needed on the publisher side.
 */
export async function enqueueScrapeTask(store: IStoreAdapter, taskId: string): Promise<void> {
	const eventId = randomUUID();
	const payload: ScrapeTaskJob = { taskId };
	// Matches the IEventMeta shape EventBus.emit() writes, so the worker's poll
	// loop reads it back identically.
	const meta = {
		id: eventId,
		type: SCRAPE_TASK_EVENT,
		emittedAt: new Date().toISOString(),
		attempts: 0,
	};

	await store.query(
		'INSERT INTO fonderie_events (id, type, payload, meta) VALUES ($1, $2, $3, $4)',
		[eventId, SCRAPE_TASK_EVENT, JSON.stringify(payload), JSON.stringify(meta)],
	);
	await store.query(
		`INSERT INTO fonderie_event_consumers (event_id, consumer, status, attempts)
		 VALUES ($1, $2, 'pending', 0)
		 ON CONFLICT (event_id, consumer) DO NOTHING`,
		[eventId, SCRAPE_CONSUMER],
	);
	await store.query("SELECT pg_notify('fonderie_events', '')");
}
