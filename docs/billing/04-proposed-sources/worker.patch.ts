// src/worker.ts  (proposed — phase 2 diff, shown as the changed block only)
// Diff vs today: the completion charge reads plan.credits.taskCost instead
// of a hardcoded 1, and a zero-cost plan (unlimited) skips the ledger
// write entirely — no plan-name `if` anywhere outside the catalog.

import { planForUser } from './billing/planFor.js';

// ... inside the bus handler, after scrapeGoogleMaps() returns `leads`:

const plan = await planForUser(store, task.user_id);
const cost = plan.credits.taskCost;

await store.transaction(async (tx) => {
	await tx.query(
		"UPDATE scrape_tasks SET results = $1::jsonb, status = 'complete', updated_at = now() WHERE id = $2",
		[JSON.stringify(leads), taskId],
	);
	// Success = charge the plan's task cost, atomically with the status
	// update. Free-scraping plans (taskCost 0) write no ledger row at all,
	// keeping SUM(amount) === balance with zero noise entries.
	if (cost > 0) {
		await tx.query(
			"INSERT INTO credit_transactions (user_id, task_id, type, amount, description) " +
				"VALUES ($1, $2, 'usage', $3, $4)",
			[task.user_id, taskId, -cost, `Scrape completed: ${task.url}`],
		);
		await tx.query(
			'UPDATE fonderie_users SET credits = credits - $2, updated_at = now() WHERE id = $1',
			[task.user_id, cost],
		);
	}
});
