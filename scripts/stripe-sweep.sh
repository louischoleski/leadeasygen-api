#!/usr/bin/env bash
# Fire every webhook event this app consumes at a LOCAL API and report what each
# endpoint actually returned.
#
# Why local: the Stripe CLI forwards real events to localhost, so the loop is
# seconds instead of a deploy. Same signature verification, same handlers, same
# database — the only thing that differs from production is the URL.
#
# Usage:
#   scripts/dev-stripe.sh up      # start API + both forwards (do this first)
#   scripts/stripe-sweep.sh       # then this
#
# A PASS here means the endpoint verified the signature and the handler ran to
# completion. It does NOT mean state changed: most CLI fixtures reference Stripe
# objects that have no counterpart in this database, so the honest outcome is a
# 200 carrying `ignored`. That is success — see docs/STRIPE-WEBHOOKS.md.
set -uo pipefail

LOG_DIR="${LOG_DIR:-/tmp/leadeasygen-stripe}"
SUB_LOG="$LOG_DIR/listen-sub.log"
PAY_LOG="$LOG_DIR/listen-pay.log"

SUB_EVENTS=(
	customer.subscription.created
	customer.subscription.updated
	customer.subscription.deleted
	customer.subscription.trial_will_end
	invoice.paid
	invoice.payment_failed
)
PAY_EVENTS=(
	checkout.session.completed
	checkout.session.async_payment_succeeded
	checkout.session.async_payment_failed
	payment_intent.succeeded
	payment_intent.payment_failed
	charge.refunded
	charge.dispute.created
	charge.dispute.closed
)

for f in "$SUB_LOG" "$PAY_LOG"; do
	[ -f "$f" ] || { echo "missing $f — run scripts/dev-stripe.sh up first"; exit 1; }
done

# Mark where this run starts, so a previous sweep's lines are never counted.
START_SUB=$(wc -l < "$SUB_LOG")
START_PAY=$(wc -l < "$PAY_LOG")

echo "Triggering ${#SUB_EVENTS[@]} subscription + ${#PAY_EVENTS[@]} payment events…"
echo

for e in "${SUB_EVENTS[@]}" "${PAY_EVENTS[@]}"; do
	printf '  %-45s' "$e"
	if stripe trigger "$e" >/dev/null 2>&1; then echo "sent"; else echo "TRIGGER FAILED"; fi
done

echo
echo "Waiting for deliveries to settle…"
sleep 12

# One fixture fans out into several events (triggering a subscription update also
# emits invoice.paid and subscription.created). Report on everything that
# arrived, keyed by event id → type → status, rather than assuming 1:1.
report() {
	local log="$1" start="$2" label="$3"
	echo
	echo "── $label ──"
	local body
	body=$(tail -n "+$((start + 1))" "$log")
	# --> TYPE [evt_x]  pairs with  <-- [STATUS] POST url [evt_x]
	awk '
		/-->/  { for (i=1;i<=NF;i++) if ($i ~ /^\[evt_/) { id=$i; gsub(/[\[\]]/,"",id); type[id]=$(i-1) } }
		/<--/  { st=""; for (i=1;i<=NF;i++) { if ($i ~ /^\[[0-9]+\]$/) { st=$i; gsub(/[\[\]]/,"",st) }
		         if ($i ~ /^\[evt_/) { id=$i; gsub(/[\[\]]/,"",id); status[id]=st } } }
		END {
			bad=0; n=0
			for (id in status) {
				t = (id in type) ? type[id] : "(unknown)"
				printf "  %-6s %s\n", status[id], t
				n++
				if (status[id] !~ /^2/) bad++
			}
			if (n == 0) print "  (no deliveries recorded)"
			printf "\n  %d delivered, %d non-2xx\n", n, bad
		}
	' <<< "$body" | sort -k2
}

report "$SUB_LOG" "$START_SUB" "/billing/webhook  (subscriptions)"
report "$PAY_LOG" "$START_PAY" "/billing/webhook/payment  (wallet)"

echo
echo "Any non-2xx above is a real failure. A 2xx carrying \`ignored\` is success:"
echo "the signature verified and the handler declined an event that references a"
echo "Stripe object with no counterpart in this database."
