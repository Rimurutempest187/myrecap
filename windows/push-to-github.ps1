<#
.SYNOPSIS
  Save your code changes to GitHub with one command, then (optionally) deploy them to the VPS.

.EXAMPLE
  .\windows\push-to-github.ps1 "Changed landing page text"
  .\windows\push-to-github.ps1 "Fix subtitle color" -Deploy
#>
param(
  [Parameter(Position = 0)][string]$Message = "",
  [switch]$Deploy
)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "Git is not installed. Install it with:  winget install --id Git.Git -e" -ForegroundColor Red; exit 1
}
if (-not $Message) { $Message = Read-Host "Describe your change" }
if (-not $Message) { $Message = "Update $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }

git add -A
if (git status --porcelain) {
  git commit -m $Message | Out-Host
} else {
  Write-Host "No local changes to commit." -ForegroundColor Yellow
}
git pull --rebase origin main | Out-Host
git push origin main | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Host "Push failed. Run 'git status' to see what is wrong." -ForegroundColor Red; exit 1 }
Write-Host "Pushed to GitHub." -ForegroundColor Green

if ($Deploy) { & "$PSScriptRoot\deploy-vps.ps1" }
