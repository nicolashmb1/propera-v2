# Copy propera-v2/.env -> Cloud Run prod (plain flags + Secret Manager).
# Usage: npm run cloud-run:bootstrap-from-local-env

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$LocalEnv = Join-Path $Root ".env"
$PlainFile = Join-Path $Root "config\cloud-run-prod.plain.env"
$SecretsFile = Join-Path $Root "config\cloud-run-prod.secrets.local.env"
$BindingsFile = Join-Path $Root "config\cloud-run-prod.secrets.bindings"
$ProdUrl = "https://propera-v2-prod-438117417981.us-east1.run.app"

if (-not (Test-Path $LocalEnv)) {
    Write-Error "Missing $LocalEnv"
}

function Read-EnvFile([string]$Path) {
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
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

$local = Read-EnvFile $LocalEnv
$bindings = Read-EnvFile $BindingsFile

# --- secrets.local.env from .env ---
$secretLines = @(
    "# Auto-generated from propera-v2/.env at $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
    "# npm run cloud-run:sync-prod-secrets",
    ""
)
foreach ($envName in ($bindings.Keys | Sort-Object)) {
    if ($local.ContainsKey($envName)) {
        $secretLines += "${envName}=$($local[$envName])"
    }
}
Set-Content -Path $SecretsFile -Value ($secretLines -join "`r`n") -Encoding UTF8
Write-Host "Wrote secrets file: $SecretsFile ($($secretLines.Count - 3) keys)"

# --- merge a few plain overrides from .env ---
$plainOverrides = @{}
$plainKeys = @(
    "PROPERA_TZ", "PROPERA_DEFAULT_ORG_ID", "COMM_ORG_ID", "DEV_ORG_SUBDOMAIN",
    "PROPERA_JARVIS_SETTINGS_ADMIN_EMAILS", "PROPERA_VOICE_SPEAKING_STYLE",
    "PROPERA_VOICE_AGENT_NAME", "TWILIO_BROADCAST_FROM", "TWILIO_SMS_FROM",
    "COMM_MAIN_NUMBER_DISPLAY", "COMM_REPLY_WINDOW_HOURS"
)
foreach ($k in $plainKeys) {
    if ($local.ContainsKey($k)) { $plainOverrides[$k] = $local[$k] }
}
$plainOverrides["NODE_ENV"] = "production"
$plainOverrides["PROPERA_PUBLIC_BASE_URL"] = $ProdUrl
$plainOverrides["PROPERA_LIFECYCLE_CRON_URL"] = "$ProdUrl/internal/cron/lifecycle-timers"
if ($local.ContainsKey("PROPERA_PORTAL_PUSH_ENABLED")) {
    $plainOverrides["PROPERA_PORTAL_PUSH_ENABLED"] = $local["PROPERA_PORTAL_PUSH_ENABLED"]
} elseif ($local.ContainsKey("PROPERA_POTAL_PUSH_ENABLED")) {
    $plainOverrides["PROPERA_PORTAL_PUSH_ENABLED"] = $local["PROPERA_POTAL_PUSH_ENABLED"]
}
if ($local.ContainsKey("PROPERA_VAPID_SUBJECT")) {
    $plainOverrides["PROPERA_VAPID_SUBJECT"] = $local["PROPERA_VAPID_SUBJECT"]
}

$plainContent = Get-Content $PlainFile -Raw
foreach ($k in $plainOverrides.Keys) {
    $v = $plainOverrides[$k]
    if ($plainContent -match "(?m)^$k=.*") {
        $plainContent = $plainContent -replace "(?m)^$k=.*", "${k}=${v}"
    } else {
        $plainContent += "`r`n${k}=${v}"
    }
}
Set-Content -Path $PlainFile -Value $plainContent.TrimEnd() -Encoding UTF8 -NoNewline
Write-Host "Updated plain env: $PlainFile"

Write-Host ""
Write-Host "==> Sync plain env..."
& (Join-Path $PSScriptRoot "sync-cloud-run-prod-env.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""
Write-Host "==> Sync secrets..."
& (Join-Path $PSScriptRoot "sync-cloud-run-prod-secrets.ps1")
Write-Host ""
Write-Host "Done. Local .env is now on Cloud Run prod (flags + secrets)."
Write-Host "Twilio/Telegram webhooks still hit ngrok until you change those URLs."
