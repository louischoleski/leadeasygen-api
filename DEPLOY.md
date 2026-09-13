# Deploying LeadEasyGen

Three pieces, three homes. They are separate on purpose — the reason is the
scraper.

| Piece | Runs on | Why |
|---|---|---|
| `app/` (React SPA) | Vercel | static build, nothing to run |
| `api/` (Express) | Vercel serverless | request/response only, no browser |
| `worker` (scrape queue) | any long-running host | drives **Playwright/Chromium** |
| Postgres | Supabase | reachable from serverless |

**The worker cannot run on Vercel.** It launches a real Chromium through
Playwright and consumes a queue continuously; serverless gives it neither a
browser binary nor a long-lived process. Run it wherever it can keep running
(the Docker box is fine) with `DATABASE_URL` pointed at Supabase. Everything
else deploys to Vercel.

---

## 1. Database (Supabase)

Create a project, then take **both** connection strings from *Project Settings →
Database*:

- **Transaction pooler**, port `6543` → the API's `DATABASE_URL`. Serverless
  opens many short-lived connections; direct ones run out. Fonderie is
  compatible with transaction mode: `PGAdapter` issues plain parameterised
  queries (node-postgres sends them unnamed, which the pooler allows — named
  prepared statements would not survive), transactions check out one client
  for their whole span, and every advisory lock in the codebase is the
  transaction-scoped `pg_advisory_xact_lock`, released at commit. A
  session-scoped lock would break here; there aren't any.
- **Direct**, port `5432` → migrations and the worker. DDL wants a stable
  session, and the worker opens a dedicated client to `LISTEN` for job
  notifications, which transaction mode does not support. (It would still
  limp along on the transport's 1s fallback poll, but with connection errors
  and no instant wake-up.)
- **Session pooler** → use *instead of Direct* for those two if the machine is
  IPv4-only. Supabase direct connections are IPv6-only without the IPv4
  add-on; the session pooler is the IPv4-reachable session-mode equivalent, so
  `LISTEN` and DDL still work.

Pool sizing is already handled: the serverless entry caps each instance at one
connection (`PG_POOL_MAX`, default 1), because pg's default of 10 per warm
instance multiplies across instances and exhausts the pooler.

Apply the schema once (safe to re-run). Migrations never run at boot — on
serverless every cold start would re-run them and concurrent instances would
race — so this is the only thing that creates the schema (`npm run dev` calls
it first for convenience):

```bash
cd api
DATABASE_URL='<DIRECT connection>' npm run migrate
```

## 2. API → Vercel

```bash
cd api
npx vercel login
npx vercel link            # create/pick the project
```

Set the environment variables (each prompts for a value):

```bash
for k in DATABASE_URL JWT_SECRET RISK_PEPPER CRON_SECRET FRONTEND_URL \
         STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_WALLET_WEBHOOK_SECRET \
         STRIPE_PRICE_SMALL STRIPE_PRICE_MEDIUM STRIPE_PRICE_LARGE \
         STRIPE_PRICE_UNLIMITED_MONTHLY STRIPE_PRICE_UNLIMITED_YEARLY \
         SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS SMTP_FROM; do
  npx vercel env add "$k" production
done
```

Values that are **not** just copied from `.env`:

- `DATABASE_URL` — the **pooler** string (port 6543).
- `JWT_SECRET`, `RISK_PEPPER`, `CRON_SECRET` — fresh secrets, ≥32 chars:
  `openssl rand -hex 32`. Never reuse the dev values. `RISK_PEPPER` is
  mandatory: the risk engine **fails the boot** in production without a
  unique, non-placeholder pepper.
- `FRONTEND_URL` — the app's public URL. It is both the Stripe return URL and
  the CORS origin, so a wrong value breaks checkout *and* every browser call.
- `SMTP_*` — required. The boot fails in production without `SMTP_HOST`,
  because billing notices and the trial email-verification challenge must be
  deliverable. Ethereal is a test inbox, not a production sender.

```bash
npx vercel --prod
```

Vercel's Node web-server builder searches `app.*` → `index.*` → `server.*` and
serves the **default export** — so `src/app.ts` is the entrypoint and never
listens, while `src/index.ts` (which Vercel therefore never runs) owns the
long-running server and its timers. This is the layout the fonderie examples
document in `examples/DEPLOYMENT.md`; no functions directory, no rewrites.
The declared cron pings `POST /internal/cron/purge` daily (Vercel sends
`Authorization: Bearer $CRON_SECRET`) — that replaces the in-process retention
timer, which a frozen serverless instance would never fire.

## 3. App → Vercel

```bash
cd app
npx vercel link
npx vercel env add VITE_API_URL production          # the API deployment's URL
npx vercel env add VITE_STRIPE_PUBLISHABLE_KEY production   # optional
npx vercel env add VITE_GOOGLE_MAPS_API_KEY production      # optional
npx vercel --prod
```

`vercel.json` rewrites every path to `index.html`; without it a deep link
(`/billing`, `/login`) 404s, because react-router owns those paths.

## 4. Worker (wherever it can keep running)

```bash
DATABASE_URL='<DIRECT connection>' npm run worker
```

It needs `playwright` installed (a devDependency) and its browsers
(`npx playwright install chromium`). Without the worker running, **scrape jobs**
are accepted and queue up but never process.

Notification email is a separate matter — see below. It does not need this
worker, and does not silently stop if the worker is down.

### How a notification actually gets sent

Sending happens in two steps, and the split is what makes it survive
serverless. When auth or billing triggers an email, nothing is sent inside the
request: a durable row goes into the `fonderie_events` outbox. Delivery is a
second, separate step — so an instance frozen the moment it responds costs a
few seconds of delay, not the email.

Who performs that second step depends on where you run:

| Deployment | Consumer | Latency |
|---|---|---|
| `npm run dev` / any long-running host | the worker — `LISTEN`s for new rows | milliseconds |
| Vercel (no worker) | the API drains its own queue after each response | seconds |
| Either, as a backstop | the daily cron at `/internal/cron/purge` | up to a day |

The API auto-detects which case it is in; `NOTIFY_DRAIN_IN_API` forces it
either way (see `.env.example`). On Vercel the drain runs under the platform's
`waitUntil`, so it does not delay the response.

Two consequences worth knowing:

- **The API must have `SMTP_HOST` set even though the worker is what sends.**
  Consumer rows are written by the *publisher*, from its own subscriptions — an
  API with no courier registered writes events that are owed to nobody, and
  configuring SMTP later will not deliver them. The API logs a loud warning if
  it boots this way.
- **A drain being interrupted is harmless.** The row stays claimed only for
  `claimTimeoutMs` (5 min), after which any consumer may take it — so work
  abandoned by a killed instance comes back on its own, and two consumers
  racing for the same row still produce exactly one send.

Check the queue any time — the cron route returns it, after draining:

```json
{
  "ok": true,
  "queue": {
    "dead": 0,
    "pending": 0,
    "delivered": { "last24h": 1, "lastAt": "2026-09-13T03:36:15.477Z" }
  }
}
```

- `dead` — exhausted their retries and will never be delivered; each is logged
  with its error.
- `pending` — waiting or failed-but-retryable. Climbing steadily means nothing
  is consuming.
- `delivered` — what actually went out. Read this one first after a deploy:
  `dead: 0, pending: 0` is equally what a healthy queue and a queue nobody ever
  published to look like, so only a rising `last24h` proves mail is flowing.
- `drainError` — present only when the drain itself failed. Most often the
  deploy is ahead of its migrations; the message says so.

One limit worth knowing: `delivered` means **the SMTP server accepted it**, not
that it reached an inbox. A provider that accepts and then bounces asynchronously
(Resend does this for an unverified sending domain) looks identical to success
here. Check the provider's dashboard for that.

The same response carries `billing`, which answers the equivalent question for
money:

```json
"billing": {
  "subscriptions": 2,
  "lastWebhookAt": "2026-09-10T19:02:50.000Z",
  "purchases": { "last24h": 0, "lastAt": null }
}
```

A stale `STRIPE_WEBHOOK_SECRET` is the worst kind of outage: Stripe charges the
card and reports success, this API rejects the signature with a `400` that only
exists in a log, and the customer is paid-up with nothing credited. Nothing in
the product looks broken until someone complains.

These are the two things a webhook actually *moves*, so they detect it without
Stripe API access — `lastWebhookAt` advances only when a subscription webhook is
accepted, and a purchase row is written only when a payment webhook credits the
wallet. **After re-pointing an endpoint or rotating a secret, send a test event
from the Stripe dashboard and confirm `lastWebhookAt` moves.** If it doesn't, the
signature is being rejected.

Read `subscriptions` alongside it, because `lastWebhookAt: null` means two
opposite things on its own:

- `subscriptions: 0` — nobody has ever subscribed. Nothing is wrong; there is
  simply nothing for a webhook to have updated.
- `subscriptions: N` with `lastWebhookAt: null` — subscriptions exist and no
  webhook has ever been accepted for them. That is the outage.

## 5. After the first deploy

1. **CORS** — `FRONTEND_URL` must be the app's real origin. The API reflects
   the request origin today, so the practical failure is Stripe redirects, not
   preflights; still, set it correctly.
2. **Stripe webhooks** — re-point both endpoints at the deployed API
   (`/billing/webhook` and `/billing/webhook/payment`) and update
   `STRIPE_WEBHOOK_SECRET` / `STRIPE_WALLET_WEBHOOK_SECRET` with the new
   signing secrets. Until this is done, payments succeed at Stripe but the
   wallet never credits.
3. **Smoke test**:
   ```bash
   curl https://<api>/health                       # {"status":"ok"}
   curl -i https://<api>/                          # 302 -> FRONTEND_URL
   curl -X POST https://<api>/internal/cron/purge \
        -H "Authorization: Bearer $CRON_SECRET"    # {"ok":true}
   ```
   Then register a user in the app, confirm the verification email arrives,
   and check Settings → Login History shows the IP.

### Verifying the client IP behind the proxy

`TRUST_PROXY` is read by `@fonderie/core`'s `resolveClientIp`, not by this app —
nothing in `src/` references it, and that is expected. Set it in the environment
and it takes effect.

`TRUST_PROXY=1` means "one trusted proxy hop", so the client is the **last**
entry in `X-Forwarded-For` — the one Vercel appends itself. That is both correct
and spoof-safe there: a client-supplied value stays to the left and is never
chosen. It matches Express's numeric `trust proxy` convention.

Getting it wrong is quiet, not loud — every request resolves to the proxy's
address, so per-IP rate limiting collapses into one global bucket (one attacker
locks out everyone) and the geo/risk signals see a single fictional user. So
verify it rather than assuming:

```bash
# log in, then read the history back
curl -X POST https://<api>/auth/login -H 'Content-Type: application/json' \
     -d '{"email":"...","password":"..."}'
curl https://<api>/auth/login-history -H "Authorization: Bearer <access-token>"
```

The `ip` on the newest event must be a **public, routable** address. A private
one (`10.*`, `172.16–31.*`, `192.168.*`, `127.*`) or `null` means the setting is
not taking effect. Verified on this deployment 2026-09-13: a real client IP is
recorded.

## Known gaps

None outstanding. Login history now records the client IP (fixed in
`@fonderie/core` 0.12.0 — `handle()` was building a fresh context and
dropping what the adapter resolved, which also blinded per-IP rate limiting
and the geo/risk signals).

Two things this deployment deliberately does NOT disclose: `/health` answers
a bare `{"status":"ok"}` rather than naming fonderie and listing the
installed modules, and `/` redirects instead of printing the product name
and its auth endpoints. The adapter also suppresses `X-Powered-By`. None of
that fixes a vulnerability — it keeps the app out of the stack-wide scans
that assemble target lists for the next framework CVE.
