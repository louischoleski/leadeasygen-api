-- A one-time code that carries OAuth tokens from the API's callback to the SPA.
--
-- @fonderie/auth's googleCallback returns the access and refresh tokens as
-- JSON. That is right for a native client, which controls the request — but a
-- BROWSER arrives at the callback by top-level redirect from Google, so it
-- would simply render credentials on screen.
--
-- The obvious alternative, redirecting to the app with the tokens in a URL
-- fragment, keeps them off the wire but writes a refresh token into browser
-- history, extensions, and anything reading window.location. A one-time code
-- costs one table and keeps the tokens on the server until the SPA asks for
-- them over its own POST.
CREATE TABLE IF NOT EXISTS oauth_handoff (
	-- Random, single-use, and short-lived. Never derived from anything.
	code        TEXT        PRIMARY KEY,
	payload     JSONB       NOT NULL,
	expires_at  TIMESTAMPTZ NOT NULL,
	-- Set atomically by the exchange, which is what makes it single-use: a
	-- replayed code updates zero rows rather than handing out a second copy.
	used_at     TIMESTAMPTZ,
	created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sweeping expired rows is a range scan over this.
CREATE INDEX IF NOT EXISTS oauth_handoff_expires_idx ON oauth_handoff (expires_at);
