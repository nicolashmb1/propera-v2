# Deploy propera-v2 to Cloud Run — STAGING (propera-v2-staging).
# Windows equivalent of deploy-cloud-run-staging.sh (no bash required).
#
# Usage (from propera-v2):
#   npm run cloud-run:deploy-staging

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

$ProjectId = if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "propera-live" }
$Region = if ($env:GCP_REGION) { $env:GCP_REGION } else { "us-east1" }
$Service = if ($env:CLOUD_RUN_SERVICE) { $env:CLOUD_RUN_SERVICE } else { "propera-v2-staging" }
$Image = if ($env:ARTIFACT_IMAGE) {
    $env:ARTIFACT_IMAGE
} else {
    "${Region}-docker.pkg.dev/${ProjectId}/cloud-run-source-deploy/propera-v2-staging:latest"
}

$gcloud = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not (Test-Path $gcloud)) { $gcloud = "gcloud" }

$featureFlags = @(
    "NODE_ENV=production"
    "PROPERA_TZ=America/New_York"
    "CORE_ENABLED=1"
    "PROPERA_ACCESS_ENGINE_ENABLED=1"
    "PROPERA_TURNOVER_ENGINE_ENABLED=1"
    "PROPERA_UNIT_LIFECYCLE_ENABLED=1"
    "PROPERA_LEASING_ENGINE_ENABLED=1"
    "PROPERA_FINANCE_ENABLED=1"
    "PROPERA_FINANCE_TICKET_COSTS_ENABLED=1"
    "PROPERA_FINANCE_LEDGER_ENABLED=1"
    "PROPERA_FINANCE_COST_CAPTURE_CHAT=1"
    "PROPERA_FINANCIAL_CAPTURE_ENABLED=1"
    "PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1"
    "PROPERA_COMMUNICATION_ENGINE_ENABLED=1"
    "PROPERA_CONFLICT_MEDIATION_ENABLED=1"
    "TENANT_AGENT_ENABLED=1"
    "JARVIS_ASK_ENABLED=1"
    "JARVIS_REASON_ENABLED=1"
    "JARVIS_PLAN_ENABLED=1"
    "JARVIS_THREAD_ENABLED=1"
    "JARVIS_ASK_LLM_ENABLED=1"
    "JARVIS_VOICE_ENABLED=1"
    "PROPERA_TENANT_I18N_ENABLED=1"
) -join ","

Write-Host "==> Build image: $Image"
& $gcloud builds submit --project=$ProjectId --tag=$Image .

Write-Host "==> Deploy $Service ($Region)"
$secrets = @(
    "SUPABASE_URL=propera-v2-staging-supabase-url:latest"
    "SUPABASE_SERVICE_ROLE_KEY=propera-v2-staging-supabase-service-role:latest"
    "PROPERA_PORTAL_TOKEN=propera-v2-staging-portal-token:latest"
) -join ","

& $gcloud run deploy $Service `
    --project=$ProjectId `
    --region=$Region `
    --image=$Image `
    --platform=managed `
    --port=8080 `
    --allow-unauthenticated `
    --min-instances=0 `
    --max-instances=3 `
    --memory=512Mi `
    --cpu=1 `
    --timeout=300 `
    --set-env-vars=$featureFlags `
    --set-secrets=$secrets

$url = & $gcloud run services describe $Service `
    --project=$ProjectId `
    --region=$Region `
    --format="value(status.url)"

Write-Host "==> Service URL: $url"
Write-Host "==> Health: curl `"$url/health`""
