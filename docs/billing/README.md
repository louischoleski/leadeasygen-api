# Billing review pack

A self-contained brief for reviewing LeadEasyGen's credits system and the
proposal to extend it with subscriptions via `@fonderie/billing`. Written for
a senior reviewer who has not followed the work; everything referenced is
either in this folder or linked by PR number.

## Contents

| Doc | What it covers |
|---|---|
| [01-current-state.md](01-current-state.md) | The credits system as it runs on `main` today — data model, flows, invariants, what is still mock |
| [02-fonderie-audit.md](02-fonderie-audit.md) | Audit of the fonderie packages and where each piece of the credits system belongs |
| [03-design.md](03-design.md) | The proposal: "one catalog, two engines" — subscriptions via BillingModule, the wallet as product code, one catalog feeding both |
| [04-proposed-sources/](04-proposed-sources/) | Draft source files for the design (catalog, plan resolver, catalog route, plan-aware grant, worker diff, boot wiring) |
| [05-decision-sheet.md](05-decision-sheet.md) | Open decisions for the reviewer, plus a template for turning the review into implementation instructions |

## Context: how we got here

Recent merged work, in order (all verified live against the real stack):

- app **#4** — Google Places autocomplete on the "New scrape job" location input
- app **#5** — react-hook-form validation on the scrape form; category optional
- api **#1** — structured scrape-task params, retry-with-supersede, scraper feed-hydration fix
- app **#6** — dashboard wired to the real scraper api (tasks, polling, ledger-backed balance)
- api **#2** — free plan: 50 credits granted monthly, applied lazily in the `requireAuth` wrapper

The design in 03 is **proposed, not implemented**. Phases 1–2 of its rollout
are pure refactors with no behavior change; phase 3 (BillingModule) is where
subscriptions become real.

## What we ask of the reviewer

1. Read 01–03; skim 04 for shape rather than line-by-line correctness.
2. Rule on the items in [05-decision-sheet.md](05-decision-sheet.md) — several
   are product decisions the code cannot make.
3. Return the filled-in instruction template at the bottom of 05. That becomes
   the implementation brief; the phases in 03 are scoped so each ships as its
   own PR.
