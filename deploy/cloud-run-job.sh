#!/usr/bin/env bash
#
# Deploy the scrape worker as a Cloud Run Job.
#
# WHY A JOB AND NOT A SERVICE: the worker is not a server. It wakes, drains the
# queue, and exits — which is exactly what a Job is, and what `WORKER_ONCE=1`
# makes the container do. A Service would have to be kept warm or woken by an
# HTTP request it has no reason to serve.
#
# WHY CLOUD BUILD AND NOT A LOCAL `docker build`: the image is built from the
# Playwright base, which is >2GB unpacked. Building it locally needs that much
# free disk and an amd64 host. Cloud Build has both and the build never touches
# your machine.
#
# COST at LeadEasyGen's current volume: nothing. Cloud Run's free tier is ~180k
# vCPU-seconds/month; a scrape is tens of seconds and the queue is usually
# empty, so a 5-minute schedule that mostly exits immediately stays well inside
# it. Cloud Scheduler allows 3 free jobs.
#
# Run it after `gcloud auth login` and `gcloud config set project <id>`.
# Safe to re-run: every step is create-or-update.
#
# NOTE on a Free Trial account: GCP STOPS your resources when the trial ends,
# even if the always-free tier would otherwise cover them. Activating the full
# account does not start charging — it just lets the free tier keep applying.
# Do it before the trial expires, or scraping stops on that date.
set -euo pipefail

# Defaults to whatever `gcloud config set project` selected; override with
# PROJECT=... if you work across several.
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
# Montreal — same region as the Supabase database (ca-central-1) and the users.
# Every cross-region hop is added latency on a job that already takes minutes.
REGION="${REGION:-northamerica-northeast1}"
REPO="${REPO:-leadeasygen}"
JOB="${JOB:-scrape-worker}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${JOB}"
# How often to look for queued work. This IS the pickup latency — the API does
# not trigger the job, deliberately: doing so needs a credential crossing from
# Vercel into GCP, and it buys seconds on a job that already takes tens of them.
#
# Every minute runs ~43,200 times a month. At 2 vCPU and a ~6s empty run that
# is ~518k vCPU-seconds against a free tier of ~180k — roughly $2.40/mo.
# Deliberate: pickup latency is worth more than the change. */5 is the only
# interval fully inside the free tier.
#
# Overlapping executions are EXPECTED at this interval: a scrape takes minutes,
# so a new job starts while the last is still working. That is safe because
# claiming is exclusive (FOR UPDATE ... SKIP LOCKED plus a visibility lease) —
# the second execution cannot take a row the first holds, finds nothing, and
# exits in seconds. If a scrape ever WEDGES, executions stack until
# --task-timeout expires; lower that timeout rather than the schedule.
SCHEDULE="${SCHEDULE:-*/1 * * * *}"

if [[ -z "$PROJECT" ]]; then
	echo "No project set. Run: gcloud config set project <your-project-id>" >&2
	exit 1
fi

echo "project=$PROJECT region=$REGION job=$JOB"

echo "→ enabling the APIs this needs"
gcloud services enable \
	run.googleapis.com \
	cloudbuild.googleapis.com \
	artifactregistry.googleapis.com \
	cloudscheduler.googleapis.com \
	secretmanager.googleapis.com \
	--project "$PROJECT" --quiet

# Enablement is not instant. A build fired the moment `services enable` returns
# fails with PERMISSION_DENIED on a project where Cloud Build has never run.
echo "  waiting for API enablement to propagate"
sleep 30

echo "→ artifact registry"
gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
	gcloud artifacts repositories create "$REPO" \
		--repository-format=docker --location="$REGION" \
		--description="LeadEasyGen images" --project "$PROJECT" --quiet

# The database URL is a SECRET, not an env var on the job: env vars are readable
# by anyone with view access to the job, and this one is a full credential.
echo "→ secret"
if ! gcloud secrets describe leadeasygen-database-url --project "$PROJECT" >/dev/null 2>&1; then
	if [[ -z "${DATABASE_URL:-}" ]]; then
		echo "Create the secret first, without putting it in shell history:" >&2
		echo "  gcloud secrets create leadeasygen-database-url --data-file=- --project $PROJECT" >&2
		echo "  (then paste the URL and press Ctrl-D)" >&2
		exit 1
	fi
	printf '%s' "$DATABASE_URL" | gcloud secrets create leadeasygen-database-url \
		--data-file=- --project "$PROJECT" --quiet
fi

# The job RUNS as this service account too, and reading the mounted secret is a
# separate permission from building the image. Granted on the SECRET rather than
# the project: this account should be able to read this one credential, not
# every secret the project will ever hold.
echo "→ secret access for the runtime service account"
RUNTIME_SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding leadeasygen-database-url \
	--member "serviceAccount:${RUNTIME_SA}" \
	--role roles/secretmanager.secretAccessor \
	--project "$PROJECT" --quiet >/dev/null

# Projects created since mid-2024 do not get the legacy Cloud Build service
# account, and builds run as the Compute Engine default SA instead — which does
# not carry the build and push roles by default. Granting them is idempotent.
echo "→ cloud build permissions"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for ROLE in roles/cloudbuild.builds.builder roles/artifactregistry.writer roles/logging.logWriter; do
	gcloud projects add-iam-policy-binding "$PROJECT" \
		--member "serviceAccount:${BUILD_SA}" --role "$ROLE" \
		--condition=None --quiet >/dev/null
done

# Built in the GLOBAL Cloud Build, deliberately. Regional Cloud Build needs a
# worker pool and bucket that a new project has not provisioned, and fails with
# PERMISSION_DENIED that reads like an account problem. The image still lands in
# the regional Artifact Registry — only the builder location differs.
echo "→ build (remote — nothing is built on this machine)"
gcloud builds submit --tag "$IMAGE" --project "$PROJECT" .

# WORKER_ONCE=1 is what makes this terminate. Without it the container polls
# forever, the Job never completes, and Cloud Run kills it at the task timeout —
# recording a failure for work that succeeded.
COMMON=(
	--image "$IMAGE"
	--region "$REGION"
	--project "$PROJECT"
	--set-env-vars "WORKER_ONCE=1,NODE_ENV=production"
	--set-secrets "DATABASE_URL=leadeasygen-database-url:latest"
	# Chromium needs the memory; at 512Mi the renderer is killed mid-scrape and
	# the task is left in 'scraping' rather than failing cleanly.
	--memory 2Gi
	--cpu 2
	# Long enough for a real scrape, short enough that a wedged run is noticed.
	--task-timeout 900s
	# The queue is durable and claiming is exclusive, so a failed run loses
	# nothing — the next scheduled run picks the same rows up.
	--max-retries 1
)

echo "→ job"
if gcloud run jobs describe "$JOB" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
	gcloud run jobs update "$JOB" "${COMMON[@]}" --quiet
else
	gcloud run jobs create "$JOB" "${COMMON[@]}" --quiet
fi

echo "→ schedule"
SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run"
if gcloud scheduler jobs describe "${JOB}-schedule" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
	gcloud scheduler jobs update http "${JOB}-schedule" \
		--location "$REGION" --project "$PROJECT" --schedule "$SCHEDULE" \
		--uri "$URI" --http-method POST \
		--oauth-service-account-email "$SA" --quiet
else
	gcloud scheduler jobs create http "${JOB}-schedule" \
		--location "$REGION" --project "$PROJECT" --schedule "$SCHEDULE" \
		--uri "$URI" --http-method POST \
		--oauth-service-account-email "$SA" --quiet
fi

echo
echo "done. run it now instead of waiting for the schedule:"
echo "  gcloud run jobs execute $JOB --region $REGION --project $PROJECT --wait"
echo "logs:"
echo "  gcloud run jobs executions list --job $JOB --region $REGION --project $PROJECT"
