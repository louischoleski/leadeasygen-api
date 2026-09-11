// Unit tests for the trial-abuse defense's pure logic. DB/Stripe-touching
// paths (gate, signals recording) are exercised by the live dev-stack pass —
// these pin the decision math and the invariants that a regression would
// silently break.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreTrial } from '../trial-risk.js';
import {
	emailDomain,
	hashSignal,
	ipBucket,
	isDisposableDomain,
} from '../signals.js';
import { effectivePlanName } from '../../billing/catalog.js';

// ── scoreTrial ────────────────────────────────────────────────────

const clean = {
	cardFingerprintSeen: false,
	deviceFingerprintSeen: false,
	signupsFromDevice1h: 0,
	ipTrials24h: 0,
	disposableEmail: false,
	accountAgeMinutes: 60 * 24,
};

test('scoreTrial: a clean established account is low', () => {
	assert.deepEqual(scoreTrial(clean), { score: 0, tier: 'low' });
});

test('scoreTrial: card reuse ALONE is high — a used card gets no second free trial', () => {
	const r = scoreTrial({ ...clean, cardFingerprintSeen: true });
	assert.equal(r.tier, 'high');
});

test('scoreTrial: device reuse + disposable email challenges (medium)', () => {
	const r = scoreTrial({ ...clean, deviceFingerprintSeen: true, disposableEmail: true });
	assert.equal(r.score, 45);
	assert.equal(r.tier, 'medium');
});

test('scoreTrial: fresh account alone stays low', () => {
	const r = scoreTrial({ ...clean, accountAgeMinutes: 2 });
	assert.equal(r.tier, 'low');
});

test('scoreTrial: burst signups + device reuse + fresh account is high', () => {
	const r = scoreTrial({
		...clean,
		signupsFromDevice1h: 5,
		deviceFingerprintSeen: true,
		disposableEmail: true,
		accountAgeMinutes: 3,
	});
	assert.equal(r.tier, 'high');
});

// ── effectivePlanName — the free-unlimited-forever fix ────────────

test('effectivePlanName: a canceled unlimited subscription entitles NOTHING', () => {
	assert.equal(effectivePlanName({ plan: 'unlimited', status: 'canceled' }), null);
});

test('effectivePlanName: trialing/active/past_due entitle the plan', () => {
	for (const status of ['trialing', 'active', 'past_due']) {
		assert.equal(effectivePlanName({ plan: 'unlimited', status }), 'unlimited');
	}
});

test('effectivePlanName: incomplete/paused/unpaid and missing rows do not', () => {
	for (const status of ['incomplete', 'paused', 'unpaid']) {
		assert.equal(effectivePlanName({ plan: 'unlimited', status }), null);
	}
	assert.equal(effectivePlanName(null), null);
	assert.equal(effectivePlanName(undefined), null);
});

// ── disposable domains ────────────────────────────────────────────

test('isDisposableDomain: exact, subdomain, and trailing-dot variants all match', () => {
	assert.equal(isDisposableDomain('yopmail.com'), true);
	assert.equal(isDisposableDomain('mail.yopmail.com'), true);
	assert.equal(isDisposableDomain('yopmail.com.'), true);
	assert.equal(isDisposableDomain('gmail.com'), false);
	assert.equal(isDisposableDomain('notyopmail.com'), false);
	assert.equal(isDisposableDomain(null), false);
});

// ── ip bucketing ──────────────────────────────────────────────────

test('ipBucket: IPv4 passes through whole', () => {
	assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
});

test('ipBucket: IPv6 collapses to its /64 — low-64 rotation is one bucket', () => {
	const a = ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
	const b = ipBucket('2001:db8:1:2:1111:2222:3333:4444');
	assert.equal(a, b);
	assert.equal(a, '2001:db8:1:2::/64');
});

test('ipBucket: compressed :: forms expand consistently', () => {
	assert.equal(ipBucket('2001:db8::1'), ipBucket('2001:db8:0:0:0:0:0:2'));
});

// ── hashing ───────────────────────────────────────────────────────

test('hashSignal: deterministic and domain-separated', () => {
	assert.equal(hashSignal('ip', '1.2.3.4'), hashSignal('ip', '1.2.3.4'));
	assert.notEqual(hashSignal('ip', 'x'), hashSignal('card', 'x'));
	assert.match(hashSignal('domain', 'gmail.com'), /^[0-9a-f]{64}$/);
});

// ── email domain extraction ───────────────────────────────────────

test('emailDomain: extracts, lowercases, and rejects junk', () => {
	assert.equal(emailDomain('A@Gmail.COM'), 'gmail.com');
	assert.equal(emailDomain('no-at-sign'), null);
	assert.equal(emailDomain(null), null);
	assert.equal(emailDomain('a@'), null);
});
