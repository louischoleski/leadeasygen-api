# 01 — Current state of the credits system

As merged on `main` of `leadeasygen-api` and `leadeasygen-app` (2026-09-04).

## Stack

| Service | Runs as | Role in credits |
|---|---|---|
| `leadeasygen-app` | Vite/React, :5173 | Dashboard reads balance, shows job costs; billing page mostly mock |
| `leadeasygen-api` | Fonderie/Express, :3000 | Ledger, grants, pack checkout, Stripe webhook, task routes |
| worker (`npm run worker` in api) | separate process | Runs scrapes; charges credits on completion |
| `leadeasygen-db` | Postgres :5432 | Everything below lives here |

Registered fonderie modules: `auth`, `events` (MemoryTransport), `courier`.
`@fonderie/billing` is **not installed**.

## Data model

Source of truth is an append-only ledger; the user row carries a cache.

```
fonderie_users.credits          INTEGER — fast-read cache, never authoritative
credit_transactions             the ledger: signed rows, balance = SUM(amount)
  type ∈ purchase | usage | refund | bonus
credit_purchases                Stripe checkout idempotency (session_id PK)
credit_grants                   monthly-grant idempotency (PK user_id, period)
```

Invariants the implementation maintains:

- **Every balance is explainable from the ledger alone** — grants, purchases,
  and charges all flow through `credit_transactions`.
- **Ledger row + cache bump are always one transaction.**
- **Every entry point is idempotent**: webhook by Stripe session id, monthly
  grant by `(user_id, period)` primary key (first-writer-wins under
  concurrency — verified live with a first page load racing three
  authenticated requests), task charge by completion (worker writes it once,
  atomically with the status flip).

## Flows

**Monthly grant (free plan, 50/month).** Applied lazily in the project-owned
`src/auth/requireAuth.ts` wrapper — every authenticated request calls
`ensureMonthlyGrant` *before* the user row is read, so `req.user.credits`
always includes a fresh grant. No signup hook, no cron: a new account gets
its first 50 on the first dashboard load; the month rollover grants on the
first activity of the new month. Grant failures are non-fatal (retried next
request). Consequences to be aware of: unused credits roll over; inactive
months are skipped, not back-paid.

**Pack purchase.** `POST /v1/credits/checkout` creates a Stripe Checkout
session (one-time payment, `stripe` SDK called directly); the webhook
(`POST /v1/webhooks/stripe`, raw-body, signature-verified) credits the pack.
Credits/amounts come from the trusted catalog keyed by pack name in metadata —
never from raw numbers in the event.

**Task charge.** Tasks cost 1 credit each (one task per keyword), charged by
the worker **on completion only** — a failed or abandoned scrape writes no
ledger row, which is why the UI says "no credits charged" instead of
"refunded". Task creation gates on the authoritative ledger balance inside
the insert transaction (plus a fast-fail on the cached value).

**Retry.** `POST /v1/tasks/:id/retry` re-runs a failed task and marks the
original `superseded_by` the new one; listings hide superseded rows.

## Routes (credits-related)

```
GET  /v1/credits/balance        { credits }
GET  /v1/credits/transactions   last 50 ledger rows
POST /v1/credits/checkout       pack name → Stripe Checkout URL
POST /v1/webhooks/stripe        checkout.session.completed → credit the pack
POST /v1/tasks/create           balance-gated; charged later on completion
POST /v1/tasks/:id/retry        balance-gated the same way
```

## Configuration today

```
STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_SMALL   →  10 credits / $5
STRIPE_PRICE_MEDIUM  →  50 credits / $20
STRIPE_PRICE_LARGE   → 100 credits / $35
FREE_MONTHLY_CREDITS = 50   (constant in src/credits/monthlyGrant.ts)
```

## What is still mock (app side)

- The billing page's pack catalog (**disagrees with the api**: app mock says
  100/$9, 300/$19, 500/$29), tier cards, ledger UI, and checkout handshake.
- The subscription tier itself (`free`/`unlimited`) is client-side state.
- The free plan's "1 active job" limit is enforced only in the browser.
- Only the **credit balance** on the dashboard is real (reads
  `/v1/credits/balance`).

The catalog therefore exists in three unreconciled places — app mock, api
env, Stripe dashboard. That drift is the first thing the proposal removes.
