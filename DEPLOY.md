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
(`npx playwright install chromium`). Without the worker running, jobs are
accepted and queue up but never process.

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
   curl https://<api>/health                       # {"status":"ok",...}
   curl -X POST https://<api>/internal/cron/purge \
        -H "Authorization: Bearer $CRON_SECRET"    # {"ok":true}
   ```
   Then register a user in the app, confirm the verification email arrives,
   and check the login shows up with an IP… which brings us to:

## Known gap

Login history records **no IP address**. The adapters resolve the client IP
but `FonderieApp.handle()` builds a fresh context and drops it, so every
fonderie-owned route loses it. This also blinds per-IP rate limiting and the
geo/risk IP signals. It is a bug in `@fonderie/core` + the adapters, not a
configuration mistake here — fix pending.
