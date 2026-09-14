import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { resolveClientIp } from "@fonderie/core/middlewares";
import type { FonderieApp } from "@fonderie/core";
import type { IStoreAdapter } from "@fonderie/store/types";

/**
 * Carry the caller's identity into the synthetic request these routes build.
 *
 * `fonderie.handle()` is called directly here rather than through the adapter,
 * and a Request constructed by hand starts with none of the caller's context.
 * Auth records the IP and user-agent on every login event, so anything missing
 * here is missing from the security surface the user reads: an OAuth sign-in
 * shows "Unknown device" and no IP while password sign-ins show both — which
 * makes the login history useless precisely where it matters, since a provider
 * sign-in is the one an attacker is most likely to use.
 *
 * The IP is RESOLVED, not copied: behind a proxy the socket address is the
 * proxy's. resolveClientIp applies the same TRUST_PROXY-aware logic the
 * adapters use — never re-derive forwarding rules locally.
 */
export function callerContext(req: Request): {
	headers: Record<string, string>;
	init: { meta: { clientIp: string } } | undefined;
} {
	const incoming = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (typeof value === "string") incoming.set(key, value);
		else if (Array.isArray(value)) incoming.set(key, value.join(", "));
	}
	const clientIp = resolveClientIp(req.socket?.remoteAddress ?? undefined, incoming);

	const headers: Record<string, string> = { cookie: req.headers.cookie ?? "" };
	const ua = req.headers["user-agent"];
	if (typeof ua === "string" && ua) headers["user-agent"] = ua;

	return { headers, init: clientIp ? { meta: { clientIp } } : undefined };
}

/**
 * The browser half of Google sign-in.
 *
 * @fonderie/auth ships the OAuth mechanics — building the authorize URL,
 * binding a CSRF state cookie, exchanging the code, minting tokens. What it
 * cannot do is decide how a BROWSER should travel through that, because the
 * answer differs per client: a native app holds the tokens the callback
 * returns; a web SPA cannot, because it arrives there by redirect.
 *
 * Two routes bridge that, and each exists for a concrete reason:
 *
 *   GET /auth/google/start
 *     The SPA must NOT fetch() the authorize URL. googleInit sets `oauth_state`
 *     as a cookie on the API's domain, and a cross-site fetch from the app's
 *     domain cannot reliably store it — browsers block third-party cookie
 *     writes. The callback would then find no state and reject every sign-in.
 *     A top-level navigation here makes every cookie first-party.
 *
 *   GET /auth/google/callback
 *     Wraps the package's callback, which answers with the tokens as JSON —
 *     a browser would render credentials on screen. Instead the tokens are
 *     parked under a single-use code and the browser is redirected to the app,
 *     which exchanges the code over its own POST.
 */
const HANDOFF_TTL_SECONDS = 120;

export function registerGoogleRedirectRoutes(
  app: Express,
  fonderie: FonderieApp,
  store: IStoreAdapter,
  frontendUrl: string,
): void {
  // ── start ────────────────────────────────────────────────────────
  app.get("/auth/google/start", async (req: Request, res: Response) => {
    try {
      const caller = callerContext(req);
      const inner = await fonderie.handle(
        new Request("http://internal/auth/google", {
          method: "GET",
          headers: caller.headers,
        }),
        caller.init,
      );
      const body = (await inner.json()) as { result?: { url?: string } };
      const url = body.result?.url;
      if (!url)
        return res.redirect(
          302,
          `${frontendUrl}/login?error=oauth_unavailable`,
        );

      // Forward the state cookie VERBATIM. It is the CSRF binding the
      // callback checks; dropping it here turns every sign-in into a
      // "state mismatch" that looks like an attack rather than a bug.
      for (const cookie of inner.headers.getSetCookie?.() ?? []) {
        res.append("Set-Cookie", cookie);
      }
      return res.redirect(302, url);
    } catch (err) {
      console.error("[auth:google] start failed:", err);
      return res.redirect(302, `${frontendUrl}/login?error=oauth_unavailable`);
    }
  });

  // ── callback ─────────────────────────────────────────────────────
  app.get("/auth/google/callback", async (req: Request, res: Response) => {
    // EVERYTHING here is inside the try. An async Express handler that
    // rejects is not caught by Express 4 — the request simply hangs until
    // the platform's gateway gives up, which is what a user sees as a
    // spinner that never resolves. A hang is strictly worse than an error:
    // it hides the cause and leaves the browser parked on our domain.
    try {
      const target = new URL("http://internal/auth/google/callback");
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") target.searchParams.set(k, v);
      }
      const caller = callerContext(req);
      const inner = await fonderie.handle(
        new Request(target, { method: "GET", headers: caller.headers }),
        caller.init,
      );
      const body = (await inner.json()) as {
        reason?: string;
        result?: { tokens?: { access: string; refresh: string } };
      };

      if (!inner.ok || !body.result?.tokens) {
        // Never surface the provider's raw text to the browser — it is not
        // actionable by a user and may echo request details.
        console.error(
          "[auth:google] callback failed:",
          inner.status,
          body.reason,
        );
        return res.redirect(302, `${frontendUrl}/login?error=oauth_failed`);
      }

      const code = randomBytes(32).toString("hex");
      await store.query(
        `INSERT INTO oauth_handoff (code, payload, expires_at)
			 VALUES ($1, $2, now() + make_interval(secs => $3))`,
        [code, JSON.stringify(body.result.tokens), HANDOFF_TTL_SECONDS],
      );
      // Clear the state cookie: it has done its job and must not be replayable.
      res.append(
        "Set-Cookie",
        "oauth_state=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax",
      );
      return res.redirect(302, `${frontendUrl}/auth/callback?code=${code}`);
    } catch (err) {
      // Name the cause in the log — a missing table here means the deploy
      // is ahead of its migrations, which is the likeliest failure and the
      // one whose raw message reads least like its fix.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        "[auth:google] callback failed:",
        /relation .* does not exist/i.test(message)
          ? `${message} — this deployment is ahead of its migrations; run \`npm run migrate\` against this database.`
          : message,
      );
      return res.redirect(302, `${frontendUrl}/login?error=oauth_failed`);
    }
  });
}

/**
 * Registered AFTER mount(), unlike the redirect routes above — and the
 * difference is not cosmetic.
 *
 * This app deliberately omits express.json() (it would drain the stream the
 * fonderie adapter re-reads), so `req.body` is populated by the adapter's
 * bridge(), which mount() installs. A route registered before mount() sees an
 * undefined body and rejects every valid code as missing — which is exactly
 * what happened on the first attempt.
 *
 * The redirect routes must come BEFORE mount() to beat its catch-all; this one
 * must come AFTER it to have a body. Both constraints are real.
 */
export function registerGoogleExchangeRoute(
  app: Express,
  store: IStoreAdapter,
): void {
  app.post("/auth/google/exchange", async (req: Request, res: Response) => {
    try {
      const code = (req.body as { code?: unknown } | undefined)?.code;
      if (typeof code !== "string" || code.length < 32) {
        return res
          .status(400)
          .json({ reason: "INVALID_PARAMETER", explanation: "Missing code" });
      }
      // Single-use enforced by the UPDATE itself: a replay matches no row,
      // so two requests can never both receive the tokens.
      const [row] = await store.query<{
        payload: { access: string; refresh: string };
      }>(
        `UPDATE oauth_handoff
			    SET used_at = now()
			  WHERE code = $1 AND used_at IS NULL AND expires_at > now()
			 RETURNING payload`,
        [code],
      );
      if (!row) {
        return res
          .status(400)
          .json({
            reason: "INVALID_CODE",
            explanation: "This sign-in link is no longer valid.",
          });
      }
      return res.json({
        reason: "GOOGLE_AUTH_OK",
        result: { tokens: row.payload },
      });
    } catch (err) {
      console.error("[auth:google] exchange failed:", err);
      return res
        .status(500)
        .json({
          reason: "SERVER_ERROR",
          explanation: "Could not complete sign-in.",
        });
    }
  });
}

/** Housekeeping for the cron: handoffs are worthless once expired. */
export async function purgeExpiredHandoffs(
  store: IStoreAdapter,
): Promise<void> {
  await store.query(
    `DELETE FROM oauth_handoff WHERE expires_at < now() - interval '1 day'`,
  );
}
