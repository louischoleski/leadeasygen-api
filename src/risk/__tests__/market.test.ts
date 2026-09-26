import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isOutsideMarket, parseMarketCountries } from '../market.js';

test('parseMarketCountries: unset or blank means "everywhere" (null), never an empty set', () => {
	assert.equal(parseMarketCountries(undefined), null);
	assert.equal(parseMarketCountries(''), null);
	assert.equal(parseMarketCountries('  , , '), null);
});

test('parseMarketCountries: normalises case and whitespace, dedupes', () => {
	const set = parseMarketCountries(' ca, us ,US ');
	assert.deepEqual([...(set ?? [])].sort(), ['CA', 'US']);
});

test('parseMarketCountries: a malformed code is a boot error, not a silently dropped rule', () => {
	assert.throws(() => parseMarketCountries('CA,USA'), /TRIAL_MARKET_COUNTRIES/);
	assert.throws(() => parseMarketCountries('C4'), /TRIAL_MARKET_COUNTRIES/);
});

test('isOutsideMarket: fires only on a KNOWN country outside a configured market', () => {
	const market = new Set(['CA', 'US']);
	assert.equal(isOutsideMarket('FR', market), true);
	assert.equal(isOutsideMarket('CA', market), false);
	// unknown is unknown — off-platform, missing header, malformed value
	assert.equal(isOutsideMarket(null, market), false);
	// no market configured → the signal can never fire
	assert.equal(isOutsideMarket('FR', null), false);
});
