// src/billing/planFor.ts  (proposed — phase 2)

import type { IStoreAdapter } from '@fonderie/store/types';

import { FREE_PLAN, getPlan, type CatalogPlan } from './catalog.js';

/**
 * Resolve a user's plan from fonderie_subscriptions (owned by
 * @fonderie/billing). Absence of a subscription row IS the free plan —
 * no row is ever written for free users. Until BillingModule is
 * registered (phase 3) the table does not even exist; that case is
 * treated as free too, which is what lets phases 1–2 ship without the
 * module.
 */
export async function planForUser(store: IStoreAdapter, userId: string): Promise<CatalogPlan> {
	try {
		const rows = await store.query<{ plan: string; status: string }>(
			"SELECT plan, status FROM fonderie_subscriptions WHERE subscriber_type = 'user' AND subscriber_id = $1",
			[userId],
		);
		const sub = rows[0];
		if (sub && (sub.status === 'active' || sub.status === 'trialing')) {
			return getPlan(sub.plan);
		}
	} catch {
		// Table absent (BillingModule not registered yet) — everyone is free.
	}
	return FREE_PLAN;
}
