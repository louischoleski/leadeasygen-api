# Moving to leadeasygen.com

A step-by-step runbook for putting the product on its own domain instead of the
`*.vercel.app` ones. Follow it in order.

**Time:** ~45 minutes of work, plus DNS propagation. **You need:** registrar
access for `leadeasygen.com`, Vercel access to both projects, Google Cloud
Console, and the Stripe dashboard.

**Do this BEFORE verifying the Resend sending domain.** Resend verification is
tied to a domain; doing it against `vercel.app` first means doing it twice.

---

## Why this is worth more than cosmetics

`vercel.app` is on the [Public Suffix List](https://publicsuffix.org/). That means
`leadeasygen-api.vercel.app` and `leadeasygen-app.vercel.app` are treated as
**two unrelated sites** by browsers — no cookie can ever be shared between them,
and every API call is cross-site.

Putting both under one apex makes them same-site:

| | today | after |
|---|---|---|
| frontend | `leadeasygen-app.vercel.app` | `leadeasygen.com` |
| API | `leadeasygen-api.vercel.app` | `api.leadeasygen.com` |
| relationship | **cross-site** (PSL) | **same-site** |

So this is a real improvement to the auth path, not just a nicer URL.

**The old `*.vercel.app` URLs keep working** after you attach a custom domain.
Nothing is cut over destructively, and rollback at any step is "put the old value
back and redeploy."

---

## Step 0 — Know what references the domain

Four settings and three external systems. Everything else derives from these.

| where | key | today | after |
|---|---|---|---|
| API (Vercel) | `FRONTEND_URL` | `https://leadeasygen-app.vercel.app` | `https://leadeasygen.com` |
| API (Vercel) | `GOOGLE_REDIRECT_URI` | `…-api.vercel.app/auth/google/callback` | `https://api.leadeasygen.com/auth/google/callback` |
| API (Vercel) | `PUBLIC_API_URL` | *(unset)* | `https://api.leadeasygen.com` |
| App (Vercel) | `VITE_API_URL` | `https://leadeasygen-api.vercel.app` | `https://api.leadeasygen.com` |

External: **Google Cloud Console** (OAuth), **Stripe** (two webhook endpoints),
**Resend** (sending domain).

> `FRONTEND_URL` does double duty — it is both the CORS origin and the redirect
> target after OAuth (`fonderie.ts:64`, `googleWeb.ts:148`). Getting it wrong
> breaks sign-in in a way that looks like an OAuth problem.

---

## Step 1 — Attach the domains in Vercel

**App project** → Settings → Domains → Add

- `leadeasygen.com`
- `www.leadeasygen.com` (Vercel will offer to redirect one to the other — accept)

**API project** → Settings → Domains → Add

- `api.leadeasygen.com`

Vercel shows the DNS records to create. At your registrar:

| type | name | value |
|---|---|---|
| `A` | `@` | `76.76.21.21` |
| `CNAME` | `www` | `cname.vercel-dns.com` |
| `CNAME` | `api` | `cname.vercel-dns.com` |

> Use whatever Vercel actually displays — the apex target occasionally changes.

Wait for Vercel to show **Valid Configuration** on all three. TLS certificates are
issued automatically. Propagation is usually minutes; allow up to an hour.

Confirm before continuing:

```bash
curl -s -o /dev/null -w "app  %{http_code}\n" https://leadeasygen.com
curl -s -o /dev/null -w "api  %{http_code}\n" https://api.leadeasygen.com/health
```

Both must return `200`. The API is still serving the old env values — that's fine.

---

## Step 2 — Add the new Google redirect URI (do NOT remove the old one)

**Google Cloud Console → APIs & Services → Credentials →** your OAuth 2.0 Client

Under **Authorized redirect URIs**, *add*:

```
https://api.leadeasygen.com/auth/google/callback
```

Under **Authorized JavaScript origins**, *add*:

```
https://leadeasygen.com
```

**Keep the existing `vercel.app` entries for now.** Both sets valid at once means
sign-in works throughout the transition, and you can roll back without touching
Google again. They come out in Step 6.

Google can take a few minutes to apply changes.

---

## Step 3 — Update the environment variables

**Vercel → leadeasygen-api → Settings → Environment Variables** (Production):

```
FRONTEND_URL        = https://leadeasygen.com
GOOGLE_REDIRECT_URI = https://api.leadeasygen.com/auth/google/callback
PUBLIC_API_URL      = https://api.leadeasygen.com
```

**Vercel → leadeasygen-app → Settings → Environment Variables** (Production):

```
VITE_API_URL = https://api.leadeasygen.com
```

`GOOGLE_REDIRECT_URI` must match the Console entry **character for character** —
scheme, host, path, no trailing slash. There is a boot-time validator
(`fonderie.ts:218`) that warns when it is malformed, but it cannot know what you
typed into Google.

---

## Step 4 — Redeploy both projects

Environment variables are read **at boot**. Changing them in Vercel does not
affect the running deployment, and `VITE_*` values are baked into the frontend
bundle at build time — so the app genuinely must be rebuilt, not just restarted.

Redeploy **API first**, then **app**. Wait for each to finish.

---

## Step 5 — Re-point the Stripe webhooks

**Developers → Webhooks.** You have two endpoints.

**Edit each one's URL. Do not create new ones.**

| endpoint | new URL |
|---|---|
| subscriptions | `https://api.leadeasygen.com/billing/webhook` |
| wallet | `https://api.leadeasygen.com/billing/webhook/payment` |

> **Why editing matters:** an edited endpoint keeps its **signing secret**. A new
> endpoint gets a *new* secret, which would silently fail every delivery against
> `STRIPE_WEBHOOK_SECRET` until you updated Vercel and redeployed again. Editing
> avoids that entirely.

While you are here, this is the moment to remove the **6 subscription events**
that are wrongly selected on the *wallet* endpoint (`customer.subscription.*`,
`invoice.paid`, `invoice.payment_failed`) — they are currently delivered twice.

---

## Step 6 — Verify, then remove the old entries

### 6a. The webhook registration check does this for you

Now that `PUBLIC_API_URL` is set, the ops endpoint compares what Stripe is
configured to send against what the app consumes:

```bash
curl -s -X POST https://api.leadeasygen.com/internal/cron/purge \
  -H "Authorization: Bearer $CRON_SECRET" | jq '.registration'
```

- `"ok": true` with no `missing` → both endpoints are registered at the new URLs
- `"registered": false` → the URL in Stripe does not match `PUBLIC_API_URL`
- `"skipped"` → `PUBLIC_API_URL` did not take; redeploy

### 6b. Sign in with Google

Use a real browser against `https://leadeasygen.com`. This exercises the whole
chain at once: CORS from the new origin, the OAuth state cookie, the redirect back
through `FRONTEND_URL`, and the session cookie on the new domain.

If it fails, it is almost always `GOOGLE_REDIRECT_URI` not matching the Console
entry exactly.

### 6c. Only now, remove the old entries

Once both pass, go back to **Google Cloud Console** and delete the `vercel.app`
redirect URI and JavaScript origin.

Leaving them costs nothing functionally, but they are two more valid ways into
your auth flow than you need.

---

## Step 7 — Then do Resend

With the domain live, verify `leadeasygen.com` as the Resend sending domain and
move `SMTP_FROM` off the sandbox sender. That closes the last launch blocker, and
doing it now means verifying once rather than twice.

Sending as `@leadeasygen.com` while the product lives at `leadeasygen.com` is also
worth real deliverability — alignment between the From domain and the site is one
of the signals filters actually weigh.

---

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| CORS errors in the browser console | `FRONTEND_URL` still the old value, or API not redeployed | Step 3, then Step 4 |
| Google returns `redirect_uri_mismatch` | Console entry and `GOOGLE_REDIRECT_URI` differ | must match exactly — check trailing slash |
| Sign-in loops back to login | app built with the old `VITE_API_URL` | rebuild the app, not just restart |
| Stripe deliveries show **400** | endpoint was recreated, so the secret changed | update `STRIPE_WEBHOOK_SECRET`, redeploy — or revert to editing |
| `registration.registered: false` | Stripe URL ≠ `PUBLIC_API_URL` | compare both for a trailing slash |
| Domain stuck on *Invalid Configuration* | DNS not propagated | `dig api.leadeasygen.com` and wait |

---

## Rollback

Nothing here is destructive. At any point:

1. Put the old values back in Vercel and redeploy
2. Re-point the Stripe endpoint URLs (the old `vercel.app` URLs still serve)
3. The old Google entries are still there until Step 6c

The `*.vercel.app` domains keep working throughout.

---

## Reference

| | |
|---|---|
| Webhook setup and the local loop | [STRIPE-WEBHOOKS.md](./STRIPE-WEBHOOKS.md) |
| Status and priorities | [ROADMAP.md](./ROADMAP.md) |
| CORS origin + OAuth redirect target | `src/fonderie.ts:64`, `src/auth/googleWeb.ts:148` |
| `GOOGLE_REDIRECT_URI` boot validation | `src/fonderie.ts:218` |
| Registration check | `src/fonderie.ts:517` |
