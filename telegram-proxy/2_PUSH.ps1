# Run this AFTER you created the repo on GitHub (see 1_CREATE_REPO_ON_GITHUB.txt)
# Replace YOUR_USERNAME and REPO_NAME with your actual GitHub username and repo name

$repoUrl = Read-Host "Paste your GitHub repo URL (e.g. https://github.com/YOUR_USERNAME/propera-telegram-proxy.git)"

if ([string]::IsNullOrWhiteSpace($repoUrl)) {
    Write-Host "No URL entered. Exiting."
    exit 1
}

Set-Location $PSScriptRoot

Write-Host "Adding remote origin..."
git remote add origin $repoUrl
if ($LASTEXITCODE -ne 0) {
    Write-Host "If it says 'already exists', run: git remote set-url origin $repoUrl"
}

Write-Host "Pushing to GitHub..."
git push -u origin main

Write-Host "Done. If push asked for password, use a Personal Access Token from GitHub (not your GitHub password)."
