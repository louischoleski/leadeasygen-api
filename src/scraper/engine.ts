import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import axios from 'axios';

/**
 * A single business scraped from Google Maps, enriched with any emails
 * harvested from its website. Mirrors the columns the old `leads` /
 * `lead_emails` tables were populated from, minus all DB concerns.
 */
export interface Lead {
	id: string;
	name: string;
	rating: number;
	reviews: number;
	category: string;
	address: string;
	website: string;
	phone: string;
	url: string;
	emails: string[];
}

// One minute — used both as the axios request timeout and its abort signal.
const REQUEST_TIMEOUT_MS = 1000 * 60;

// Domains / asset extensions that produce false-positive "emails".
const EMAIL_FILTER = [
	'.webp',
	'@wix.com',
	'@sentry-next.wixpress.com',
	'.png',
	'.jpg',
	'.jpeg',
	'.svg',
	'sentry.io',
	'@sentry.wixpress.com',
];

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

/** Strip stray zero-width / control characters lifted from the DOM text. */
const parseString = (val = ''): string =>
	val.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '').trim();

/**
 * Fetch a website and extract unique, filtered email addresses from its HTML.
 * Never throws — network/timeout failures yield an empty list.
 */
const fetchEmails = async (url = ''): Promise<string[]> => {
	try {
		const { data = '' } = await axios({
			url,
			method: 'get',
			timeout: REQUEST_TIMEOUT_MS,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!data) return [];

		let emailMatches: string[] | null = String(data).match(EMAIL_REGEX);

		if (emailMatches) {
			emailMatches = emailMatches.filter(
				(email) => !EMAIL_FILTER.some((filterItem) => email.includes(filterItem)),
			);
		}

		return emailMatches ? Array.from(new Set(emailMatches)) : [];
	} catch (error: any) {
		if (error?.name === 'TimeoutError') {
			console.warn(`Timeout when accessing: ${url}`);
		}
		return [];
	}
};

// Bounded timeouts — never wait forever (a hung scrape blocks the worker).
const NAV_TIMEOUT_MS = 45_000;
const SELECTOR_TIMEOUT_MS = 20_000;
// A recent desktop Chrome UA to get the standard results DOM.
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
	'(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Best-effort dismissal of Google's cookie/consent interstitial, which
 * otherwise hides the results and breaks every downstream selector.
 */
async function dismissConsent(page: import('playwright').Page): Promise<void> {
	try {
		const consentButton = page
			.locator(
				'button[aria-label*="Accept" i], button[aria-label*="agree" i], ' +
					'form[action*="consent"] button, button:has-text("Accept all"), ' +
					'button:has-text("Reject all")',
			)
			.first();
		if (await consentButton.isVisible({ timeout: 3000 }).catch(() => false)) {
			await consentButton.click({ timeout: 3000 }).catch(() => undefined);
			await page.waitForLoadState('domcontentloaded').catch(() => undefined);
		}
	} catch {
		// No consent screen — carry on.
	}
}

/**
 * Scrape a Google Maps search results URL and return the businesses found,
 * each enriched with emails harvested from its website.
 *
 * Pure function: no database access, no polling loop, no status transitions.
 * Intended to be invoked directly by a queue worker.
 *
 * Selectors target current Google Maps markup: the `div[role="feed"]` results
 * list, `a.hfpxzc` result links, and semantic `data-item-id` attributes on the
 * detail panel (stable across UI reskins), with class-based fallbacks.
 *
 * @param input.url   A Google Maps search results URL to scrape.
 * @param input.limit Optional cap on the number of places to visit.
 */
export async function scrapeGoogleMaps(input: { url: string; limit?: number }): Promise<Lead[]> {
	const { url: googleUrl, limit } = input;
	const cap = typeof limit === 'number' && limit >= 0 ? limit : Infinity;

	const browser = await chromium.launch({
		executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		headless: true,
	});

	try {
		const context = await browser.newContext({ locale: 'en-US', userAgent: USER_AGENT });
		const page = await context.newPage();

		await page.goto(googleUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
		await dismissConsent(page);

		// The search URL usually renders a results feed, but a specific query can
		// redirect straight to a single place page.
		const feed = page.locator('div[role="feed"]');
		let urls: string[] = [];

		// The feed hydrates well after domcontentloaded — wait for it to appear
		// rather than sampling the pre-render DOM (which always counts zero).
		const hasFeed = await feed
			.first()
			.waitFor({ state: 'visible', timeout: SELECTOR_TIMEOUT_MS })
			.then(() => true)
			.catch(() => false);

		if (hasFeed) {
			// Scroll the feed until the end-of-list marker appears, the result
			// count stops growing, or we've collected enough to satisfy `cap`.
			let previousCount = -1;
			let stagnantRounds = 0;
			for (let round = 0; round < 60; round += 1) {
				urls = await page.$$eval('a.hfpxzc', (els) =>
					(els as HTMLAnchorElement[]).map((e) => e.href),
				);
				if (urls.length >= cap) break;

				const atEnd = await page
					.getByText("You've reached the end of the list", { exact: false })
					.count()
					.then((n) => n > 0)
					.catch(() => false);
				if (atEnd) break;

				stagnantRounds = urls.length === previousCount ? stagnantRounds + 1 : 0;
				if (stagnantRounds >= 3) break;
				previousCount = urls.length;

				await feed.first().evaluate((node) => node.scrollBy(0, 4000));
				await page.waitForTimeout(700);
			}

			// Final sweep in case the last scroll loaded more.
			urls = await page.$$eval('a.hfpxzc', (els) =>
				(els as HTMLAnchorElement[]).map((e) => e.href),
			);
		} else if (page.url().includes('/maps/place/')) {
			urls = [page.url()];
		}

		// De-duplicate, keep only place links, and apply the cap.
		urls = Array.from(new Set(urls)).filter((href) => href.includes('/maps/place/'));
		if (Number.isFinite(cap)) urls = urls.slice(0, cap);

		if (urls.length === 0) {
			console.log('No place results found.');
			return [];
		}

		const scrapePageData = async (url: string): Promise<Lead | null> => {
			const newPage = await context.newPage();

			try {
				await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
				// The detail heading marks a fully-rendered place panel.
				await newPage.waitForSelector('h1', { timeout: SELECTOR_TIMEOUT_MS });

				// Extract via immediate `$` queries in Node (null when absent, no
				// wait) — no page.evaluate, so no esbuild `__name`/CSP-eval issues.
				const textOf = async (selector: string): Promise<string> => {
					const el = await newPage.$(selector);
					return el ? ((await el.textContent()) ?? '') : '';
				};
				const attrOf = async (selector: string, attr: string): Promise<string | null> => {
					const el = await newPage.$(selector);
					return el ? el.getAttribute(attr) : null;
				};

				const name = (await textOf('h1.DUwDvf')) || (await textOf('h1'));

				// Rating + reviews: aria-hidden number, and the reviews span specifically
				// (its aria-label contains "review" — the rating span's is "N stars",
				// which must not be matched instead).
				const ratingText = await textOf('div.F7nice span[aria-hidden="true"]');
				const reviewsLabel =
					(await attrOf('div.F7nice span[aria-label*="review" i]', 'aria-label')) ?? '';

				const category = await textOf('button.DkEaL');

				// Address / website / phone: semantic data-item-id attributes, with the
				// visible .Io6YTe value preferred over locale-specific aria-labels.
				let address = await textOf('button[data-item-id="address"] .Io6YTe');
				if (!address) address = (await attrOf('button[data-item-id="address"]', 'aria-label')) ?? '';

				const website =
					(await attrOf('a[data-item-id="authority"]', 'href')) ??
					(await attrOf('a[data-tooltip="Open website"]', 'href')) ??
					'';

				const phoneId = await attrOf('button[data-item-id^="phone:tel:"]', 'data-item-id');
				const phone =
					phoneId && phoneId.startsWith('phone:tel:')
						? phoneId.slice('phone:tel:'.length)
						: await textOf('button[data-item-id^="phone:tel:"] .Io6YTe');

				const rating = Number.parseFloat(ratingText.replace(',', '.'));
				const reviews = Number.parseInt(reviewsLabel.replace(/[^\d]/g, ''), 10);
				const emails = website ? await fetchEmails(website) : [];

				return {
					id: randomUUID(),
					name: parseString(name),
					rating: Number.isFinite(rating) ? rating : 0,
					reviews: Number.isFinite(reviews) ? reviews : 0,
					category: parseString(category),
					address: parseString(address),
					website,
					phone: parseString(phone),
					url,
					emails,
				};
			} catch (err) {
				console.warn(`Failed to scrape place ${url}:`, err instanceof Error ? err.message : err);
				return null;
			} finally {
				await newPage.close();
			}
		};

		const batchSize = 5;
		const results: Lead[] = [];

		for (let i = 0; i < urls.length; i += batchSize) {
			const batchUrls = urls.slice(i, i + batchSize);
			const batchResults = await Promise.all(batchUrls.map((u) => scrapePageData(u)));
			results.push(...batchResults.filter((r): r is Lead => r !== null));
			console.log(`Batch ${Math.floor(i / batchSize) + 1} completed.`);
		}

		return results;
	} finally {
		await browser.close();
	}
}

export default scrapeGoogleMaps;
