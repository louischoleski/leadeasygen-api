// The money-path entitlement invariant that must not regress: a subscription
// row entitles its plan ONLY while it is in a live status. A canceled/lapsed
// trial row keeps plan='unlimited' but must resolve to the free tier — the
// "free-unlimited-forever" bug. (Trial risk SCORING now lives in
// @fonderie/risk with its own tests; this pins the app-specific guard.)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { effectivePlanName, resolveScrapeCharge, resolveActiveJobsLimit } from '../catalog.js';

test('effectivePlanName: a canceled unlimited subscription entitles NOTHING', () => {
	assert.equal(effectivePlanName({ plan: 'unlimited', status: 'canceled' }), null);
});

test('effectivePlanName: live statuses (active/trialing/past_due) entitle the plan', () => {
	for (const status of ['active', 'trialing', 'past_due']) {
		assert.equal(effectivePlanName({ plan: 'unlimited', status }), 'unlimited');
	}
});

test('effectivePlanName: dead statuses and missing rows resolve to free (null)', () => {
	for (const status of ['incomplete', 'paused', 'unpaid', 'canceled']) {
		assert.equal(effectivePlanName({ plan: 'unlimited', status }), null);
	}
	assert.equal(effectivePlanName(null), null);
	assert.equal(effectivePlanName(undefined), null);
});

test('resolveScrapeCharge: unlimited charges nothing; free charges 1 credit', () => {
	assert.equal(resolveScrapeCharge('unlimited'), null); // unlimited → no per-scrape charge
	const free = resolveScrapeCharge('free');
	assert.ok(free && free.cost === 1n);
	// A canceled-unlimited holder resolves to free via effectivePlanName → charged.
	const viaGuard = resolveScrapeCharge(effectivePlanName({ plan: 'unlimited', status: 'canceled' }));
	assert.ok(viaGuard && viaGuard.cost === 1n, 'canceled unlimited must be charged like free');
});

test('resolveActiveJobsLimit: free is capped, unlimited is uncapped', () => {
	assert.equal(resolveActiveJobsLimit('free'), 1);
	assert.equal(resolveActiveJobsLimit('unlimited'), null);
	// canceled unlimited → free cap of 1 (not uncapped)
	assert.equal(resolveActiveJobsLimit(effectivePlanName({ plan: 'unlimited', status: 'canceled' })), 1);
});
