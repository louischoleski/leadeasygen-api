import type { IStoreAdapter } from '@fonderie/store/types';

/**
 * The free ($0/month) plan every account starts on: 50 credits granted per
 * calendar month. There is no signup hook — the grant is applied lazily,
 * exactly once per month, by the requireAuth middleware on any authenticated
 * request. A brand-new account therefore receives its first 50 credits the
 * moment the dashboard loads, and no route has to remember to grant.
 */
export const FREE_MONTHLY_CREDITS = 50;

/**
 * Grant this month's free credits if the user hasn't received them yet.
 * Concurrency-safe: the credit_grants primary key (user_id, period) makes
 * the insert first-writer-wins; only the winning transaction appends the
 * ledger row and bumps the cached balance.
 */
export async function ensureMonthlyGrant(store: IStoreAdapter, userId: string): Promise<void> {
	await store.transaction(async (tx) => {
		const inserted = await tx.query<{ user_id: string }>(
			`INSERT INTO credit_grants (user_id, period, credits)
			 VALUES ($1, date_trunc('month', now())::date, $2)
			 ON CONFLICT (user_id, period) DO NOTHING
			 RETURNING user_id`,
			[userId, FREE_MONTHLY_CREDITS],
		);
		if (inserted.length === 0) return; // already granted this month

		await tx.query(
			"INSERT INTO credit_transactions (user_id, type, amount, description) " +
				"VALUES ($1, 'bonus', $2, 'Monthly free credits — Free plan')",
			[userId, FREE_MONTHLY_CREDITS],
		);
		await tx.query(
			'UPDATE fonderie_users SET credits = credits + $2, updated_at = now() WHERE id = $1',
			[userId, FREE_MONTHLY_CREDITS],
		);
	});
}
