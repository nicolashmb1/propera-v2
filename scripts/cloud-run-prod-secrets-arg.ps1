# Build --set-secrets / --update-secrets arg from config/cloud-run-prod.secrets.bindings
# Returns comma-separated ENV=secret-name:latest for bindings whose Secret Manager entry exists.

param(
    [string]$Root = (Split-Path $PSScriptRoot -Parent)
)

$BindingsFile = Join-Path $Root "config\cloud-run-prod.secrets.bindings"
if (-not (Test-Path $BindingsFile)) {
    Write-Error "Missing $BindingsFile"
}

$ProjectId = if ($env:GCP_PROJECT_ID) { $env:GCP_PROJECT_ID } else { "propera-live" }
$gcloud = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not (Test-Path $gcloud)) { $gcloud = "gcloud" }

function Test-SecretExists([string]$SecretName) {
    cmd /c "`"$gcloud`" secrets describe $SecretName --project=$ProjectId >nul 2>&1"
    return $LASTEXITCODE -eq 0
}

$pairs = @()
$skipped = @()
Get-Content $BindingsFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $envName = $line.Substring(0, $idx).Trim()
    $secretName = $line.Substring($idx + 1).Trim()
    if (-not $envName -or -not $secretName) { return }
    if (Test-SecretExists $secretName) {
        $pairs += "${envName}=${secretName}:latest"
    } else {
        $skipped += "${envName} (${secretName})"
    }
}

if ($skipped.Count -gt 0) {
    Write-Host "    Skip $($skipped.Count) secret(s) not in Secret Manager yet:"
    foreach ($s in $skipped) { Write-Host "      - $s" }
}

if ($pairs.Count -eq 0) {
    Write-Error "No secret bindings in $BindingsFile (or none exist in Secret Manager yet)"
}

return ($pairs -join ",")
