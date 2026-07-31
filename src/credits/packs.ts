/** The one-time credit packs on offer. */
export type Pack = 'small' | 'medium' | 'large';

export interface PackDef {
	/** Credits granted on purchase. */
	credits: number;
	/** Price in cents (for our own records; Stripe charges via the Price ID). */
	amountCents: number;
	/** Stripe Price ID (from env). */
	priceId: string;
}

/**
 * Build the pack catalogue from environment. Credits and amounts are fixed in
 * code (the trusted source when granting), while Stripe Price IDs come from env.
 */
export function loadPacks(env: NodeJS.ProcessEnv): Record<Pack, PackDef> {
	return {
		small: { credits: 10, amountCents: 500, priceId: env.STRIPE_PRICE_SMALL ?? '' },
		medium: { credits: 50, amountCents: 2000, priceId: env.STRIPE_PRICE_MEDIUM ?? '' },
		large: { credits: 100, amountCents: 3500, priceId: env.STRIPE_PRICE_LARGE ?? '' },
	};
}

export function isPack(value: unknown): value is Pack {
	return value === 'small' || value === 'medium' || value === 'large';
}
