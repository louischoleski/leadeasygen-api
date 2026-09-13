import { EventsModule, PGTransport } from '@fonderie/events';
import { CourierModule } from '@fonderie/courier';
import {
	MESSAGE_KEYS as BILLING_MESSAGE_KEYS,
	DEFAULT_TEMPLATES as BILLING_DEFAULT_TEMPLATES,
} from '@fonderie/billing';
import type { EventBus } from '@fonderie/events';
import type { IStoreAdapter } from '@fonderie/store/types';

/**
 * Notification plumbing, shared by BOTH processes so they cannot drift apart —
 * a channel list that differs between publisher and consumer means a message
 * type is accepted and then silently never delivered.
 *
 * The split:
 *   • the API PUBLISHES — durable rows, no consumer (see createNotifyBus)
 *   • the worker CONSUMES — LISTENs and sends
 *
 * Both point at the same `fonderie_events` outbox, so a send survives the API
 * instance being frozen or killed the moment it returns its response.
 */

/**
 * The bus the app publishes onto, and the worker consumes from.
 *
 * `consume` is the whole point: a serverless API must write durable rows but
 * cannot host a consumer — a poll loop never returns, and LISTEN is rejected
 * by a transaction-mode pooler (Supabase's 6543, which is what DATABASE_URL
 * points at in production). The worker connects directly and does consume.
 */
export function createNotifyBus(
	connectionUrl: string,
	options: { consume: boolean },
): { module: EventsModule; transport: PGTransport } {
	// The transport comes back too: deadLetters()/pendingCount() live on it, and
	// a queue nobody inspects is one that can stop delivering unnoticed.
	const transport = new PGTransport({ connectionUrl, consume: options.consume });
	return { module: new EventsModule({ transport }), transport };
}

/** Whether transactional email is configured at all. */
export function emailConfigured(): boolean {
	return !!process.env.SMTP_HOST;
}

/**
 * Courier wired to the email channel — registered in BOTH processes, and the
 * API's registration is not optional politeness.
 *
 * `publish()` writes one durable event row plus one row per consumer that the
 * PUBLISHING process has subscribed. A publisher with no courier registered
 * therefore writes an event nobody is owed: the worker polls for consumer rows
 * and finds none, so the message is undeliverable forever — not queued, not
 * retried, not dead-lettered, just absent. That is why both processes build
 * their channel list from this one function, and why the API registers courier
 * even though nothing there ever sends.
 *
 * The API's copy also lets an on-demand `bus.drain()` deliver if the worker is
 * ever down.
 */
export function buildCourierModule(store: IStoreAdapter, bus: EventBus): CourierModule {
	// Courier skips any recipient with no address for the channel (e.g. phone-only OTP).
	const emailOnly = ['email'] as const;
	return new CourierModule(
		{
			channels: {
				'email-verification': [...emailOnly],
				'email-registration': [...emailOnly],
				'password-reset': [...emailOnly],
				'email-changed': [...emailOnly],
				'phone-changed': [...emailOnly],
				'mfa-enabled': [...emailOnly],
				'mfa-disabled': [...emailOnly],
				'mfa-backup-codes-regenerated': [...emailOnly],
				// Billing money-flow notices (subscription + wallet). Bodies come from
				// billing's DEFAULT_TEMPLATES rendered in the DB-seeded layout.
				[BILLING_MESSAGE_KEYS.subscriptionCanceled]: [...emailOnly],
				[BILLING_MESSAGE_KEYS.paymentFailed]: [...emailOnly],
				[BILLING_MESSAGE_KEYS.trialEnding]: [...emailOnly],
				[BILLING_MESSAGE_KEYS.renewalReceipt]: [...emailOnly],
				[BILLING_MESSAGE_KEYS.creditsLow]: [...emailOnly],
				[BILLING_MESSAGE_KEYS.paymentReceipt]: [...emailOnly],
				[BILLING_MESSAGE_KEYS.refundProcessed]: [...emailOnly],
				[BILLING_MESSAGE_KEYS.autoRechargeFailed]: [...emailOnly],
			},
			email: {
				provider: 'smtp',
				from: process.env.SMTP_FROM ?? process.env.SMTP_USER!,
				smtp: {
					host: process.env.SMTP_HOST!,
					port: Number(process.env.SMTP_PORT ?? 587),
					// 465 is implicit TLS, 587 is STARTTLS — mismatching these hangs
					// the connection until it times out.
					secure: process.env.SMTP_SECURE === 'true',
					user: process.env.SMTP_USER!,
					pass: process.env.SMTP_PASS!,
				},
			},
			// DB-seeded auth templates win; billing's notices have no DB seed and
			// fall back to billing's shipped defaults.
			templates: { source: 'db', defaults: [BILLING_DEFAULT_TEMPLATES] },
		},
		store,
		bus,
	);
}
