// Where a FREE TRIAL is offered. Paid checkout is never gated by geography;
// this only decides whether the trial branch of /billing/checkout is open.
//
// The country itself comes from @fonderie/geo (the platform's edge headers on
// Vercel). Two rules keep it honest: country is the only decision-grade field
// (region/city are display-only), and "unknown" — off-platform, header missing,
// malformed — is never treated as suspicious.

const ISO_ALPHA2 = /^[A-Z]{2}$/;

/**
 * Parse TRIAL_MARKET_COUNTRIES ("CA,US"). Unset/blank ⇒ null ⇒ trials
 * everywhere. A malformed entry throws at boot: a rule that silently drops a
 * country would look exactly like a rule that works.
 */
export function parseMarketCountries(raw: string | undefined): ReadonlySet<string> | null {
	if (!raw) return null;
	const codes = raw
		.split(',')
		.map((c) => c.trim().toUpperCase())
		.filter((c) => c.length > 0);
	if (codes.length === 0) return null;
	for (const c of codes) {
		if (!ISO_ALPHA2.test(c)) {
			throw new Error(
				`TRIAL_MARKET_COUNTRIES: "${c}" is not an ISO-3166-1 alpha-2 code (expected e.g. "CA,US")`,
			);
		}
	}
	return new Set(codes);
}

/** True only for a KNOWN country outside a CONFIGURED market. */
export function isOutsideMarket(country: string | null, market: ReadonlySet<string> | null): boolean {
	if (!market || !country) return false;
	return !market.has(country);
}
