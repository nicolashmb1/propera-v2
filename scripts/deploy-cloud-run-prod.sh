#!/usr/bin/env bash
# Deploy propera-v2 to Cloud Run — PRODUCTION service (propera-v2-prod).
# Same container/code as staging; separate Secret Manager bindings.
#
# Does NOT change Vercel, Telegram, Twilio webhooks, or GitHub cron.
# Complete docs/CLOUD_RUN_PROD_CHECKLIST.md before running.
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project propera-live
#   Prod secrets created (see docs/CLOUD_RUN_PROD_CHECKLIST.md)

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-propera-live}"
REGION="${GCP_REGION:-us-east1}"
SERVICE="${CLOUD_RUN_SERVICE:-propera-v2-prod}"
IMAGE="${ARTIFACT_IMAGE:-${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/propera-v2-prod:latest}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Plain env flags — full list in config/cloud-run-prod.plain.env (sync with npm run cloud-run:sync-prod-env).
ENV_VARS_FILE="${ROOT}/config/cloud-run-prod.plain.env"

echo "==> PRODUCTION deploy: ${SERVICE} (project ${PROJECT_ID}, region ${REGION})"
echo "    Press Ctrl+C within 5s to abort..."
sleep 5

echo "==> Build image: ${IMAGE}"
gcloud builds submit \
  --project="${PROJECT_ID}" \
  --tag="${IMAGE}" \
  .

echo "==> Deploy ${SERVICE}"
SECRETS_ARG=""
while IFS= read -r line || [[ -n "$line" ]]; do
  line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -z "$line" || "$line" == \#* ]] && continue
  env_name="${line%%=*}"
  secret_name="${line#*=}"
  env_name="$(echo "$env_name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  secret_name="$(echo "$secret_name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [[ -z "$env_name" || -z "$secret_name" ]] && continue
  if [[ -n "$SECRETS_ARG" ]]; then SECRETS_ARG+=","; fi
  SECRETS_ARG+="${env_name}=${secret_name}:latest"
done < "${ROOT}/config/cloud-run-prod.secrets.bindings"

if [[ -z "$SECRETS_ARG" ]]; then
  echo "ERROR: no secret bindings in config/cloud-run-prod.secrets.bindings" >&2
  exit 1
fi

gcloud run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --platform=managed \
  --port=8080 \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=10 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300 \
  --env-vars-file="${ENV_VARS_FILE}" \
  --set-secrets="${SECRETS_ARG}"

echo ""
echo "Tip: if secret VALUES changed, run: npm run cloud-run:sync-prod-secrets"

PROD_URL="$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(status.url)')"

echo ""
echo "==> Production URL: ${PROD_URL}"
echo "==> Health:"
echo "  curl \"${PROD_URL}/health\""
echo ""
echo "Next: verify read-only portal route (see docs/CLOUD_RUN_PROD_CHECKLIST.md)."
echo "Do NOT point Vercel / Twilio / Telegram / GitHub cron here until cutover."
