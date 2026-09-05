// src/billing/routes.ts  (proposed — phase 1)

import type { Express, Request, Response } from 'express';

import { catalog } from './catalog.js';

/**
 * Public pricing catalog for the app's billing page. Replaces the app's
 * hardcoded mock (src/data/billing.ts packs/tiers) so the catalog exists
 * in exactly one place. Stripe price IDs deliberately stay server-side:
 * the app checks out by pack/plan *name* and the server maps names to
 * prices — the same trusted-catalog rule the webhook already follows.
 */
export function registerCatalogRoutes(app: Express): void {
	app.get('/v1/catalog', (_req: Request, res: Response) => {
		res.json({
			plans: catalog.plans.map(({ name, tier, description, monthly, yearly, policy, credits }) => ({
				name,
				tier,
				description,
				monthly: monthly ? { amountCents: monthly.amountCents } : null,
				yearly: yearly ? { amountCents: yearly.amountCents } : null,
				policy,
				credits,
			})),
			creditPacks: catalog.creditPacks.map(({ id, credits, amountCents }) => ({
				id,
				credits,
				amountCents,
			})),
		});
	});
}
