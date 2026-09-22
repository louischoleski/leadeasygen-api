import { EventsModule, PGTransport } from '@fonderie/events';
import { CourierModule } from '@fonderie/courier';
import { MESSAGE_KEYS as AUTH_MESSAGE_KEYS, DEFAULT_TEMPLATES as AUTH_DEFAULT_TEMPLATES } from '@fonderie/auth';
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
			// The product name in the email shell. Recipients signed up for
			// LeadEasyGen and have never heard of Fonderie, so a shell headed
			// "Fonderie" reads as a different company at best — and as phishing at
			// worst, which is the wrong signal on a receipt. Unset would fall back
			// to Fonderie, which is exactly what this exists to prevent.
			brandName: 'LeadEasyGen',
			channels: {
				// DERIVED from each package's own key list, never hand-written. A
				// hand-written map silently drops anything added upstream: courier
				// logs 'no channels configured' and returns, so the notice is
				// published, never delivered, never retried — and nobody reads that
				// log line. Every auth notice added today was already missing this
				// way (oauth-linked, oauth-unlinked, oauth-registration), including
				// the password-revoked security notice.
				//
				// phoneOtp is the one exclusion: it is SMS-only and this app sends no
				// SMS, so routing it to email would put a one-time code in the wrong
				// channel. Mapped to an EMPTY list rather than omitted, which is how
				// courier's boot guard tells a deliberate opt-out from drift — an
				// absent key is reported, an empty one is understood.
				...Object.fromEntries(
					Object.values(AUTH_MESSAGE_KEYS)
						.filter((key) => key !== AUTH_MESSAGE_KEYS.phoneOtp)
						.map((key) => [key, [...emailOnly]]),
				),
				[AUTH_MESSAGE_KEYS.phoneOtp]: [],
				// Billing money-flow notices (subscription + wallet). Bodies come from
				// billing's DEFAULT_TEMPLATES rendered in the DB-seeded layout.
				...Object.fromEntries(
					Object.values(BILLING_MESSAGE_KEYS).map((key) => [key, [...emailOnly]]),
				),
			},
			email: {
				provider: 'smtp',
				from: process.env.SMTP_FROM ?? process.env.SMTP_USER!,
				// Where replies go, because the From address cannot receive them.
				//
				// Mail is sent from email.leadeasygen.com — a dedicated sending
				// subdomain, so its reputation is isolated from the apex that serves
				// the site and forwards the inbox. A sending subdomain has no MX, so
				// a reply to the From address bounces.
				//
				// People do reply to transactional mail: a question about a receipt,
				// a "this wasn't me" about a password reset. A bounced reply is worse
				// than no reply — the sender believes they reached us and never tries
				// another way. Point them at the apex address, which Namecheap
				// forwarding actually delivers.
				...(process.env.SMTP_REPLY_TO ? { replyTo: process.env.SMTP_REPLY_TO } : {}),
				// What DNS cannot tell the doctor's sender check: a DKIM selector is
				// not discoverable, and SPF checks the ENVELOPE domain, not the From.
				// Previously passed by hand at the cron route; now the brick's own
				// courier.sender-dns check reads them from here.
				senderDns: {
					...(process.env.SMTP_DKIM_SELECTORS
						? { dkimSelectors: process.env.SMTP_DKIM_SELECTORS.split(',').map((x) => x.trim()).filter(Boolean) }
						: {}),
					...(process.env.SMTP_RETURN_PATH_DOMAIN ? { returnPathDomain: process.env.SMTP_RETURN_PATH_DOMAIN } : {}),
				},
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
			// DB-seeded templates win; anything without a DB seed falls back to the
			// package's shipped default.
			//
			// BOTH packages' defaults are passed, not just billing's. Beyond the
			// fallback, this is what courier's boot guard compares the channel map
			// against — so shipping auth's defaults is what makes a missing auth
			// route visible at boot rather than at the first user who triggers it.
			templates: { source: 'db', defaults: [AUTH_DEFAULT_TEMPLATES, BILLING_DEFAULT_TEMPLATES] },
		},
		store,
		bus,
	);
}
