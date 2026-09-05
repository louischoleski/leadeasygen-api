// src/credits/monthlyGrant.ts  (proposed — phase 2 replacement)
// Diff vs today: the granted amount comes from the viewer's plan in the
// catalog instead of a hardcoded FREE_MONTHLY_CREDITS = 50. Mechanics
// (lazy application in requireAuth, credit_grants idempotency) unchanged.

import type { IStoreAdapter } from '@fonderie/store/types';

import { planForUser } from '../billing/planFor.js';

/**
 * The free ($0/month) plan every account starts on grants credits per
 * calendar month per the catalog (plan.credits.monthlyGrant). There is no
 * signup hook — the grant is applied lazily, exactly once per month, by
 * the requireAuth middleware on any authenticated request. A brand-new
 * account therefore receives its first grant the moment the dashboard
 * loads, and no route has to remember to grant.
 */
export async function ensureMonthlyGrant(store: IStoreAdapter, userId: string): Promise<void> {
	const plan = await planForUser(store, userId);
	const amount = plan.credits.monthlyGrant;
	if (amount <= 0) return; // plans like 'unlimited' grant nothing — tasks are free instead

	await store.transaction(async (tx) => {
		const inserted = await tx.query<{ user_id: string }>(
			`INSERT INTO credit_grants (user_id, period, credits)
			 VALUES ($1, date_trunc('month', now())::date, $2)
			 ON CONFLICT (user_id, period) DO NOTHING
			 RETURNING user_id`,
			[userId, amount],
		);
		if (inserted.length === 0) return; // already granted this month

		await tx.query(
			"INSERT INTO credit_transactions (user_id, type, amount, description) " +
				"VALUES ($1, 'bonus', $2, $3)",
			[userId, amount, `Monthly free credits — ${plan.name} plan`],
		);
		await tx.query(
			'UPDATE fonderie_users SET credits = credits + $2, updated_at = now() WHERE id = $1',
			[userId, amount],
		);
	});
}
