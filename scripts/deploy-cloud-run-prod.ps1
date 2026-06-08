# Deploy propera-v2 to Cloud Run — PRODUCTION (propera-v2-prod).
# Windows equivalent of deploy-cloud-run-prod.sh (no bash required).
#
# Usage (from propera-v2):
#   npm run cloud-run:deploy-prod
#   # or: powershell -ExecutionPolicy Bypass -File scripts/deploy-cloud-run-prod.ps1
#
# Prerequisites: gcloud auth login; gcloud config set project propera-live
# See docs/CLOUD_RUN_PROD_CHECKLIST.md before first prod deploy.

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

$ProjectId = if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "propera-live" }
$Region = if ($env:GCP_REGION) { $env:GCP_REGION } else { "us-east1" }
$Service = if ($env:CLOUD_RUN_SERVICE) { $env:CLOUD_RUN_SERVICE } else { "propera-v2-prod" }
$Image = if ($env:ARTIFACT_IMAGE) {
    $env:ARTIFACT_IMAGE
} else {
    "${Region}-docker.pkg.dev/${ProjectId}/cloud-run-source-deploy/propera-v2-prod:latest"
}

$EnvFile = Join-Path $Root "config\cloud-run-prod.plain.env"
if (-not (Test-Path $EnvFile)) {
    Write-Error "Missing $EnvFile"
}

$gcloud = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not (Test-Path $gcloud)) { $gcloud = "gcloud" }

function Read-PlainEnv([string]$Path) {
    $map = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { return }
        $k = $line.Substring(0, $idx).Trim()
        $v = $line.Substring($idx + 1).Trim()
        if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
        if ($v -eq "") {
            Write-Host "  Skip empty: $k"
            return
        }
        $map[$k] = $v
    }
    return $map
}

$vars = Read-PlainEnv $EnvFile
if ($vars.Count -eq 0) { Write-Error "No vars in $EnvFile" }

$cleanEnvPath = Join-Path $env:TEMP "propera-v2-prod-env-$([Guid]::NewGuid().ToString('N')).env"
try {
    $lines = foreach ($k in ($vars.Keys | Sort-Object)) { "$k=$($vars[$k])" }
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines($cleanEnvPath, $lines, $utf8NoBom)

    Write-Host "==> PRODUCTION deploy: $Service (project $ProjectId, region $Region)"
    Write-Host "    Press Ctrl+C within 5s to abort..."
    Start-Sleep -Seconds 5

    Write-Host "==> Build image: $Image"
    & $gcloud builds submit --project=$ProjectId --tag=$Image .

    Write-Host "==> Deploy $Service"
    $secretsArg = & (Join-Path $PSScriptRoot "cloud-run-prod-secrets-arg.ps1") -Root $Root
    Write-Host "    Mounting $($secretsArg.Split(',').Count) secrets from config/cloud-run-prod.secrets.bindings"

    & $gcloud run deploy $Service `
        --project=$ProjectId `
        --region=$Region `
        --image=$Image `
        --platform=managed `
        --port=8080 `
        --allow-unauthenticated `
        --min-instances=0 `
        --max-instances=10 `
        --memory=512Mi `
        --cpu=1 `
        --timeout=300 `
        --env-vars-file=$cleanEnvPath `
        --set-secrets=$secretsArg

    Write-Host ""
    Write-Host "==> Tip: if secret VALUES changed, run: npm run cloud-run:sync-prod-secrets"

    $prodUrl = & $gcloud run services describe $Service `
        --project=$ProjectId `
        --region=$Region `
        --format="value(status.url)"

    Write-Host ""
    Write-Host "==> Production URL: $prodUrl"
    Write-Host "==> Health:"
    Write-Host "  curl `"$prodUrl/health`""
    Write-Host ""
    Write-Host "Next: verify read-only portal route (see docs/CLOUD_RUN_PROD_CHECKLIST.md)."
}
finally {
    if (Test-Path $cleanEnvPath) { Remove-Item -Force $cleanEnvPath -ErrorAction SilentlyContinue }
}
