# Stripe Webhooks — Production Setup

A step-by-step runbook for pointing Stripe at this API. Follow it in order.

**Time:** ~30 minutes. **You need:** Stripe dashboard access, Vercel project
access, the production API URL, and the value of `CRON_SECRET`.

---

## Why this is worth doing carefully

Stripe calls **you**, not the other way around. When someone subscribes, the
money moves inside Stripe and this database finds out one way only: Stripe POSTs
an event to this API. The browser redirect back to `/billing?checkout=success`
is cosmetic — the user can close the tab, lose signal, or never load it. Nothing
in that redirect activates anything.

So if the webhook is not configured, or is configured with the wrong secret:

| what happens | what the customer sees |
|---|---|
| Pays $49 for Unlimited | Stays on free tier — 5 credits, 1 concurrent job |
| Buys a 100-credit pack for $38 | Wallet never credited |
| Cancels | Keeps Unlimited forever, for free |
| Card declines on renewal | No dunning email, keeps full access |
| Trial about to end | No warning before the charge |

The dangerous part is that **a wrong secret looks exactly like no traffic**.
Stripe charges the card and reports success; this endpoint rejects the signature
with a 400 that exists only in a log. Nothing in the product looks broken until
a customer complains. That is why Step 5 exists — do not skip it.

---

## Step 0 — Find out what is actually wrong

Do this **before** changing anything. "No webhooks have arrived" has two
completely different causes and they need different fixes.

```bash
curl -s -X POST https://<your-api-domain>/internal/cron/purge \
  -H "Authorization: Bearer $CRON_SECRET" | jq .billing
```

> `CRON_SECRET` is in the Vercel project's environment variables. Read it from
> there — don't paste it into a chat or a shell history file. Prefer
> `read -rs CRON_SECRET` then the curl above.

You'll get:

```json
{
  "subscriptions": 0,
  "lastEventAt": null,
  "purchases": 0,
  "lastPurchaseAt": null
}
```

Read it like this:

| `subscriptions` | `lastEventAt` | diagnosis |
|---|---|---|
| `0` | `null` | Nobody has ever subscribed. Not yet an outage — but unproven. Continue. |
| `> 0` | `null` | **Outage.** Subscriptions exist and no webhook was ever accepted. |
| `> 0` | recent | Working. |
| `> 0` | old/stale | **Outage.** Was working, stopped — usually a rotated secret. |

`lastEventAt` advances **only** on a signature-verified event. That is precisely
what makes it a real test rather than a guess.

If you get `503 CRON_SECRET is not configured`, set that in Vercel first.

---

## Step 1 — Work in Test mode first

Toggle **Test mode** in the Stripe dashboard (top right). Everything below is
done twice: once in test, once in live. Do not do live first.

---

## Step 2 — Register the subscription endpoint

**Developers → Webhooks → Add endpoint**

- **URL:** `https://<your-api-domain>/billing/webhook`
- **Events:**

```
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.trial_will_end
invoice.paid
invoice.payment_failed
```

This endpoint drives the Unlimited plan: activation, renewal receipts, dunning,
cancellation, and the trial-ending heads-up.

---

## Step 3 — Register the payment endpoint

**Add endpoint** again — a *separate* endpoint, not more events on the first one.

- **URL:** `https://<your-api-domain>/billing/webhook/payment`
- **Events:**

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
payment_intent.succeeded
payment_intent.payment_failed
charge.refunded
charge.dispute.created
charge.dispute.closed
```

This endpoint drives the credit wallet: pack purchases, delayed-payment methods,
and refund/chargeback clawbacks.

> **Why two endpoints?** They are two different routes with two different signing
> secrets (`routes.ts:92` and `routes.ts:122`). One endpoint carrying all the
> events cannot work — only one of the two secrets would ever verify.

---

## Step 4 — Copy both signing secrets into Vercel

Each endpoint has its **own** signing secret. On each endpoint's page click
**Reveal** under *Signing secret* (`whsec_…`).

| Stripe endpoint | Vercel variable |
|---|---|
| `/billing/webhook` | `STRIPE_WEBHOOK_SECRET` |
| `/billing/webhook/payment` | `STRIPE_WALLET_WEBHOOK_SECRET` |

**The single most common mistake is putting the same secret in both.** They are
different values. If you swap them, both endpoints return 400 and you will see
exactly the symptom from Step 0 — which looks identical to "not configured".

Set them in **Vercel → Settings → Environment Variables**, scoped to Production.

---

## Step 5 — Redeploy

Environment variables are read at boot. Changing them in Vercel does **not**
affect the running deployment.

Redeploy, and wait for it to finish before continuing.

---

## Step 6 — Prove the signature verifies

> **Do not use the `/internal/cron/purge` numbers for this step.** They cannot
> move yet, and checking them here will make a working webhook look broken.
> See "Why the ops numbers can't prove this" below. The numbers are Step 7's job.

Send a test event from each endpoint's page (**Send test event**), or via the CLI:

```bash
stripe trigger payment_intent.succeeded      # → /billing/webhook/payment
stripe trigger customer.subscription.created # → /billing/webhook
```

Then read the status from **either** side — both show the same truth:

- **Vercel → Logs** (usually faster): look for `POST /billing/webhook` and
  `POST /billing/webhook/payment` and read the status column.
- **Stripe → Developers → Webhooks →** click the endpoint *→ recent deliveries*,
  which also shows the response body.

A **200 is only reachable after the signature verifies** — `webhook-shared.ts:23-31`
returns 400 for a missing *or* invalid signature, before any handler runs. So a
200 in the Vercel log is itself proof the secret for that endpoint is correct.

Note that each trigger exercises only its own endpoint: `payment_intent.*` never
reaches `/billing/webhook`, so seeing traffic on only one of the two is expected
until you trigger an event for the other.

| status | meaning |
|---|---|
| **200** | Reached this deployment **and the signature verified**. This endpoint is correctly configured. |
| **400** | Signature rejected — wrong secret for this endpoint. Go back to Step 4. |
| **404** | Wrong URL or wrong domain. |
| **401 / 403** | Something in front is blocking it. Webhooks authenticate by signature, not by header — remove any auth or IP rule on `/billing/webhook*`. |
| **no attempts listed** | Endpoint not registered, or these event types aren't selected on it. |

A 200 response body will often read:

```json
{"received":true,"ignored":"no-matching-subscription"}
```

**That is success, not failure.** It means the signature verified and the handler
ran; it declined to act because a synthetic test event references a Stripe
customer that has no user in this database. A real customer's event will match.

### Why the ops numbers can't prove this

Two design details make `/internal/cron/purge` useless as a test-event check:

- `lastEventAt` is `MAX(provider_event_at)` over `fonderie_subscriptions`. While
  `subscriptions` is `0` it is a MAX over an empty table, so it is **necessarily
  `null`** no matter how many events arrive.
- `stripe trigger payment_intent.succeeded` is **deliberately a no-op**: only
  PaymentIntents with `metadata.reason === 'purchase'` are credited
  (`stripe.ts:1004`), precisely so the safety-net can't double-credit. A synthetic
  trigger carries no such metadata.

So with a perfectly working webhook you would still see
`{"subscriptions":0,"lastEventAt":null,"purchases":0,"lastPurchaseAt":null}`.
Those numbers only start moving once a **real** subscription or purchase exists —
which is Step 7.

---

## Step 7 — One real end-to-end run in test mode

Test events prove the plumbing. This proves the product.

Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.

**Subscription:**
1. Register a throwaway account in the app.
2. Subscribe to Unlimited.
3. Confirm the app now shows Unlimited and the credit limit is gone.
4. `jq .billing.subscriptions` should have incremented.

**Credit pack:**
1. On a *free* account (packs are blocked for subscribers — `blockPacksWhileSubscribed`).
2. Buy the 10-credit pack.
3. **The wallet balance must rise by 10.**
4. `jq .billing.lastPurchaseAt` should now be recent.

Step 7's wallet check is the one that proves the payment endpoint end to end.
If the charge succeeds and the balance does not move, the payment webhook is not
landing — recheck `STRIPE_WALLET_WEBHOOK_SECRET`.

Delete the throwaway account afterwards.

---

## Step 8 — Go live

Switch the dashboard out of Test mode and repeat **Steps 2–6** with live values.

Live mode has **its own endpoints and its own signing secrets** — test secrets
will not work in live. Update both Vercel variables to the live `whsec_…` values
and redeploy again.

Then do one real transaction with a real card and refund it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Stripe shows **400** | Wrong signing secret for that endpoint | Step 4 — the two secrets are not interchangeable |
| Stripe shows **404** | Wrong URL or wrong domain | Check the path has no trailing slash |
| Stripe shows **401/403** | Something in front is blocking it | Webhooks are unauthenticated by design — they authenticate by signature. Remove any auth/IP rule on `/billing/webhook*` |
| Stripe shows **200**, `lastEventAt` still `null` | **Usually not a problem.** With `subscriptions: 0`, `lastEventAt` is a MAX over an empty table and is always `null` | Trust the 200. Prove it with a real subscribe in Step 7 |
| `{"ignored":"no-matching-subscription"}` | Test event references a Stripe customer with no local user | Expected for synthetic events. Not an error |
| Everything 200, wallet not credited | Events registered on the wrong endpoint | `payment_intent.*` and `checkout.session.*` belong on `/billing/webhook/payment` |
| `503 CRON_SECRET is not configured` | Missing env var | Set `CRON_SECRET` in Vercel |
| Timeouts | Cold start on a serverless instance | Stripe retries automatically; check it succeeds on retry |

---

## Local development

The Stripe CLI forwards real events to localhost without any public URL:

```bash
stripe listen --forward-to localhost:3000/billing/webhook
stripe listen --forward-to localhost:3000/billing/webhook/payment
```

Each prints its own `whsec_…` for `.env`. Trigger events with:

```bash
stripe trigger customer.subscription.created
stripe trigger payment_intent.succeeded
```

---

## Reference

| What | Where |
|---|---|
| Route definitions | `@fonderie/billing` → `src/routes.ts:92`, `:122` |
| Secrets read at boot | `src/fonderie.ts:263`, `:269` |
| Event normalization | `@fonderie/billing` → `src/providers/stripe.ts` |
| Health check | `webhookStats()` → `src/services/provider-health.ts` |
| Plans and pack prices | `src/billing/catalog.ts` |

**Rotating a secret later?** It is the same trap as a misconfiguration: rotate in
Stripe, update Vercel, redeploy, then **run Step 6 again**. A rotated secret that
was never redeployed fails silently and charges customers the whole time.
