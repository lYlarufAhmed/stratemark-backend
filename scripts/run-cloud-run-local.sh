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

# --secrets only accepts Secret Manager references (NAME:VERSION), not literal
# .env values. Supply ordinary local variables through a temporary service YAML.
service_config=".stratemark.local.service.dev.yaml"
cleanup() {
  rm -f "$service_config"
}
trap cleanup EXIT

yaml_quote() {
  local value=${1-}
  value=${value//\'/\'\'}
  printf "'%s'" "$value"
}

cat > "$service_config" <<EOF
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: stratemark-backend-local
spec:
  template:
    spec:
      containers:
      - env:
        - name: GCP_PROJECT_ID
          value: $(yaml_quote "${GCP_PROJECT_ID:-geminixprize-504607}")
        - name: GCP_LOCATION
          value: $(yaml_quote "${GCP_LOCATION:-us-central1}")
        - name: GEMINI_API_KEY
          value: $(yaml_quote "$GEMINI_API_KEY")
        - name: GEMINI_MODEL
          value: $(yaml_quote "${GEMINI_MODEL:-gemini-flash-latest}")
        - name: RESEND_API_KEY
          value: $(yaml_quote "${RESEND_API_KEY:-}")
        - name: RESEND_FROM_EMAIL
          value: $(yaml_quote "${RESEND_FROM_EMAIL:-alerts@stratemark.io}")
        - name: STRIPE_SECRET_KEY
          value: $(yaml_quote "${STRIPE_SECRET_KEY:-}")
        - name: STRIPE_WEBHOOK_SECRET
          value: $(yaml_quote "${STRIPE_WEBHOOK_SECRET:-}")
        - name: APP_URL
          value: $(yaml_quote "${APP_URL:-http://localhost:8080}")
        - name: SCRAPE_INTERVAL_HOURS
          value: $(yaml_quote "${SCRAPE_INTERVAL_HOURS:-6}")
        - name: PORT
          value: '8080'
EOF

gcloud beta code dev \
  --dockerfile=Dockerfile \
  --local-port="${LOCAL_PORT:-8080}" \
  --application-default-credential \
  "$service_config"
status=$?
cleanup
exit "$status"
