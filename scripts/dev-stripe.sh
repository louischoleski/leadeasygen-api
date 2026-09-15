#!/usr/bin/env bash
# Run the webhook stack locally so testing Stripe does not require a deploy.
#
# The Stripe CLI forwards real events from your account to localhost, so the
# loop is seconds instead of push → build → deploy. Everything else is identical
# to production: the same signature verification, the same handlers, the same
# database. Only the URL differs.
#
#   scripts/dev-stripe.sh up       # start API + both forwards
#   scripts/stripe-sweep.sh        # fire every event we consume
#   scripts/dev-stripe.sh down     # stop
#
# .env is never modified. The app reads the CLI's signing secret from inline
# environment variables, which win because dotenv does not overwrite an entry
# that already exists in process.env. Your production secrets stay untouched and
# unused locally — which is correct, since a dashboard endpoint's secret could
# never verify a CLI-forwarded signature anyway.
set -uo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="${LOG_DIR:-/tmp/leadeasygen-stripe}"
API_PORT="${API_PORT:-3000}"

# Each endpoint receives only the events it owns, mirroring the two separate
# Stripe dashboard endpoints. Without the filters a single `stripe listen` would
# forward everything to both, and checkout.session.completed would be processed
# twice.
SUB_EVENTS=customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.trial_will_end,invoice.paid,invoice.payment_failed
PAY_EVENTS=checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,payment_intent.succeeded,payment_intent.payment_failed,charge.refunded,charge.dispute.created,charge.dispute.closed

die() { echo "error: $*" >&2; exit 1; }

preflight() {
	command -v stripe >/dev/null || die "Stripe CLI not installed — https://stripe.com/docs/stripe-cli"
	[ -f .env ] || die "no .env in $(pwd)"

	# REFUSE to run against live keys. This script fires real API calls —
	# creating subscriptions, charges and disputes. Against a live key that is
	# real money and real records, and `stripe trigger` gives no second chance.
	local mode
	mode=$(grep -E '^STRIPE_SECRET_KEY=' .env | cut -d= -f2- | sed 's/#.*//' | tr -d '"'"'"'[:space:]' | cut -c1-8)
	case "$mode" in
		sk_test_|rk_test_) : ;;
		sk_live_|rk_live_) die "STRIPE_SECRET_KEY is a LIVE key. Refusing — this script creates real charges." ;;
		*) die "STRIPE_SECRET_KEY is missing or unrecognised" ;;
	esac

	# Postgres: the dev database usually lives on the remote Docker host, so a
	# closed port here normally means the SSH tunnel is down rather than the
	# database being unhealthy.
	local url; url=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '[:space:]')
	[ -n "$url" ] || die "DATABASE_URL is not set"
	node -e "
		const pg=require('pg');
		new pg.Client({connectionString:process.argv[1]}).connect()
			.then(c=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
	" "$url" 2>/dev/null || die "cannot reach Postgres — is the tunnel up?  ssh -f -N -L 5432:localhost:5432 scylla"
}

up() {
	preflight
	mkdir -p "$LOG_DIR"

	# One CLI secret serves BOTH endpoints locally — unlike production, where the
	# two dashboard endpoints have distinct secrets. Written to a 600 file rather
	# than echoed, so it never lands in scrollback or shell history.
	stripe listen --print-secret 2>/dev/null | tr -d '[:space:]' > "$LOG_DIR/whsec"
	chmod 600 "$LOG_DIR/whsec"
	grep -q '^whsec_' "$LOG_DIR/whsec" || die "could not get a signing secret — run 'stripe login' first"
	local secret; secret=$(cat "$LOG_DIR/whsec")

	npm run -s migrate >"$LOG_DIR/migrate.log" 2>&1 || { tail -20 "$LOG_DIR/migrate.log"; die "migrations failed"; }
	echo "migrations ok"

	STRIPE_WEBHOOK_SECRET="$secret" STRIPE_WALLET_WEBHOOK_SECRET="$secret" \
		nohup npm run -s dev:api >"$LOG_DIR/api.log" 2>&1 &
	echo $! > "$LOG_DIR/api.pid"

	for i in $(seq 1 30); do
		curl -sf -o /dev/null "http://localhost:$API_PORT/health" && break
		sleep 1
	done
	curl -sf -o /dev/null "http://localhost:$API_PORT/health" \
		|| { tail -20 "$LOG_DIR/api.log"; die "API did not become healthy"; }
	echo "api    ready on :$API_PORT"

	nohup stripe listen --events "$SUB_EVENTS" \
		--forward-to "localhost:$API_PORT/billing/webhook"         >"$LOG_DIR/listen-sub.log" 2>&1 &
	echo $! > "$LOG_DIR/listen-sub.pid"
	nohup stripe listen --events "$PAY_EVENTS" \
		--forward-to "localhost:$API_PORT/billing/webhook/payment" >"$LOG_DIR/listen-pay.log" 2>&1 &
	echo $! > "$LOG_DIR/listen-pay.pid"
	sleep 6
	echo "forwards ready  →  $LOG_DIR/listen-{sub,pay}.log"
	echo
	echo "next: scripts/stripe-sweep.sh"
}

down() {
	for p in api listen-sub listen-pay; do
		if [ -f "$LOG_DIR/$p.pid" ]; then
			pkill -P "$(cat "$LOG_DIR/$p.pid")" 2>/dev/null
			kill "$(cat "$LOG_DIR/$p.pid")" 2>/dev/null
			rm -f "$LOG_DIR/$p.pid"
			echo "stopped $p"
		fi
	done
	# The API is started through npm, so the tsx child can outlive its parent.
	pkill -f "tsx watch src/index.ts" 2>/dev/null && echo "stopped tsx"
	rm -f "$LOG_DIR/whsec"
}

status() {
	curl -sf -o /dev/null "http://localhost:$API_PORT/health" \
		&& echo "api      up (:$API_PORT)" || echo "api      down"
	echo "forwards $(pgrep -fc 'stripe listen' 2>/dev/null || echo 0) running"
}

case "${1:-up}" in
	up) up ;;
	down) down ;;
	status) status ;;
	restart) down; sleep 2; up ;;
	*) echo "usage: $0 {up|down|status|restart}"; exit 1 ;;
esac
