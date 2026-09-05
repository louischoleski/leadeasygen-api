# 05 — Decision sheet for the reviewer

Rulings needed before implementation. Defaults shown are what the draft
sources assume; overriding any of them is a one-place change in the catalog
or a scoped design change flagged below.

## Product decisions

1. **Canonical pack pricing.** The app mock says 100/$9, 300/$19, 500/$29;
   the api env (and the draft catalog) says 10/$5, 50/$20, 100/$35. Which is
   the product? *(Default: api env values.)*
2. **Unlimited plan economics.** Draft: `taskCost: 0, monthlyGrant: 0` —
   scraping is free, credits become irrelevant on that plan. Alternative:
   keep charging credits with a huge monthly grant, keeping one mental model.
   *(Default: taskCost 0.)*
3. **Rollover policy.** Unused free credits accumulate month over month
   (current behavior). Alternatives: reset to the grant amount, or cap the
   balance. *(Default: accumulate.)*
4. **Inactive months.** Lazy granting skips months with no activity — no
   back-pay on return. A cron would accrue regardless. *(Default: skip.)*
5. **Pricing display.** Yearly Unlimited drafted as $468/yr shown as $39/mo.
   Confirm amounts before creating Stripe prices.

## Architecture decisions

6. **One-time payments deviation.** Pack checkout calls the `stripe` SDK
   directly because `IBillingProvider` has no one-time mode. Accept the
   documented deviation, or invest in a small internal
   `ICreditsPaymentProvider` interface / upstream fonderie contribution?
   *(Default: accept the deviation.)*
7. **Grant placement.** Currently in the project-owned `requireAuth` wrapper
   (every authenticated request; one `ON CONFLICT DO NOTHING` upsert when
   already granted). Alternative: only on money endpoints (previous
   revision). *(Default: keep in requireAuth.)*
8. **Webhook topology.** Two Stripe endpoints (billing's subscription events
   + our pack webhook), each with its own secret. Alternative: one endpoint
   with event-type routing. *(Default: two.)*
9. **Radius semantics.** The scraper crawls a text search; the form's radius
   currently maps to the per-task lead cap (5→10, 10→25, 25→50, 50→100).
   Keep, rename the control, or implement real geo filtering later?
   *(Default: keep for now.)*
10. **Existing users at phase 3.** No migration is drafted: everyone without
    a subscription row is `free`, which matches all current users. Confirm
    no grandfathering is needed.

## Rulings already made (UI enforces them today; the api must mirror)

These were decided during the billing-UX work (app PR #7) and are live
client-side. Phase 3 must encode them server-side so the client-side gate is
never the only gate:

11. **Upgrades only — no downgrade endpoint.** Stripe charges the difference
    on an upgrade, but a mid-period downgrade would owe a prorated refund.
    The only path down is cancel-at-period-end (`cancel_at_period_end`),
    after which the account falls back to the free tier. The UI shows lower
    tiers as "Downgrade unavailable" and the cancel dialog leads with the
    paid-through date.
12. **No pack purchases while a paid plan is active.** A paid plan includes
    unlimited credits, so selling packs to a subscriber charges for something
    the subscription already covers. The UI disables the Buy Pack buttons;
    `POST /v1/credits/checkout` must also reject (409) when the caller has an
    active paid subscription.

## Known follow-ups (out of scope here, listed so they're not lost)

- App billing page beyond the balance: packs → real checkout via
  `/v1/credits/checkout`, ledger UI → `/v1/credits/transactions`, tier cards
  → `/v1/catalog` + `/billing/subscription`.
- Courier notifications on limit warnings (`MESSAGE_KEYS.limitWarning`).
- Workspace/team billing later via billing's `SubscriberType = 'workspace'`.
- Scrape e2e stays out of CI (it crawls Google Maps for real); local
  verification scripts exist in session history.

## Instruction template (fill in and send back)

```
Implement the billing extension per docs/billing/03-design.md with these rulings:

Decisions: 1:<…> 2:<…> 3:<…> 4:<…> 5:<…> 6:<…> 7:<…> 8:<…> 9:<…> 10:<…>
Rulings 11–12 stand as written (object here if not): <confirmed | …>

Scope: phase(s) <1 | 1–2 | 1–3>, one PR per phase, api first.
Changes to the drafted sources: <none | list>
Acceptance:
  - typecheck/lint/build green on both repos, existing e2e untouched
  - phase 1: app billing page renders from /v1/catalog; mock catalog deleted
  - phase 2: behavior identical for free users (50/month, 1 credit/task)
  - phase 3: subscribe + portal round-trip works against Stripe test mode;
    active-jobs limit enforced server-side; live verification with a fresh
    account before merge
Constraints: no @fonderie/* package modifications; no Claude attribution in
commits/PRs; follow existing repo conventions.
```
