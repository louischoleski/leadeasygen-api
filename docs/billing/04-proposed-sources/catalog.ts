// src/billing/catalog.ts  (proposed — phase 1)

/**
 * The product catalog — the single definition of plans, credit packs, and
 * their Stripe references. Trusted amounts and credit counts live here in
 * code (never read back from Stripe metadata — same rule the pack webhook
 * already enforces); price IDs come from env so test/live mode swaps
 * without a deploy.
 *
 * Consumers:
 *   GET /v1/catalog          → the app renders pricing from this
 *   src/credits/*            → monthlyGrant / taskCost economics per plan
 *   BillingModule (phase 3)  → subscription plans, via toBillingPlans()
 */

export interface PlanCredits {
	/** Credits granted on the first authenticated request of each month. */
	monthlyGrant: number;
	/** Credits charged when a scrape task completes. 0 = scraping is free. */
	taskCost: number;
}

export interface CatalogPlan {
	name: string;
	tier: number;
	description: string;
	/** Absent on the free plan — no Stripe price, no checkout. */
	monthly?: { amountCents: number; priceId?: string };
	yearly?: { amountCents: number; priceId?: string };
	policy: { activeJobs: { limit: number | null } };
	credits: PlanCredits;
}

export interface CatalogPack {
	id: 'small' | 'medium' | 'large';
	credits: number;
	amountCents: number;
	priceId?: string;
}

export const catalog = {
	plans: [
		{
			name: 'free',
			tier: 0,
			description: 'Get started with limited scraping',
			policy: { activeJobs: { limit: 1 } },
			credits: { monthlyGrant: 50, taskCost: 1 },
		},
		{
			name: 'unlimited',
			tier: 1,
			description: 'Unlimited leads, no credit limits',
			monthly: { amountCents: 4900, priceId: process.env.STRIPE_PRICE_UNLIMITED_MONTHLY },
			yearly: { amountCents: 46800, priceId: process.env.STRIPE_PRICE_UNLIMITED_YEARLY },
			policy: { activeJobs: { limit: null } },
			credits: { monthlyGrant: 0, taskCost: 0 },
		},
	] satisfies CatalogPlan[],

	creditPacks: [
		{ id: 'small', credits: 10, amountCents: 500, priceId: process.env.STRIPE_PRICE_SMALL },
		{ id: 'medium', credits: 50, amountCents: 2000, priceId: process.env.STRIPE_PRICE_MEDIUM },
		{ id: 'large', credits: 100, amountCents: 3500, priceId: process.env.STRIPE_PRICE_LARGE },
	] satisfies CatalogPack[],
};

export const FREE_PLAN: CatalogPlan = catalog.plans[0];

/** Look a plan up by name; unknown/absent names resolve to the free plan. */
export function getPlan(name: string | null | undefined): CatalogPlan {
	return catalog.plans.find((p) => p.name === name) ?? FREE_PLAN;
}
