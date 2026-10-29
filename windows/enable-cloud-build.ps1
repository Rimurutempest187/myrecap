<#
.SYNOPSIS
  One-time: turn on GitHub cloud builds of the RecapAI Docker images.
  After this, every push to GitHub builds the images on GitHub's servers and
  .\windows\run-tunnel.ps1 just downloads them (no heavy build on this PC).

.DESCRIPTION
  1. Copies ci\docker-publish.yml and ci\github-actions-ci.yml into .github\workflows\
  2. Commits and pushes with YOUR GitHub login (a browser login window may open the first time)
  3. Opens the GitHub Actions page so you can watch the build (about 10-15 minutes)
  Then make the 3 packages public once (see the instructions printed at the end).
#>
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Magenta }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "Git is not installed: winget install --id Git.Git -e" }

function Git([string[]]$GArgs) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
  $out = & git @GArgs 2>&1 | Out-String
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  return @{ Out = $out; Code = $code }
}

$remote = (Git @("remote", "get-url", "origin")).Out.Trim()
$m = [regex]::Match($remote, "github\.com[:/]+([^/]+)/([^/.]+)")
if (-not $m.Success) { Fail "origin is not a GitHub repository ($remote)" }
$owner = $m.Groups[1].Value; $repo = $m.Groups[2].Value
Ok "Repository: $owner/$repo"

Step "Getting the latest code"
$r = Git @("pull", "--rebase", "origin", "main")
if ($r.Code -ne 0) { Write-Host $r.Out; Fail "git pull failed. Run:  git fetch origin; git reset --hard origin/main   then try again." }

Step "Adding the GitHub Actions workflows"
New-Item -ItemType Directory -Force ".github\workflows" | Out-Null
Copy-Item "ci\docker-publish.yml" ".github\workflows\docker-publish.yml" -Force
Copy-Item "ci\github-actions-ci.yml" ".github\workflows\ci.yml" -Force
Ok ".github\workflows\docker-publish.yml + ci.yml"

if (-not (Git @("config", "user.email")).Out.Trim()) {
  $em = Read-Host "Your email for git commits"
  Git @("config", "user.email", $em) | Out-Null
}
if (-not (Git @("config", "user.name")).Out.Trim()) { Git @("config", "user.name", $owner) | Out-Null }

Git @("add", ".github/workflows") | Out-Null
$st = (Git @("status", "--porcelain", ".github/workflows")).Out.Trim()
if ($st) {
  $r = Git @("commit", "-m", "Enable GitHub Actions: CI + Docker image publishing")
  if ($r.Code -ne 0) { Write-Host $r.Out; Fail "git commit failed" }
  Ok "Committed"
} else { Ok "Workflows already committed" }

Step "Pushing to GitHub (a GitHub login window may open - sign in as $owner)"
$r = Git @("push", "origin", "HEAD:main")
if ($r.Code -ne 0) {
  Write-Host $r.Out
  if ($r.Out -match "workflow") { Fail "Your GitHub login has no 'workflow' permission. Run:  git credential-manager github logout   and try again (sign in in the browser)." }
  Fail "git push failed - see the message above."
}
Ok "Pushed. GitHub is now building the images (10-15 minutes the first time)."
Start-Process "https://github.com/$owner/$repo/actions"

$low = $owner.ToLower()
Write-Host @"

  NEXT (one time, after the 'Docker images' run shows a green check):
    Make the 3 packages public so this PC can download them without a password:
      https://github.com/users/$owner/packages/container/myrecap-api/settings
      https://github.com/users/$owner/packages/container/myrecap-worker/settings
      https://github.com/users/$owner/packages/container/myrecap-web/settings
    On each page: scroll to 'Danger Zone' -> Change visibility -> Public -> type the name -> confirm.

  Then start the website (it downloads ghcr.io/$low/myrecap-* instead of building):
      .\windows\run-tunnel.ps1
"@ -ForegroundColor Cyan
