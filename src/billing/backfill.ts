/**
 * Phase B — one-time backfill: seed the @fonderie/billing wallet from the legacy
 * hand-rolled credits, so cutover (Phase C) has balances to debit against.
 *
 * SAFE BY DESIGN:
 *  - Idempotent: re-runnable. The opening-balance ledger row is keyed by a
 *    stable idempotency_key, the balance + grant rows by their natural PKs;
 *    every write is ON CONFLICT DO NOTHING.
 *  - Conserves credits: each user's ENTIRE current balance (fonderie_users.credits
 *    — the authoritative legacy cache) is migrated as PURCHASED (granted_amount 0),
 *    so nobody loses or gains credits, and migrated credits never expire.
 *  - Reconciles: after writing, asserts SUM(wallet.amount) == SUM(legacy credits);
 *    a mismatch aborts (rolls back) with a nonzero exit.
 *  - No double-grant: marks the CURRENT month's periodic grant as already applied
 *    for users who already received it in the legacy system this month, so billing
 *    won't hand them a second free allowance after cutover.
 *  - --dry-run: does everything inside a transaction, prints the reconciliation,
 *    then ROLLS BACK — change nothing until you've reviewed the numbers.
 *
 * Run AFTER Phase A migrations have created the fonderie_wallet_* tables:
 *   npm run backfill:wallet -- --dry-run     # inspect, changes nothing
 *   npm run backfill:wallet                  # commit the backfill
 *
 * Point DATABASE_URL at a THROWAWAY copy first; never dry-run-untested against
 * the production LeadEasyGen database.
 */
import 'dotenv/config';
import { PGAdapter } from '@fonderie/store';

import { WALLET_CURRENCY } from './catalog.js';

const DRY_RUN = process.argv.includes('--dry-run');

// Opening balance: one 'adjustment' ledger row + one balance row per user with a
// nonzero legacy balance. All of it lands as PURCHASED (granted_amount 0) — a
// migrated balance persists and never expires. balance_after = credits because
// this is the first (and only) opening entry.
const OPENING_LEDGER_SQL = `
	INSERT INTO fonderie_wallet_ledger
		(subscriber_type, subscriber_id, currency, type, amount, balance_after, description, idempotency_key, metadata)
	SELECT 'user', u.id, $1, 'adjustment', u.credits, u.credits,
		'Opening balance migrated from legacy credits',
		'legacy-migration:opening-balance:' || u.id,
		jsonb_build_object('source', 'legacy-credits-migration', 'bucket', 'purchased')
	FROM fonderie_users u
	WHERE u.credits <> 0
	ON CONFLICT (idempotency_key) DO NOTHING`;

const OPENING_BALANCE_SQL = `
	INSERT INTO fonderie_wallet_balances
		(subscriber_type, subscriber_id, currency, amount, granted_amount)
	SELECT 'user', u.id, $1, u.credits, 0
	FROM fonderie_users u
	WHERE u.credits <> 0
	ON CONFLICT (subscriber_type, subscriber_id, currency) DO NOTHING`;

// Mark THIS UTC month's periodic grant as already applied for users who received
// it in the legacy system this month (their legacy balance — migrated above —
// already includes it). billing's period key is 'YYYY-MM' (UTC), matching
// currentGrantPeriod('month'). Only the current period matters: billing never
// re-grants past periods, so we don't seed them.
const GRANT_MARKER_SQL = `
	INSERT INTO fonderie_wallet_grants
		(subscriber_type, subscriber_id, currency, period, amount)
	SELECT 'user', g.user_id, $1, to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM'), g.credits
	FROM credit_grants g
	WHERE to_char(g.period, 'YYYY-MM') = to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM')
	ON CONFLICT (subscriber_type, subscriber_id, currency, period) DO NOTHING`;

async function scalar(store: PGAdapter, sql: string, params: unknown[] = []): Promise<number> {
	const [row] = await store.query<{ n: string | number }>(sql, params);
	return Number(row?.n ?? 0);
}

async function main() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is required (point it at a THROWAWAY database first).');

	const store = new PGAdapter(url);
	if (!(await store.testConnection())) throw new Error('Cannot connect to the database — check DATABASE_URL.');

	// Preflight: Phase A migrations must have created the wallet tables.
	const walletTablePresent = await scalar(
		store,
		`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'fonderie_wallet_balances'`,
	);
	if (!walletTablePresent) {
		throw new Error('fonderie_wallet_balances not found — run Phase A migrations (npm run migrate / boot) first.');
	}

	const legacyUsers = await scalar(store, `SELECT count(*)::int AS n FROM fonderie_users WHERE credits <> 0`);
	const legacyTotal = await scalar(store, `SELECT COALESCE(SUM(credits), 0)::bigint AS n FROM fonderie_users WHERE credits <> 0`);
	const negativeUsers = await scalar(store, `SELECT count(*)::int AS n FROM fonderie_users WHERE credits < 0`);
	const walletBefore = await scalar(store, `SELECT count(*)::int AS n FROM fonderie_wallet_balances WHERE currency = $1`, [WALLET_CURRENCY]);

	console.log(`\n── Phase B backfill${DRY_RUN ? ' (DRY RUN — will roll back)' : ''} ──`);
	console.log(`  legacy users with a nonzero balance : ${legacyUsers}`);
	console.log(`  legacy total credits                : ${legacyTotal}`);
	console.log(`  legacy users with a NEGATIVE balance: ${negativeUsers}  (carried as-is; the old system had no overdraft floor)`);
	console.log(`  existing CRD wallet balance rows     : ${walletBefore}`);

	const DryRun = Symbol('dry-run-rollback');
	try {
		await store.transaction(async (tx) => {
			await tx.query(OPENING_LEDGER_SQL, [WALLET_CURRENCY]);
			await tx.query(OPENING_BALANCE_SQL, [WALLET_CURRENCY]);
			await tx.query(GRANT_MARKER_SQL, [WALLET_CURRENCY]);

			// Reconcile INSIDE the transaction — abort if credits weren't conserved.
			const [{ n: walletTotal }] = await tx.query<{ n: string }>(
				`SELECT COALESCE(SUM(amount), 0)::bigint AS n FROM fonderie_wallet_balances WHERE currency = $1`,
				[WALLET_CURRENCY],
			);
			const [{ n: walletRows }] = await tx.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM fonderie_wallet_balances WHERE currency = $1`,
				[WALLET_CURRENCY],
			);
			const [{ n: grantRows }] = await tx.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM fonderie_wallet_grants WHERE currency = $1`,
				[WALLET_CURRENCY],
			);
			console.log(`\n  → CRD wallet balance rows now        : ${walletRows}`);
			console.log(`  → CRD wallet total amount            : ${walletTotal}`);
			console.log(`  → current-period grant markers seeded: ${grantRows}`);

			if (BigInt(walletTotal) !== BigInt(legacyTotal)) {
				throw new Error(
					`RECONCILIATION FAILED: wallet total ${walletTotal} != legacy total ${legacyTotal} — rolling back.`,
				);
			}
			console.log(`  ✓ reconciliation OK — wallet total == legacy total (${walletTotal})`);

			if (DRY_RUN) throw DryRun; // roll back — changed nothing
		});
		console.log(`\n✓ Backfill committed.\n`);
	} catch (err) {
		if (err === DryRun) {
			console.log(`\n(DRY RUN) rolled back — no changes written. Re-run without --dry-run to commit.\n`);
		} else {
			throw err;
		}
	} finally {
		await store.end(); // release the pg pool so the process exits
	}
}

main().catch((e) => {
	console.error(`\n✗ ${e instanceof Error ? e.message : e}\n`);
	process.exit(1);
});
