<#
.SYNOPSIS
  Run RecapAI on your Windows PC with Docker Desktop (for testing before deploying).

.DESCRIPTION
  Needs Docker Desktop (https://www.docker.com/products/docker-desktop/) running.
  Builds the same Linux containers used on the VPS, so there are no Windows build problems.
  Open http://localhost:8080 when it is ready.

.EXAMPLE
  .\windows\run-local.ps1          # build & start
  .\windows\run-local.ps1 -Stop    # stop
  .\windows\run-local.ps1 -Logs    # follow logs
#>
param([switch]$Stop, [switch]$Logs)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker Desktop is not installed:  winget install --id Docker.DockerDesktop -e   (then restart Windows)" -ForegroundColor Red; exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "Start Docker Desktop first, wait until it says 'Running', then re-run." -ForegroundColor Red; exit 1 }

$compose = @("compose", "--env-file", ".env.local", "-f", "docker-compose.yml", "-f", "windows/docker-compose.local.yml")
if ($Stop) { docker @compose down; exit }
if ($Logs) { docker @compose logs -f --tail=100 api worker; exit }

if (-not (Test-Path ".env.local")) {
  function Rand([int]$n = 32) { -join ((1..$n) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) }
  @"
NODE_ENV=production
DOMAIN=localhost
WEB_ORIGIN=http://localhost:8080
API_PUBLIC_URL=http://localhost:8080
COOKIE_SECURE=false
SESSION_SECRET=$(Rand 64)
SECRETS_KEY=$(Rand 64)
POSTGRES_USER=recap
POSTGRES_PASSWORD=$(Rand 24)
POSTGRES_DB=recap
REDIS_PASSWORD=$(Rand 24)
ADMIN_EMAIL=admin@local.test
ADMIN_PASSWORD=Admin12345!
STORAGE_DRIVER=local
ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true
TTS_PROVIDER=none
WORKER_CPUS=2
WORKER_MEMORY=3g
"@ | Set-Content -Path ".env.local" -Encoding ascii
  Write-Host "Created .env.local (admin@local.test / Admin12345!)" -ForegroundColor Green
}

Write-Host "Building and starting (first time 5-15 minutes)..." -ForegroundColor Magenta
docker @compose up -d --build
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "`nReady soon at http://localhost:8080  (login: admin@local.test / Admin12345!)" -ForegroundColor Green
Start-Process "http://localhost:8080"
