// The trial-abuse risk function — pure and tunable, per the Trial-Abuse
// Defense spec. Weak signals in, one score + tier out. No single signal
// decides alone: each is individually legitimate (a family shares a card, an
// office shares an IP) — value comes only from combination, so tune WEIGHTS
// toward challenging the middle tier, not code.

export interface TrialRiskSignals {
	/** The card on file has already been granted a trial by another account. */
	cardFingerprintSeen: boolean;
	/** Provider fraud read (Stripe Radar). Adjacent, not trial-specific — not
	 * wired yet: at gate time no charge has run, so there is no Radar outcome
	 * to read. Kept in the model so a later webhook-fed signal drops in. */
	radarRisk?: 'normal' | 'elevated';
	/** Signups recorded from this device fingerprint in the last hour. */
	signupsFromDevice1h: number;
	/** This device fingerprint has already been granted a trial by another account. */
	deviceFingerprintSeen: boolean;
	/** The account email's domain is a known disposable-mail domain. */
	disposableEmail: boolean;
	/** Minutes since the account registered (proxy for mailbox age). */
	accountAgeMinutes: number;
	/** Trials granted from this IP in the last 24h. Small weight — shared IPs. */
	ipTrials24h: number;
}

export type TrialRiskTier = 'low' | 'medium' | 'high';

export interface TrialRiskResult {
	score: number;
	tier: TrialRiskTier;
}

export function scoreTrial(s: TrialRiskSignals): TrialRiskResult {
	let score = 0;
	if (s.cardFingerprintSeen) score += 60; // strongest signal
	if (s.radarRisk === 'elevated') score += 25;
	if (s.signupsFromDevice1h > 3) score += 30;
	if (s.deviceFingerprintSeen) score += 25;
	if (s.disposableEmail) score += 20;
	if (s.accountAgeMinutes < 10) score += 10;
	if (s.ipTrials24h > 2) score += 10; // small — homes/offices share IPs

	const tier: TrialRiskTier = score < 30 ? 'low' : score <= 70 ? 'medium' : 'high';
	return { score, tier };
}
