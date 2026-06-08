# Sync secrets from config/cloud-run-prod.secrets.local.env to Secret Manager + Cloud Run.
# Usage: npm run cloud-run:sync-prod-secrets

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$ValuesFile = Join-Path $Root "config\cloud-run-prod.secrets.local.env"
$BindingsFile = Join-Path $Root "config\cloud-run-prod.secrets.bindings"
$Service = if ($env:CLOUD_RUN_SERVICE) { $env:CLOUD_RUN_SERVICE } else { "propera-v2-prod" }
$Project = if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "propera-live" }
$Region = if ($env:GCP_REGION) { $env:GCP_REGION } else { "us-east1" }

if (-not (Test-Path $ValuesFile)) {
    Write-Host ""
    Write-Host "Missing $ValuesFile"
    Write-Host "  Copy-Item config\cloud-run-prod.secrets.local.env.example config\cloud-run-prod.secrets.local.env"
    Write-Host "  Paste values from propera-v2\.env, then run again."
    Write-Host ""
    exit 1
}

$gcloud = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not (Test-Path $gcloud)) { $gcloud = "gcloud" }

function Read-EnvFile([string]$Path) {
    $map = @{}
    Get-Content $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { return }
        $k = $line.Substring(0, $idx).Trim()
        $v = $line.Substring($idx + 1).Trim()
        if ($v.StartsWith('"') -and $v.EndsWith('"')) { $v = $v.Substring(1, $v.Length - 2) }
        if ($v -ne "") { $map[$k] = $v }
    }
    return $map
}

$values = Read-EnvFile $ValuesFile
$bindings = Read-EnvFile $BindingsFile
if ($bindings.Count -eq 0) { Write-Error "No bindings in $BindingsFile" }

$projectNumber = & $gcloud projects describe $Project --format="value(projectNumber)"
$runSa = "$projectNumber-compute@developer.gserviceaccount.com"

$updateSecrets = @()

foreach ($envName in $bindings.Keys) {
    $secretName = $bindings[$envName]
    if (-not $values.ContainsKey($envName)) {
        Write-Host "Skip (no value in local file): $envName"
        continue
    }
    $val = $values[$envName]

    cmd /c "`"$gcloud`" secrets describe $secretName --project=$Project >nul 2>&1"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Create secret: $secretName"
        & $gcloud secrets create $secretName --project=$Project --replication-policy=automatic | Out-Null
        & $gcloud secrets add-iam-policy-binding $secretName `
            --project=$Project `
            --member="serviceAccount:$runSa" `
            --role="roles/secretmanager.secretAccessor" | Out-Null
    }

    Write-Host "New version: $secretName ($envName)"
    $tmp = Join-Path $env:TEMP "propera-secret-$secretName.txt"
    [System.IO.File]::WriteAllText($tmp, $val)
    & $gcloud secrets versions add $secretName --project=$Project --data-file=$tmp
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    $updateSecrets += "${envName}=${secretName}:latest"
}

if ($updateSecrets.Count -eq 0) {
    Write-Host "No non-empty values in $ValuesFile - nothing to sync."
    exit 0
}

$secretArg = $updateSecrets -join ","
Write-Host "==> Mount on $Service : $($updateSecrets.Count) secret(s)"
& $gcloud run services update $Service `
    --project=$Project `
    --region=$Region `
    --update-secrets=$secretArg

Write-Host "==> Done."
