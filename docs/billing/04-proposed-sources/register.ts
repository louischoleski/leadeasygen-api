// src/index.ts  (proposed — phase 1 + phase 3 additions, shown as blocks)

// ── Phase 1: serve the catalog (replaces the app-side mock) ──────────────
import { registerCatalogRoutes } from './billing/routes.js';
// after the existing registerTaskRoutes(app, store) / registerCreditRoutes(...):
registerCatalogRoutes(app);

// packs.ts also collapses into the catalog in phase 1 — loadPacks() becomes:
//
//   import { catalog } from '../billing/catalog.js';
//   export function loadPacks(): Record<Pack, PackDef> {
//     return Object.fromEntries(
//       catalog.creditPacks.map((p) => [p.id, { credits: p.credits, amountCents: p.amountCents, priceId: p.priceId }]),
//     ) as Record<Pack, PackDef>;
//   }
//
// so the checkout route and the Stripe webhook keep their exact behavior
// while reading the one catalog.

// ── Phase 3: register the subscriptions engine ───────────────────────────
import { BillingModule, StripeProvider } from '@fonderie/billing';
import { toBillingPlans } from './billing/toBillingPlans.js';

fonderieApp = fonderieApp.register(
	new BillingModule(store, {
		provider: new StripeProvider(
			process.env.STRIPE_SECRET_KEY!,
			process.env.STRIPE_WEBHOOK_SECRET_BILLING,
		),
		plans: toBillingPlans(), // maps CatalogPlan → IBillingPlan; only plans with a Stripe price
		successUrl: `${process.env.FRONTEND_URL}/billing?subscribed=1`,
		cancelUrl: `${process.env.FRONTEND_URL}/billing`,
	}),
);

// toBillingPlans() lives in src/billing/toBillingPlans.ts:
//
//   import { catalog } from './catalog.js';
//   export function toBillingPlans() {
//     return catalog.plans
//       .filter((p) => p.monthly || p.yearly)
//       .map((p) => ({
//         name: p.name,
//         description: p.description,
//         tier: p.tier,
//         // exact price-field names come from @fonderie/billing/types
//         // (IBillingPlanPrice) at implementation time
//         monthly: p.monthly && { amount: p.monthly.amountCents, priceId: p.monthly.priceId! },
//         yearly: p.yearly && { amount: p.yearly.amountCents, priceId: p.yearly.priceId! },
//         policy: { activeJobs: { limit: p.policy.activeJobs.limit } },
//       }));
//   }
//
// New env vars phase 3 introduces (see the design doc's Stripe table):
//   STRIPE_PRICE_UNLIMITED_MONTHLY, STRIPE_PRICE_UNLIMITED_YEARLY,
//   STRIPE_WEBHOOK_SECRET_BILLING
