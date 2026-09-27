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
