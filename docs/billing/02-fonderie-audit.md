# 02 — Fonderie audit: where the credits system belongs

Audit of the fonderie framework (via the repo's `.claude/skills/fonderie/`
signature and outcome docs) against our credits system.

## Package inventory

| Status in this api | Packages |
|---|---|
| Registered at boot | `auth`, `events` (MemoryTransport), `courier` |
| Installed, unregistered | `workspaces` |
| Infrastructure | `core`, `store` (PGAdapter), `adapter-express` |
| Used by the app frontend | `client`, `react`, `react-auth` |
| Not installed | **`billing`**, `permissions`, `config`, `audit`, `webhooks`, `logger`, `customers` |

## What `@fonderie/billing` models

From its generated signatures/outcomes docs:

- **Plan catalog** — `fonderie_plans` (tiers, features, monthly/yearly Stripe
  price ids), `/plans` CRUD routes, plans also definable in code via
  `IBillingConfig.plans`.
- **Subscriptions** — `StripeProvider` (checkout session, customer portal,
  webhook event normalization), `fonderie_subscriptions` lifecycle
  (`trialing/active/past_due/canceled/…`), `/billing/checkout|portal|
  subscription|webhook` routes.
- **Windowed usage metering** — `recordUsage`/`getUsage` per metric into
  `fonderie_usage_records`; plan `policy` entries like
  `{ limit: 50, window: 'month' }`; `withBilling`/`requirePlan`/
  `requireFeature` middleware; `getLimitStatus` reports `resetsAt`; courier
  notifications on limit warnings.

What it does **not** model: a **stored-value wallet** — buy N credits in a
one-time payment, balance persists and rolls over, debit on consumption. Its
checkout is subscription-mode only (`priceId` → recurring). No table holds a
purchasable balance; counters reset per window and cannot absorb top-ups.

## Component mapping

| Our component | Fonderie home |
|---|---|
| Plan catalog / tiers / plan gating | `@fonderie/billing` (`fonderie_plans`, `requirePlan`) |
| Monthly free allotment | billing's windowed policy counters are the package-native analogue; our ledger grant is the wallet-shaped equivalent |
| Per-task charge on completion | billing's `recordUsage` is the metering analogue; ours is a wallet debit |
| One-time credit packs via Stripe | **no fonderie home** — provider interface has no one-time mode |
| The wallet itself (ledger, balance, refunds) | **custom product code** — the sanctioned "write it" bucket |
| `credits` cache on `fonderie_users` | `@fonderie/auth`'s table via the documented extend-don't-fork pattern |

## Verdict

Per the repo's own rules (`.claude/skills/fonderie/SKILL.md`), the defined
anti-pattern is *reimplementing a brick that covers your need*. Billing
covers **subscriptions**; it does not cover **prepaid wallets** — and the
skill's closing rule ("when a package doesn't cover something, write it —
that's the actual product") is exactly our case. The current custom wallet is
rules-compliant.

Two lines to watch:

1. **The moment real subscriptions are built** (Unlimited tier, portal, plan
   gating), doing that by hand *would* be the anti-pattern — that work
   belongs to `BillingModule`. This is what the proposal in 03 adopts.
2. **Direct `stripe` SDK use for pack checkout** brushes against
   "interfaces over concretes", but `IBillingProvider` has no one-time-payment
   method to hide behind. Kept as a single documented deviation, quarantined
   in `src/credits/routes.ts` (see decision sheet, item 6).
