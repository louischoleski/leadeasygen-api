# LeadEasyGen — Launch Readiness

Where the product stands, what remains, and why each item is ranked where it is.

**Last updated:** 2026-09-15 · **Scope:** `leadeasygen-api`, `leadeasygen-app`,
and the `@fonderie/*` packages they depend on.

---

## Where things stand in one paragraph

The product works end to end: people can sign up (email or Google), run scrapes,
be metered against a credit wallet, and subscribe. The plumbing that was
genuinely broken — a webhook that 500'd, OAuth sign-ups that never provisioned a
workspace, a scrape queue stalled for 22 hours, email that was queued and never
sent — is fixed and verified in production, and Stripe webhook configuration was
confirmed good on 2026-09-15. **What stands between here and charging real
customers is not engineering: it is one email-sender swap and one honest
end-to-end money test.** The larger open question is not technical at all — the credit packs currently undercut the
subscription badly enough that few users would ever rationally subscribe.

---

## Priority ranking, at a glance

| # | Item | Phase | Why this rank |
|---|---|---|---|
| **P0** | Replace the Resend sandbox sender | 1 | No real user can receive verification or reset email |
| **P0** | One real test-mode subscribe + pack purchase | 1 | The only check that proves money works |
| **P1** | Set `PUBLIC_API_URL` in Vercel | 2 | The registration alarm is inert without it |
| **P1** | Close the pack-vs-subscription pricing gap | 2 | Subscriptions are irrational below ~129 scrapes/mo |
| **P1** | One-time onboarding credit grant | 2 | New users effectively get 3 usable attempts, not 5 |
| **P1** | Trim the payment endpoint's 6 extra events | 2 | Every subscription event is delivered twice |
| **P2** | Structured logging in the API | 3 | An incident today gives a stack trace and nothing else |
| **P2** | Per-endpoint webhook warning | 3 | Known gap in what shipped 2026-09-15 |
| **P2** | `subscriberId: string \| null` | 3 | Root cause of the crash we patched at one call site |
| **P3** | Trial farming — decide the trial policy | 4 | Nobody holds one yet, so changing it is free today |
| **P3** | Trigger scrape on publish | 4 | Parked by choice; 1-minute cron is adequate |
| **P3** | Apple OAuth backend | 4 | Costs $99/yr and nothing forces it for a web app |

---

# Phase 0 — Shipped and verified

Everything here is in production and was confirmed working, not merely merged.

## Authentication

| What | Where |
|---|---|
| Google OAuth web redirect flow, CSRF state cookie, top-level navigation | `api#9`, `app` |
| Provider buttons gated on what the server reports via `/auth/providers` | `app` |
| OAuth sign-ups emit `user.registered` — workspace provisioning restored | `@fonderie/auth` |
| IP + device recorded on OAuth sign-ins, like every other login | `api#9`, `@fonderie/auth 7.7.0` |
| Unverified password revoked when an OAuth identity links in | `@fonderie/auth` (#334) |
| Phone sign-ins recorded in login history | `@fonderie/auth` (#339) |
| Boot-time warning when a security event has no caller identity | `@fonderie/auth` (#338) |
| Provider unlink / account deletion wired to endpoints that had no callers | `app#9` |
| Google and Apple brand marks on sign-in buttons and settings | `app#11`, `app#12` |

**The security fix worth knowing about:** an account with an unverified password
could be taken over by registering the same email through Google. The password is
now revoked when an OAuth identity links to an unverified account.

**Apple:** the UI is complete and gated. LeadEasyGen's API does not implement
Apple, so no button renders — correctly. See Phase 4.

## Billing and money

| What | Where |
|---|---|
| Hybrid model: `unlimited` subscription + credit wallet, one engine | `catalog.ts` |
| Credit packs charged in USD, wallet denominated in `CRD` at precision 0 | `catalog.ts` |
| Subscription webhook no longer 500s on missing subscriber metadata | `@fonderie/billing 9.2.3` |
| Webhook registration check — detects events Stripe was never told to send | `@fonderie/billing 9.3.0` |
| Trial-abuse gate at checkout: velocity, device, disposable-email, card signals | `risk/gate.ts` |
| Plan entitlement is status-aware — a cancelled trial does not keep access | `effectivePlanName()` |

## Operations

| What | Where |
|---|---|
| Notifications on a durable Postgres outbox, drained by cron and by the worker | `notifications.ts` |
| Dead-letter reporting — an undeliverable row is named, not silently counted | `/internal/cron/purge` |
| Scrape worker on Cloud Run Jobs, 1-minute schedule | `deploy/cloud-run-job.sh` |
| Ops endpoint reporting webhook health, email health, queue depth | `/internal/cron/purge` |
| Local Stripe harness — test webhooks in seconds instead of a deploy | `api#11` *(open)* |

## Verified in production on 2026-09-15

- Both Stripe endpoints **registered, enabled, and complete** (`ok: true`)
- All 14 consumed events return `200` — 34 deliveries, 0 non-2xx, across 3 runs
- A real subscription with proper metadata: created → `active` in our DB →
  cancelled → `canceled`, with `provider_event_at` advancing at each step
- Webhook configuration **confirmed correct by the owner on 2026-09-15** — task #22 closed

---

# Phase 1 — Launch blockers (P0)

Stripe webhook configuration was **confirmed good on 2026-09-15** and is no longer
a blocker — both endpoints registered, enabled and complete, all 14 consumed
events returning 200. What remains is one sender swap and one honest purchase.

### 1. Replace the Resend sandbox sender

**Blocks:** every transactional email to a real address — verification, password
reset, receipts, dunning, trial-ending notices.

The sandbox sender only delivers to the account owner. Until the domain is
verified, a real signup cannot verify their email, which means they cannot use
the product at all.

Was blocked on a date that has now passed.

### 2. Set `PUBLIC_API_URL` in Vercel · **P1**

```
PUBLIC_API_URL=https://leadeasygen-api.vercel.app
```

Without it, `/internal/cron/purge` reports
`registration: { skipped: "PUBLIC_API_URL is not set" }` and the alarm never
fires. It is **deliberately not inferred from `VERCEL_URL`** — that is the
per-deployment hostname, so it would never match the registered endpoint and
would report every event missing on every run. A check that cries wolf teaches
you to ignore it.

Redeploy after setting it; env vars are read at boot.

### 3. One real end-to-end money test

Everything so far proves *transport*. This proves the *product*.

In test mode, with `4242 4242 4242 4242`:

1. Register a throwaway account → subscribe to Unlimited → confirm the app shows
   Unlimited and the credit limit is gone
2. On a **free** account → buy the 10-credit pack → **confirm the balance rises
   by 10**

Step 2 is the only thing that has ever proven the payment endpoint end to end.
Delete the throwaway account afterwards.

> Use `scripts/dev-stripe.sh up` to do this locally in seconds rather than
> against production. See [STRIPE-WEBHOOKS.md](./STRIPE-WEBHOOKS.md).

---

# Phase 2 — Revenue correctness (P1)

The product works. These are reasons it would make less money than it should.

### 4. The packs undercut the subscription

**This is the most consequential open item, and it is not a bug — it is a
pricing decision that needs remaking.**

| volume | via 100-pack @ $0.38 | Unlimited @ $49 |
|---|---|---|
| 20 scrapes/mo | ~$7.60 | $49 |
| 50 scrapes/mo | $19 | $49 |
| **129 scrapes/mo** | **$49** | **$49** ← break-even |

A user must do roughly **129 scrapes a month** before subscribing is rational
(~103 against the yearly rate). Below that, packs are strictly cheaper — often
4–6×. So Unlimited only makes sense for genuinely heavy users, and everyone else
has a standing incentive to stay on packs forever.

Relatedly, the comment at `billing/catalog.ts:62-65` claims 50 scrapes via packs
is *"$19/mo — subscription-tier parity"*. It is not; the subscription is $49.
That reads like the pack prices were tuned against a $19 tier that no longer
exists, which would explain the gap.

**Options:** raise pack prices (~$0.70–0.90/credit puts break-even near 55–70
scrapes), or reintroduce a mid-tier around $19–25. **Not** by cutting the free
allowance — see below.

### 5. A one-time onboarding grant

Free is 5 credits/month, one credit per completed scrape, ~15–20 leads a scrape.
As a demonstration that is plenty.

The problem is the cold start: there is **no signup bonus**, and the first scrape
is almost always a fumble — wrong query, wrong geography, learning the filters.
So a new user gets about **3 real attempts, not 5**.

**Recommended:** a one-time 10-credit grant at signup. Non-recurring, so it
cannot be farmed beyond the account-creation defense already in place, and it
buys exactly the room to get the first two attempts wrong.

**Keep the recurring 5/month as-is.** It is doing real work as an anti-farming
ceiling — at 5/month multi-accounting is not worth anyone's time; at 25 it
becomes a business. Raising it would undercut the trial-abuse defense.

### 6. Trim the payment endpoint's extra events

`/billing/webhook/payment` is registered for **all 14** events instead of its 8.
The 6 subscription events are therefore delivered **twice**, once to each
endpoint. The payment endpoint no-ops on them, so nothing is broken — it is
wasted deliveries and log noise.

Remove from the payment endpoint in the Stripe dashboard:

```
customer.subscription.created   customer.subscription.updated
customer.subscription.deleted   customer.subscription.trial_will_end
invoice.paid                    invoice.payment_failed
```

---

# Phase 3 — Observability and hardening (P2)

Not blocking launch. These are what make the *next* incident cheap.

### 7. The API has no structured logging

There is no logger at all — about eight `console.error` calls. `@fonderie/logger`
exists and is not wired in.

The production incident on 2026-09-15 gave a stack trace and nothing else:

| | |
|---|---|
| stack trace | ✓ |
| Stripe event id | ✗ — cannot find or replay it |
| event type | ✗ — which of 14? |
| route | ✗ — `/billing/webhook` or `/payment`? |
| request id | ✗ — cannot correlate |

Diagnosing it required reading package source to work out which event was
responsible. With `eventType` and `providerEventId` on the line it would have
been immediate.

**Order:** log every webhook delivery in `@fonderie/billing` with
`{route, eventType, providerEventId, outcome}` → return the event id in error
responses so Stripe's dashboard shows which delivery failed → wire `LoggerModule`
into the API (the `X-Request-ID` correlation spine already exists).

### 8. Per-endpoint webhook warning

**Known gap in what shipped on 2026-09-15.** The runtime warning asks *"is this
event consumed anywhere?"* rather than *"by this endpoint?"* — so it stays silent
on exactly the double-delivery misconfiguration in item 6. The registration check
catches it; the warning does not. Needs the route's own event set passed in.

### 9. `subscriberId: string | null`

The webhook crash came from `subscriberId: metadata ?? ''` inventing an empty
string to satisfy a `string` type. `''` is not a uuid, so it reached Postgres and
threw.

The shipped fix guards the call site that crashed. **The root cause is that the
type asserts something the data does not guarantee** — and tests can only cover
what the type admits is possible, which is why no test caught it.

Making it `string | null` forces every consumer to handle absence at compile
time. Breaking change to the normalized shape; wants its own PR and a major bump.

---

# Phase 4 — Deferred, with reasons (P3)

These are decisions, not oversights.

### 10. Trial farming — card-reuse revocation

**Status:** deferred by design, not forgotten. Read this before building it —
the recommendation is to change the product before writing the code.

#### First, the state of play (verified 2026-09-16)

**Nobody holds a trial today.** Every `trialing` subscription in the provider is
a CLI fixture — none carries `subscriberId` metadata, so none came through
checkout. No real user has ever been granted one.

**But the trial is live in the code.** `catalog.ts` sets `trialDays: 14`, and
billing's checkout applies it to any subscriber who has not consumed one
(`checkout.controller.ts:244-249`). The next real checkout gets it.

So the exposure is **latent, not active** — which is the cheap moment to decide.
Changing the trial policy right now costs nothing and affects no one; changing it
after customers hold trials means either grandfathering them or taking something
back.

#### The problem it solves

As configured, a trial grants **14 days of genuinely unlimited scraping**:

| setting | value | consequence |
|---|---|---|
| `trialDays` | `14` | two weeks |
| `policy.activeJobs.limit` | `null` | no concurrency cap |
| `wallet.rates` | `{}` | **no credit metering — scraping is free** |
| `'trialing'` in `ENTITLED_STATUSES` | yes | full plan benefits while trialing |

So an abused trial is not a discount, it is the **most valuable thing in the
product, taken for free, repeatably**. That is what makes this worth defending at
all.

#### Why the existing gate cannot catch it

`trialCheckoutGate` (`src/risk/gate.ts`) scores velocity, device fingerprint,
disposable-email domain, IP, and card fingerprint *at checkout time*. Four of
those five work on a fresh signup. The card does not:

> `cardFingerprint()` can only read a card the subscriber **already has on
> file**. A brand-new account has no provider customer until checkout completes,
> so at gate time there is no card to compare.

The card first becomes knowable when the provider reports the trialing
subscription — i.e. at **webhook time**, after the trial has already been
granted. Catching it there means *revoking* something already given, which is why
this is a separate and harder problem than the gate.

Concretely, the surviving hole is: fresh browser profile + different IP + a real
email domain → unlimited trials on one card.

#### Recommendation: cap the trial before policing it

**The cheapest fix is not detection — it is removing the prize.**

Give the trial a generous but finite allowance (e.g. 50 credits over 14 days)
instead of uncapped access — or drop `trialDays` altogether if the trial is not
wanted at all. With nobody currently holding one, either is a one-line change
with no migration and no affected customer. A genuine evaluator never reaches the ceiling; a
farmer gets 50 scrapes rather than an uncapped fortnight, and the incentive to
farm largely disappears.

That is a change in `src/billing/catalog.ts`, not a distributed-systems problem.
No money-path risk, and no way to revoke a paying customer by mistake.

Doing detection first fixes the expensive half while the prize stays uncapped.

#### When to build the revocation anyway

Build it when there is **evidence of actual farming**, not before. The engine
already records the card fingerprint on every gated checkout, so abuse is
detectable retroactively — waiting is not flying blind.

Design reference: branch `fix/trial-risk-durable-enforcement` (PR #6, closed).
It does **not** merge — it forked before the `@fonderie/risk` migration and
conflicts with it, including trying to resurrect a deleted `src/risk/signals.ts`.
Treat it as a design document, not code to land.

Its four findings remain valid against any future implementation:

1. **Concurrency** — serialize on a card-hash advisory lock, doing the
   reuse-check and the stamp in one locked transaction. Otherwise two accounts
   sharing a card can both pass the check concurrently.
2. **Durability / fail-open** — an in-process bus is at-most-once, so a dropped
   event, a transient provider error, or a crash strands an un-enforced trial.
   An unresolvable card must **defer, never promote**, and a sweep must re-run
   enforcement idempotently for every still-pending trialing subscription. The
   event is an optimization, not the sole trigger.
3. **Revoke ordering** — `cancelSubscription` must be awaited *before* marking
   the trial revoked, both inside the locked transaction, so a cancel that throws
   rolls back and is retried rather than leaving the subscription live and the
   decision silently swallowed.
4. **Subscription id** — read the provider subscription id from our own
   `fonderie_subscriptions` row, not the event payload. A reused card with no
   cancellable id must defer, never grant.

The governing principle from the risk brick still applies: **decide ≠ enforce.**
The brick stays pure and answers "is this risky"; the app owns the side effect.

> **Correct this first, whatever you decide:** `billing/catalog.ts:44-48` claims
> this check exists and revokes trials. It describes behaviour that is not
> implemented. A stale comment asserting protection on a money path will be
> trusted by whoever reads it next.

### 11. Trigger the scrape job on publish

Parked deliberately. The 1-minute Cloud Scheduler cron is adequate, and
event-triggering adds a failure mode for latency that is not currently a
complaint.

### 12. Apple OAuth on the backend

Requires an **Apple Developer Program membership, $99/year**. Every field
`@fonderie/auth` needs — Team ID, Services ID, the `.p8` key — is issued only to
paid members.

The obligation that usually forces Sign in with Apple is App Store Guideline 4.8,
which applies to **iOS apps offering third-party login**. LeadEasyGen is a web
app, so nothing forces it.

**Recommendation:** skip unless the membership already exists for another
product, in which case it is $0 extra — one Team covers unlimited Services IDs.
The UI is ready and inert either way.

Also note: the web flow needs a **verified HTTPS domain** with an exact
registered return URL, so localhost cannot test it — unlike Google. And Apple
returns the user's name only on the *first* authorization, never again.

---

## Open pull requests

| PR | What | State |
|---|---|---|
| `leadeasygen-api#11` | Local Stripe harness — `dev-stripe.sh` + `stripe-sweep.sh` | **awaiting review** |

---

## Recurring lesson from this work

Nearly every bug fixed here was **a join between two individually-correct
layers**, disguised as something else:

- A webhook 500 that looked like a misconfiguration was a type inventing `''`
- A "broken database" was a pooler that rejects `LISTEN`
- A display bug was a request never carrying `clientIp`
- Migrations running out of order was lexicographic sort meeting 4-digit prefixes

Each was fixed **and** given a guard so the class cannot recur silently. That
pattern — fix the instance, then make the category loud — is worth continuing.

A second, narrower lesson: **a test that passes with and without the fix is
worth nothing.** Three tests written during this work did exactly that and had to
be rewritten. Verifying that a new test fails when the fix is removed is now part
of the routine.

---

## Reference

| | |
|---|---|
| Webhook setup + local loop | [STRIPE-WEBHOOKS.md](./STRIPE-WEBHOOKS.md) |
| Plans, packs, wallet economics | `src/billing/catalog.ts` |
| Trial-abuse gate | `src/risk/gate.ts` |
| Ops / health endpoint | `POST /internal/cron/purge` |
| Worker deploy | `deploy/cloud-run-job.sh` |

**Current pins:** `@fonderie/billing@^9.3.0` · `@fonderie/auth@^7.7.0` ·
`@fonderie/events@^5.5.0` · `@fonderie/risk@^0.2.3`
