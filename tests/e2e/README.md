# API e2e tests

Playwright specs that exercise the running API directly (the `request` fixture —
no browser).

## Why these live at the API layer

Some flows can't be driven through the app UI. MFA enrolment, for example, only
ever exposes its secret as a QR code, so verifying it means computing a TOTP from
the secret — which these tests read from the database, along with the emailed
verification pin. Those values are never returned over the wire.

## Prerequisites

- **API running** on `E2E_API_URL` (default `http://localhost:3000`).
- **Database reachable** via `DATABASE_URL` (or `E2E_DATABASE_URL` to override).
  `playwright.config.ts` loads `.env`, so the same `DATABASE_URL` the server uses
  is picked up automatically. Specs skip themselves when it's absent.

## Run

```sh
npm run test:e2e        # headless
npm run test:e2e:ui     # Playwright UI mode
```
