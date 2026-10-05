import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";

import { callerContext } from "../googleWeb.js";

// The Google routes call fonderie.handle() with a hand-built Request that
// carries only an allow-list of the caller's headers. Anything auth needs from
// the original request must be on that list — the geolocation headers were
// not, so every Google sign-in was recorded without a location.
function fakeReq(headers: Record<string, string>): Request {
	return { headers, socket: { remoteAddress: "10.0.0.1" } } as unknown as Request;
}

test("callerContext forwards the platform geolocation headers", () => {
	const { headers } = callerContext(
		fakeReq({
			cookie: "oauth_state=abc",
			"user-agent": "Mozilla/5.0",
			"x-vercel-ip-country": "US",
			"x-vercel-ip-country-region": "CA",
			"x-vercel-ip-city": "Mountain%20View",
			"x-vercel-ip-timezone": "America/Los_Angeles",
			"cf-ipcountry": "US",
			authorization: "Bearer should-not-travel",
		}),
	);
	assert.equal(headers["x-vercel-ip-country"], "US");
	assert.equal(headers["x-vercel-ip-country-region"], "CA");
	assert.equal(headers["x-vercel-ip-city"], "Mountain%20View");
	assert.equal(headers["x-vercel-ip-timezone"], "America/Los_Angeles");
	assert.equal(headers["cf-ipcountry"], "US");
	// still an allow-list: unrelated headers do not travel
	assert.equal(headers.authorization, undefined);
	assert.equal(headers.cookie, "oauth_state=abc");
	assert.equal(headers["user-agent"], "Mozilla/5.0");
});

// A Google sign-in to an account scheduled for deletion must reach the app as
// "keep it?", not as a dead-end "sign-in failed": the refusal is parked under
// the handoff code and the exchange answers with it.
test("a pending-deletion refusal survives the handoff; tokens still do too", async () => {
	const { registerGoogleRedirectRoutes, registerGoogleExchangeRoute } = await import("../googleWeb.js");
	const handoffs = new Map<string, unknown>();
	const store = {
		query: async (sql: string, params: unknown[]) => {
			if (sql.includes("INSERT INTO oauth_handoff")) { handoffs.set(String(params[0]), JSON.parse(String(params[1]))); return []; }
			if (sql.includes("UPDATE oauth_handoff")) {
				const p = handoffs.get(String(params[0])); handoffs.delete(String(params[0]));
				return p ? [{ payload: p }] : [];
			}
			return [];
		},
	};
	const routes = new Map<string, (req: unknown, res: unknown) => Promise<unknown>>();
	const app = { get: (p: string, h: never) => routes.set(`GET ${p}`, h), post: (p: string, h: never) => routes.set(`POST ${p}`, h) };
	let answer: Response = new Response();
	const fonderie = { handle: async () => answer };
	registerGoogleRedirectRoutes(app as never, fonderie as never, store as never, "https://app.acme.example");
	registerGoogleExchangeRoute(app as never, store as never);

	const res = () => {
		const r: { status: number; location?: string; body?: unknown; headers: string[] } = { status: 200, headers: [] };
		const api = {
			redirect: (s: number, l: string) => { r.status = s; r.location = l; return api; },
			append: (_: string, v: string) => { r.headers.push(v); return api; },
			status: (s: number) => { r.status = s; return api; },
			json: (b: unknown) => { r.body = b; return api; },
		};
		return { r, api };
	};
	const req = (query: Record<string, string>, body?: unknown) => ({ query, headers: {}, socket: {}, body });

	answer = Response.json(
		{ reason: "ACCOUNT_PENDING_DELETION", explanation: "Scheduled", details: { deleteOn: "2026-11-04T00:00:00.000Z", restoreToken: "r".repeat(40), mfaRequired: false } },
		{ status: 403 },
	);
	const cb = res();
	await routes.get("GET /auth/google/callback")!(req({ code: "x", state: "y" }), cb.api);
	assert.equal(cb.r.status, 302);
	const code = new URL(cb.r.location!).searchParams.get("code");
	assert.ok(code && cb.r.location!.startsWith("https://app.acme.example/auth/callback"), cb.r.location);
	const ex = res();
	await routes.get("POST /auth/google/exchange")!(req({}, { code }), ex.api);
	assert.equal(ex.r.status, 403);
	assert.equal((ex.r.body as { reason: string }).reason, "ACCOUNT_PENDING_DELETION");
	assert.equal((ex.r.body as { details: { restoreToken: string } }).details.restoreToken, "r".repeat(40));

	// The normal path is unchanged.
	answer = Response.json({ reason: "GOOGLE_AUTH_SUCCESS", result: { tokens: { access: "a", refresh: "b" } } });
	const ok = res();
	await routes.get("GET /auth/google/callback")!(req({ code: "x", state: "y" }), ok.api);
	const okEx = res();
	await routes.get("POST /auth/google/exchange")!(req({}, { code: new URL(ok.r.location!).searchParams.get("code") }), okEx.api);
	assert.deepEqual((okEx.r.body as { result: unknown }).result, { tokens: { access: "a", refresh: "b" } });
});
