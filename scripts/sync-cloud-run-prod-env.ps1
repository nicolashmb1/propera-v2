# Apply config/cloud-run-prod.plain.env to Cloud Run propera-v2-prod
# Usage (from propera-v2): npm run cloud-run:sync-prod-env

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$EnvFile = Join-Path $Root "config\cloud-run-prod.plain.env"
$Service = if ($env:CLOUD_RUN_SERVICE) { $env:CLOUD_RUN_SERVICE } else { "propera-v2-prod" }
$Project = if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "propera-live" }
$Region = if ($env:GCP_REGION) { $env:GCP_REGION } else { "us-east1" }

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

$pairs = @()
foreach ($k in ($vars.Keys | Sort-Object)) {
    $v = $vars[$k] -replace '\\', '\\\\' -replace ',', '\,'
    $pairs += "${k}=${v}"
}
$arg = $pairs -join ","

Write-Host "==> Sync plain env to $Service ($Project / $Region)"
Write-Host "    $($vars.Count) vars from $EnvFile"

& $gcloud run services update $Service `
    --project=$Project `
    --region=$Region `
    --update-env-vars=$arg

Write-Host "==> Done."
