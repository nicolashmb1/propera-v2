#!/usr/bin/env bash
# Deploy propera-v2 to Cloud Run — STAGING service only.
# Does NOT change Vercel, Telegram, or Twilio webhook URLs.
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project propera-live
#   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
#
# Secrets: create in Secret Manager first (see docs/CLOUD_RUN_DEPLOY.md), then bind below.

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-propera-live}"
REGION="${GCP_REGION:-us-east1}"
SERVICE="${CLOUD_RUN_SERVICE:-propera-v2-staging}"
IMAGE="${ARTIFACT_IMAGE:-${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/propera-v2-staging:latest}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CLOUD_RUN_FEATURE_FLAGS="NODE_ENV=production,PROPERA_TZ=America/New_York,CORE_ENABLED=1,PROPERA_ACCESS_ENGINE_ENABLED=1,PROPERA_TURNOVER_ENGINE_ENABLED=1,PROPERA_UNIT_LIFECYCLE_ENABLED=1,PROPERA_LEASING_ENGINE_ENABLED=1,PROPERA_FINANCE_ENABLED=1,PROPERA_FINANCE_TICKET_COSTS_ENABLED=1,PROPERA_FINANCE_LEDGER_ENABLED=1,PROPERA_FINANCE_COST_CAPTURE_CHAT=1,PROPERA_FINANCIAL_CAPTURE_ENABLED=1,PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1,PROPERA_COMMUNICATION_ENGINE_ENABLED=1,PROPERA_CONFLICT_MEDIATION_ENABLED=1,TENANT_AGENT_ENABLED=1,JARVIS_ASK_ENABLED=1,JARVIS_PLAN_ENABLED=1,JARVIS_THREAD_ENABLED=1,JARVIS_ASK_LLM_ENABLED=1,JARVIS_VOICE_ENABLED=1,PROPERA_TENANT_I18N_ENABLED=1"

echo "==> Build image: ${IMAGE}"
gcloud builds submit \
  --project="${PROJECT_ID}" \
  --tag="${IMAGE}" \
  .

echo "==> Deploy ${SERVICE} (${REGION})"
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE}" \
  --platform=managed \
  --port=8080 \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300 \
  --set-env-vars="${CLOUD_RUN_FEATURE_FLAGS}" \
  --set-secrets="SUPABASE_URL=propera-v2-staging-supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=propera-v2-staging-supabase-service-role:latest,PROPERA_PORTAL_TOKEN=propera-v2-staging-portal-token:latest"

echo "==> Service URL:"
gcloud run services describe "${SERVICE}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(status.url)'

echo "==> Health check (replace URL if needed):"
echo "  curl \"\$(gcloud run services describe ${SERVICE} --project=${PROJECT_ID} --region=${REGION} --format='value(status.url)')/health\""
