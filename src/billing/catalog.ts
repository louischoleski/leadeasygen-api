// LeadEasyGen's product catalog, in @fonderie/billing's shape. One source of
// truth for plans + credit packs + wallet economics, feeding a single engine:
// billing runs both the subscription (Unlimited) AND the credit wallet.
//
// The wallet is CREDIT-denominated: balances are whole credit counts, so the
// currency is a non-ISO code ('CRD') at precision 0 — formatWalletAmount then
// renders a bare count ("50"), not "$50.00". Credit PACKS are still charged in
// real money (USD); billing credits the buyer's wallet in wallet units
// regardless of the charge currency.
import type { IBillingPlan, IBillingCreditPack } from '@fonderie/billing';

// The credit wallet's unit. Non-ISO on purpose → rendered as a plain count.
export const WALLET_CURRENCY = 'CRD';
export const WALLET_PRECISION = 0;

export const PLANS: IBillingPlan[] = [
	{
		name: 'free',
		tier: 0,
		description: 'Get started with limited scraping',
		// One concurrent scrape job on free.
		policy: { activeJobs: { limit: 1 } },
		wallet: {
			// 50 free credits a month, use-it-or-lose-it (allowance resets).
			grantAmount: 50n,
			grantPeriod: 'month',
			grantRollover: 'none',
			// One completed scrape task costs one credit.
			rates: { 'scrape:task': { cost: 1n } },
			// Block at zero — no negative balances.
			overdraftLimit: 0n,
			// Nudge (billing.credits-low) when the balance hits 10.
			lowBalanceAt: 10n,
		},
	},
	{
		name: 'unlimited',
		tier: 1,
		description: 'Unlimited leads, no credit limits',
		monthly: { amount: 4900n, priceId: process.env.STRIPE_PRICE_UNLIMITED_MONTHLY ?? '' },
		yearly: { amount: 46800n, priceId: process.env.STRIPE_PRICE_UNLIMITED_YEARLY ?? '' },
		policy: { activeJobs: { limit: null } },
		// No 'scrape:task' rate → debitWalletForMetric returns null → scraping is
		// free on Unlimited (credits become irrelevant).
		wallet: { rates: {} },
	},
];

export const CREDIT_PACKS: IBillingCreditPack[] = [
	{ id: 'small', name: '10 credits', credits: 10n, priceAmount: 500n, currency: 'usd', ...priceId('STRIPE_PRICE_SMALL') },
	{ id: 'medium', name: '50 credits', credits: 50n, priceAmount: 2000n, currency: 'usd', ...priceId('STRIPE_PRICE_MEDIUM') },
	{ id: 'large', name: '100 credits', credits: 100n, priceAmount: 3500n, currency: 'usd', ...priceId('STRIPE_PRICE_LARGE') },
];

// Use a configured Stripe Price id when present; otherwise billing charges the
// ad-hoc priceAmount above (fine for local/test without pre-created prices).
function priceId(envKey: string): { priceId?: string } {
	const id = process.env[envKey];
	return id ? { priceId: id } : {};
}

// Everything the worker needs to charge one completed scrape through the wallet.
// `allowance` mirrors what withBilling carries on the request ctx, so a debit
// crossing a grant-period boundary settles the stale allowance in the same
// transaction as the spend (see debitWallet's `allowance` option).
export interface ScrapeCharge {
	cost: bigint;
	currency: string;
	overdraftLimit: bigint;
	grantPeriod: 'month' | 'week' | 'day';
	grantRollover: 'none' | 'full' | { cap: bigint };
}

/**
 * The wallet charge for one completed scrape on a given plan, resolved from
 * this same catalog — the single config source the BillingModule also reads.
 * Returns null when the plan has no `scrape:task` rate (Unlimited → scraping is
 * free), so the caller skips the debit entirely.
 *
 * The worker (worker.ts) runs outside the request context and so cannot read
 * the wallet off withBilling's ctx; this mirrors the fields resolvePlanWallet
 * would supply, for exactly this one metered debit. Defaulting matches
 * resolvePlanWallet (plan → global → hardcoded).
 */
export function resolveScrapeCharge(planName: string | null | undefined): ScrapeCharge | null {
	const plan =
		PLANS.find((p) => p.name.toLowerCase() === (planName ?? 'free').toLowerCase()) ?? PLANS[0];
	const cost = plan.wallet?.rates?.['scrape:task']?.cost;
	if (cost === undefined || cost === 0n) return null;
	return {
		cost,
		currency: plan.wallet?.currency ?? WALLET_CURRENCY,
		overdraftLimit: plan.wallet?.overdraftLimit ?? 0n,
		grantPeriod: plan.wallet?.grantPeriod ?? 'month',
		grantRollover: plan.wallet?.grantRollover ?? 'none',
	};
}
