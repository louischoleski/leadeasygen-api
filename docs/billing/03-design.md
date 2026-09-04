# 03 — Design: one catalog, two engines

Extend billing to support subscriptions, prepaid credits, or both — by
adopting `@fonderie/billing` for what it already covers, keeping the wallet
the product owns, and feeding both from a **single product catalog** that
also carries every Stripe reference.

## Thesis

**One catalog definition, two billing engines.** Each engine consumes the
half of the catalog it understands. Dropping either half disables that
engine — that is the whole "subscriptions, credits, or both" switch.

```
                 src/billing/catalog.ts
        (plans + packs, amounts in code, price IDs from env)
              also served to the app: GET /v1/catalog
                    ↓ plans            packs ↓
   ┌────────────────────────────┐  ┌───────────────────────────┐
   │ Engine A — subscriptions   │  │ Engine B — credits        │
   │ @fonderie/billing          │  │ src/credits/ (product)    │
   │ checkout · portal ·        │  │ ledger · balance · packs  │
   │ webhook · requirePlan      │  │ monthly grant · task cost │
   └────────────────────────────┘  └───────────────────────────┘
        both read the viewer's plan · neither imports the other
```

## The catalog — configuration and Stripe references

One typed module (`src/billing/catalog.ts`, full draft in
[04-proposed-sources/catalog.ts](04-proposed-sources/catalog.ts)). Two rules
carried over from the existing webhook code:

- **Money amounts and credit counts live in code** — the trusted catalog;
  never read back from Stripe metadata.
- **Stripe price IDs live in env** — per-environment, test/live swappable
  without a deploy.

Each plan entry carries its own economics:

```ts
{ name: 'free',      credits: { monthlyGrant: 50, taskCost: 1 }, policy: { activeJobs: { limit: 1 } } }
{ name: 'unlimited', credits: { monthlyGrant: 0,  taskCost: 0 }, policy: { activeJobs: { limit: null } },
  monthly: { amountCents: 4900, priceId: env.STRIPE_PRICE_UNLIMITED_MONTHLY }, yearly: { … } }
```

so the grant middleware, the worker, and the UI all read one definition, and
"unlimited scraping" needs no plan-name `if` outside the catalog.

The api serves the catalog (minus price IDs) at `GET /v1/catalog`; the app's
billing page renders from it — deleting the app-side mock and the three-way
drift.

### Stripe dashboard setup (one-time)

| Stripe object | Type | Env var | State |
|---|---|---|---|
| Product "Unlimited" → monthly $49 | recurring | `STRIPE_PRICE_UNLIMITED_MONTHLY` | new |
| Product "Unlimited" → yearly $468 ($39/mo) | recurring | `STRIPE_PRICE_UNLIMITED_YEARLY` | new |
| Credit pack prices (3) | one-time | `STRIPE_PRICE_SMALL/MEDIUM/LARGE` | exists |
| Webhook → `/billing/webhook` | subscription events | `STRIPE_WEBHOOK_SECRET_BILLING` | new |
| Webhook → `/v1/webhooks/stripe` | `checkout.session.completed` | `STRIPE_WEBHOOK_SECRET` | exists |

## Engine A — subscriptions: register, don't rebuild

One boot-time registration (`BillingModule` + `StripeProvider` + the
catalog's plans via a small adapter) yields `/billing/checkout`, `/billing/
portal`, `/billing/subscription`, `/billing/webhook`, `/plans`, the
`fonderie_plans`/`fonderie_subscriptions` tables, and `requirePlan`/
`getPlanLimit` middleware. Two product wins ride along: the Unlimited tier
becomes purchasable, and the free tier's *1 active job* limit — browser-only
today — moves server-side at task creation.

## Engine B — credits: the wallet stays, becomes plan-aware

The ledger and idempotency tables are untouched. Two functions stop
hardcoding economics and read the catalog keyed by the viewer's plan
(absence of a subscription row = free):

- `ensureMonthlyGrant` grants `plan.credits.monthlyGrant` (was: constant 50).
- The worker charges `plan.credits.taskCost` on completion (was: constant 1);
  zero-cost plans write no ledger row at all.

**The one deliberate deviation:** pack checkout keeps calling the `stripe`
SDK directly — `IBillingProvider` models subscription checkout only.
Wrapping one call site in a home-grown interface is ceremony, not
abstraction (KISS). Quarantined in `src/credits/routes.ts`, documented at
the call site; if fonderie grows a one-time mode, that's the seam.

## Coexistence rules

- **Two webhook endpoints, no router.** Stripe supports multiple endpoints;
  each verifies its own secret. Simpler than multiplexing (KISS).
- **No cross-imports between engines** — both read the catalog and the
  subscription row, mirroring fonderie's bricks-don't-import-bricks rule.
- **Grant enforcement stays in the `requireAuth` wrapper** (project-owned; no
  fonderie package touched) — it just becomes plan-aware.

## Subscriptions, credits, or both

| Product wants | Catalog shape | What runs |
|---|---|---|
| Both (target) | plans with prices + packs | BillingModule + wallet |
| Credits only (today) | plans without Stripe prices + packs | BillingModule unregistered; wallet reads the free entry |
| Subscriptions only | plans with prices, `creditPacks: []` | nothing to sell in packs; `taskCost: 0` + plan limits gate usage |

## Rollout

1. **Extract the catalog** — `src/billing/catalog.ts` + `GET /v1/catalog`;
   point the packs loader and the app's billing page at it. Pure refactor,
   kills the drift; worth doing even if nothing below ever ships.
2. **Make the wallet plan-aware** — grant/charge read the catalog. Everyone
   is on `free` until phase 3, so behavior is identical.
3. **Register BillingModule** — Stripe products + env vars per the table;
   app gains subscribe/portal; active-jobs limit moves server-side.

Each phase ships as its own PR.

## Scorecard

| Principle | How the design honors it |
|---|---|
| DRY | Catalog defined once (was 3×); subscription lifecycle reused from the brick; plan economics read from one place by grant, worker, and UI |
| KISS | No forked fonderie packages; two webhooks instead of an event router; no wallet rewrite; one small catalog→plans adapter as the only glue |
| Fonderie rules | Brick used where it covers the need; wallet written as product code; interfaces over concretes where one exists; single documented deviation where none does |
