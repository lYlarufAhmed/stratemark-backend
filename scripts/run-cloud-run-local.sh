#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  printf '%s\n' 'Missing .env. Create it from .env.example before starting Cloud Run locally.' >&2
  exit 1
fi

# Export local variables for the emulator process without copying .env into the image.
set -a
# shellcheck disable=SC1091
source ./.env
set +a

: "${GEMINI_API_KEY:?GEMINI_API_KEY is missing from .env}"

exec gcloud beta code dev \
  --dockerfile=Dockerfile \
  --local-port="${LOCAL_PORT:-8080}" \
  --application-default-credential \
  --secrets="GCP_PROJECT_ID=${GCP_PROJECT_ID:-geminixprize-504607},GCP_LOCATION=${GCP_LOCATION:-us-central1},GEMINI_API_KEY=${GEMINI_API_KEY},GEMINI_MODEL=${GEMINI_MODEL:-gemini-flash-latest},RESEND_API_KEY=${RESEND_API_KEY:-},RESEND_FROM_EMAIL=${RESEND_FROM_EMAIL:-alerts@stratemark.io},STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY:-},STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET:-},APP_URL=${APP_URL:-http://localhost:8080},SCRAPE_INTERVAL_HOURS=${SCRAPE_INTERVAL_HOURS:-6},PORT=8080"
