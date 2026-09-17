#!/usr/bin/env node
/**
 * Move the catalog's Stripe prices to USD.
 *
 * WHY THIS EXISTS AS A SCRIPT
 *
 * A Stripe Price's currency is IMMUTABLE. There is no edit that changes cad to
 * usd — the only route is a new Price on the same Product, which means five new
 * ids that have to reach .env and Vercel without one being mistyped. Doing that
 * by hand in the dashboard is where a digit goes missing and hosted checkout
 * quietly charges the wrong thing.
 *
 * Idempotent: each price is created under a fixed idempotency key, so a second
 * run returns the SAME price rather than making a duplicate. Safe to re-run
 * after a half-finished attempt.
 *
 * Reads nothing it does not need and writes only Prices — no Product, no
 * Subscription, no Customer is touched.
 *
 *   node scripts/stripe-prices-to-usd.mjs            # dry run: shows the plan
 *   node scripts/stripe-prices-to-usd.mjs --apply    # creates the prices
 *
 * Point STRIPE_SECRET_KEY at whichever mode you mean. The script prints the mode
 * and, in live mode, requires --apply to be typed as --apply-live so a test-mode
 * habit cannot create live prices by muscle memory.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not archive the old cad prices, and it does not migrate existing
 * subscribers. An active subscription keeps billing the price it was created
 * with; repointing STRIPE_PRICE_* only affects NEW checkouts and NEW
 * subscriptions. Moving an existing subscriber is a separate, deliberate act.
 */
import Stripe from 'stripe';
import 'dotenv/config';

// Amounts come from src/billing/catalog.ts and must stay in step with it — the
// ops route's price check compares exactly these two sides.
const TARGETS = [
	{ env: 'STRIPE_PRICE_SMALL', amount: 500, interval: null },
	{ env: 'STRIPE_PRICE_MEDIUM', amount: 2000, interval: null },
	{ env: 'STRIPE_PRICE_LARGE', amount: 3800, interval: null },
	{ env: 'STRIPE_PRICE_UNLIMITED_MONTHLY', amount: 4900, interval: 'month' },
	{ env: 'STRIPE_PRICE_UNLIMITED_YEARLY', amount: 46800, interval: 'year' },
];

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
	console.error('STRIPE_SECRET_KEY is not set.');
	process.exit(1);
}
const live = key.startsWith('sk_live');
const args = process.argv.slice(2);
const apply = live ? args.includes('--apply-live') : args.includes('--apply');

const stripe = new Stripe(key, { apiVersion: '2024-11-20.acacia' });

console.log(`mode: ${live ? 'LIVE' : 'test'}${apply ? '  (APPLYING)' : '  (dry run)'}\n`);
if (live && !apply) {
	console.log('Live mode needs --apply-live, not --apply. Nothing was changed.\n');
}

const out = [];
let created = 0;

for (const t of TARGETS) {
	const oldId = process.env[t.env];
	if (!oldId) {
		console.log(`${t.env.padEnd(31)} unset — skipped`);
		continue;
	}

	let old;
	try {
		old = await stripe.prices.retrieve(oldId);
	} catch (err) {
		console.log(`${t.env.padEnd(31)} cannot read ${oldId}: ${err.message}`);
		continue;
	}

	if (old.currency === 'usd') {
		console.log(`${t.env.padEnd(31)} already usd — left alone (${oldId})`);
		out.push(`${t.env}=${oldId}`);
		continue;
	}

	// Guard against a silent repricing: the amount on the new price comes from
	// the catalog, so if the existing price disagrees the two were already out
	// of step and a blind copy would bake that in.
	if (old.unit_amount !== t.amount) {
		console.log(
			`${t.env.padEnd(31)} REFUSED: existing price is ${old.unit_amount} but the catalog says ` +
				`${t.amount}. Reconcile that first — creating a price here would hide the difference.`,
		);
		continue;
	}

	if (!apply) {
		console.log(
			`${t.env.padEnd(31)} would create ${t.amount} usd on ${old.product} (now ${old.currency})`,
		);
		continue;
	}

	const price = await stripe.prices.create(
		{
			product: old.product,
			unit_amount: t.amount,
			currency: 'usd',
			...(t.interval ? { recurring: { interval: t.interval } } : {}),
		},
		{ idempotencyKey: `leadeasygen-usd-${t.env}-${t.amount}` },
	);
	created++;
	console.log(`${t.env.padEnd(31)} ${old.currency}→usd  ${oldId}  →  ${price.id}`);
	out.push(`${t.env}=${price.id}`);
}

if (out.length > 0) {
	console.log(`\n--- set these (${live ? 'Vercel production env' : '.env'}) ---`);
	for (const line of out) console.log(line);
}

if (apply && created > 0) {
	console.log(
		'\nExisting subscriptions are NOT affected: they keep billing the price they were\n' +
			'created with. Only new checkouts and new subscriptions use the ids above.\n' +
			'Confirm with the ops route afterwards — `prices.ok` should be true.',
	);
}
