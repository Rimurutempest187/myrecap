<#
.SYNOPSIS
  Run RecapAI on this Windows PC and publish it at https://<your-domain> through Cloudflare Tunnel.
  No VPS, no router port-forwarding, no static IP.

.DESCRIPTION
  First run:
    1. Checks Docker Desktop
    2. Asks for a Cloudflare API token (saved encrypted for your Windows user only)
    3. Creates (or reuses) the Cloudflare Tunnel "recapai", routes it to the app,
       and creates the proxied DNS record for your domain
    4. Generates .env.tunnel with strong random secrets
    5. Builds and starts PostgreSQL, Redis, API, worker, web, Caddy and cloudflared
  Later runs: just starts everything again (fast).

  The website works while this PC is on and Docker Desktop is running.

.EXAMPLE
  .\windows\run-tunnel.ps1                                   # myrecap.pinlonmail.com
  .\windows\run-tunnel.ps1 -Domain myrecap.pinlonmail.com -Email you@gmail.com
  .\windows\run-tunnel.ps1 -Quick       # no domain: temporary https://xxxx.trycloudflare.com URL
  .\windows\run-tunnel.ps1 -Stop | -Logs | -Status | -Update | -Backup
#>
[CmdletBinding()]
param(
  [string]$Domain = "myrecap.pinlonmail.com",
  [string]$Email = "",
  [string]$TunnelName = "recapai",
  [switch]$Quick,
  [switch]$Stop,
  [switch]$Logs,
  [switch]$Status,
  [switch]$Update,
  [switch]$Backup,
  [switch]$ResetToken
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Magenta }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

$EnvFile = ".env.tunnel"
$TokenFile = Join-Path $env:LOCALAPPDATA "RecapAI\cloudflare-token.txt"
$compose = @("compose", "--env-file", $EnvFile, "-f", "docker-compose.yml", "-f", "windows/docker-compose.tunnel.yml")
if ($Quick) { $compose += @("--profile", "quick") }

# ------------------------------------------------------------------ Docker check
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail "Docker Desktop is not installed. Run:  winget install --id Docker.DockerDesktop -e   then restart Windows and open Docker Desktop."
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Warn "Docker Desktop is not running - starting it..."
  $dd = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dd) { Start-Process $dd }
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep 3; docker info *> $null; if ($LASTEXITCODE -eq 0) { break } }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop did not start. Open it manually, wait for 'Engine running', then re-run." }
}

# ------------------------------------------------------------------ quick actions
if ($Stop)   { docker @compose down; Ok "Stopped. Data is kept (Docker volumes)."; exit }
if ($Logs)   { docker @compose logs -f --tail=100 api worker cloudflared; exit }
if ($Status) { docker @compose ps; exit }
if ($Backup) {
  New-Item -ItemType Directory -Force backups | Out-Null
  $f = "backups\recap-$(Get-Date -Format 'yyyy-MM-dd-HHmm').sql"
  docker @compose exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER $POSTGRES_DB' | Out-File -Encoding utf8 $f
  Ok "Database backup: $f"; exit
}
if ($Update) {
  if (Get-Command git -ErrorAction SilentlyContinue) { git pull --ff-only }
  docker @compose up -d --build
  Ok "Updated"; exit
}

# ------------------------------------------------------------------ Cloudflare API helpers
function Get-CfToken {
  if ($ResetToken -and (Test-Path $TokenFile)) { Remove-Item $TokenFile }
  if (Test-Path $TokenFile) {
    try { return [System.Net.NetworkCredential]::new("", (Get-Content $TokenFile | ConvertTo-SecureString)).Password } catch { Remove-Item $TokenFile }
  }
  Write-Host @"

  Create a Cloudflare API token (one time):
    https://dash.cloudflare.com/profile/api-tokens -> Create Token -> Create Custom Token
    Permissions:
      Account  | Cloudflare Tunnel | Edit
      Zone     | DNS               | Edit
      Zone     | Zone              | Read
    Account Resources: your account     Zone Resources: Include -> Specific zone -> your domain's zone
"@ -ForegroundColor Yellow
  Start-Process "https://dash.cloudflare.com/profile/api-tokens"
  $sec = Read-Host "Paste the API token" -AsSecureString
  New-Item -ItemType Directory -Force (Split-Path $TokenFile) | Out-Null
  $sec | ConvertFrom-SecureString | Set-Content $TokenFile   # DPAPI: only your Windows user can decrypt
  return [System.Net.NetworkCredential]::new("", $sec).Password
}

$script:CfHeaders = $null
function Cf([string]$Method, [string]$Path, $Body = $null) {
  $p = @{ Method = $Method; Uri = "https://api.cloudflare.com/client/v4$Path"; Headers = $script:CfHeaders; ContentType = "application/json" }
  if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 10 -Compress) }
  try { $r = Invoke-RestMethod @p } catch {
    $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
    Fail "Cloudflare API $Method $Path failed: $msg"
  }
  if (-not $r.success) { Fail "Cloudflare API error: $($r.errors | ConvertTo-Json -Compress)" }
  return $r.result
}

function Setup-Tunnel {
  Step "Cloudflare: tunnel + DNS for https://$Domain"
  $token = Get-CfToken
  $script:CfHeaders = @{ Authorization = "Bearer $token" }
  $v = Cf GET "/user/tokens/verify"
  if ($v.status -ne "active") { Fail "API token is not active" }
  Ok "API token valid"

  # Find the zone for the domain (walk up: a.b.example.com -> b.example.com -> example.com)
  $zone = $null; $parts = $Domain.Split(".")
  for ($i = 0; $i -lt $parts.Length - 1 -and -not $zone; $i++) {
    $name = ($parts[$i..($parts.Length - 1)] -join ".")
    $z = Cf GET "/zones?name=$name"
    if ($z.Count -gt 0) { $zone = $z[0] }
  }
  if (-not $zone) { Fail "Zone for $Domain not found in this Cloudflare account (or the token has no Zone:Read for it)." }
  $accountId = $zone.account.id
  Ok "Zone $($zone.name) (account $($zone.account.name))"

  # Tunnel (reuse if it exists)
  $t = Cf GET "/accounts/$accountId/cfd_tunnel?name=$TunnelName&is_deleted=false"
  if ($t.Count -gt 0) { $tunnel = $t[0]; Ok "Reusing tunnel '$TunnelName' ($($tunnel.id))" }
  else {
    $secret = [Convert]::ToBase64String((1..32 | ForEach-Object { [byte](Get-Random -Maximum 256) }))
    $tunnel = Cf POST "/accounts/$accountId/cfd_tunnel" @{ name = $TunnelName; config_src = "cloudflare"; tunnel_secret = $secret }
    Ok "Created tunnel '$TunnelName' ($($tunnel.id))"
  }

  # Ingress: domain -> caddy inside the Docker network
  Cf PUT "/accounts/$accountId/cfd_tunnel/$($tunnel.id)/configurations" @{
    config = @{
      ingress = @(
        @{ hostname = $Domain; service = "http://caddy:80"; originRequest = @{ connectTimeout = 30; noTLSVerify = $true } },
        @{ service = "http_status:404" }
      )
    }
  } | Out-Null
  Ok "Tunnel routes $Domain -> app"

  # DNS: CNAME <domain> -> <tunnel-id>.cfargotunnel.com (proxied). Replaces an existing A/CNAME for the same name.
  $target = "$($tunnel.id).cfargotunnel.com"
  $done = $false
  $existing = Cf GET "/zones/$($zone.id)/dns_records?name=$Domain"
  foreach ($r in $existing) {
    if ($r.type -eq "CNAME" -and $r.content -eq $target) { $done = $true; continue }
    if ($r.type -in @("A", "AAAA", "CNAME")) {
      Warn "Replacing existing $($r.type) record $($r.name) -> $($r.content)"
      Cf DELETE "/zones/$($zone.id)/dns_records/$($r.id)" | Out-Null
    }
  }
  if (-not $done) { Cf POST "/zones/$($zone.id)/dns_records" @{ type = "CNAME"; name = $Domain; content = $target; proxied = $true; comment = "RecapAI tunnel" } | Out-Null }
  Ok "DNS $Domain -> tunnel (proxied)"

  $tt = Cf GET "/accounts/$accountId/cfd_tunnel/$($tunnel.id)/token"
  return [string]$tt
}

# ------------------------------------------------------------------ .env.tunnel
function Rand([int]$n = 64) { -join ((1..$n) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) }
function Set-EnvValue([string]$key, [string]$value) {
  $lines = if (Test-Path $EnvFile) { @(Get-Content $EnvFile) } else { @() }
  $found = $false
  $lines = $lines | ForEach-Object { if ($_ -match "^$key=") { $found = $true; "$key=$value" } else { $_ } }
  if (-not $found) { $lines += "$key=$value" }
  Set-Content -Path $EnvFile -Value $lines -Encoding ascii
}

$publicUrl = "https://$Domain"
if ($Quick) { $publicUrl = "https://placeholder.trycloudflare.com" }

if (-not (Test-Path $EnvFile)) {
  Step "Creating $EnvFile with random secrets"
  if (-not $Email) { $Email = Read-Host "Admin email for the website" }
  $adminPw = (Rand 8) + "Aa1!"
  @"
NODE_ENV=production
DOMAIN=$Domain
WEB_ORIGIN=$publicUrl
API_PUBLIC_URL=$publicUrl
COOKIE_SECURE=true
SESSION_SECRET=$(Rand 64)
SECRETS_KEY=$(Rand 64)
SESSION_TTL_DAYS=30
POSTGRES_USER=recap
POSTGRES_PASSWORD=$(Rand 32)
POSTGRES_DB=recap
REDIS_PASSWORD=$(Rand 32)
ADMIN_EMAIL=$Email
ADMIN_PASSWORD=$adminPw
SIGNUP_BONUS_CREDITS=30
STORAGE_DRIVER=local
ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true
MAX_UPLOAD_MB=2048
TTS_PROVIDER=none
WORKER_CONCURRENCY=1
WORKER_CPUS=$([Math]::Max(1, [Environment]::ProcessorCount - 1))
WORKER_MEMORY=3g
FFMPEG_PRESET=veryfast
JOB_TIMEOUT_MIN=60
BACKUP_ENABLED=true
BACKUP_RETENTION_DAYS=14
"@ | Set-Content -Path $EnvFile -Encoding ascii
  Ok "$EnvFile created (keep it private; it is git-ignored)"
  $firstRun = $true
}

if (-not $Quick) {
  $tunnelToken = Setup-Tunnel
  Set-EnvValue "TUNNEL_TOKEN" $tunnelToken
  Set-EnvValue "DOMAIN" $Domain
  Set-EnvValue "WEB_ORIGIN" $publicUrl
  Set-EnvValue "API_PUBLIC_URL" $publicUrl
}

# ------------------------------------------------------------------ start
Step "Building & starting (first build: 5-15 minutes)"
if ($Quick) {
  # the named tunnel needs a token; in quick mode run everything except it
  Set-EnvValue "TUNNEL_TOKEN" "quick-mode"
  docker @compose up -d --build postgres redis api worker web caddy cloudflared-quick
} else {
  docker @compose up -d --build
}
if ($LASTEXITCODE -ne 0) { Fail "docker compose failed - see the messages above." }

Write-Host -NoNewline "  waiting for the app"
for ($i = 0; $i -lt 90; $i++) {
  try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/health" -TimeoutSec 3; if ($h.ok) { break } } catch {}
  Write-Host -NoNewline "."; Start-Sleep 3
}
Write-Host ""
try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/health" -TimeoutSec 5 } catch { $h = $null }
if (-not $h.ok) { docker @compose logs --tail=60 api; Fail "The app did not become healthy." }
Ok "App healthy on this PC (http://127.0.0.1:8080)"

if ($Quick) {
  Step "Getting your temporary public URL"
  $url = $null
  for ($i = 0; $i -lt 30 -and -not $url; $i++) {
    $log = docker @compose logs cloudflared-quick 2>&1 | Out-String
    $m = [regex]::Match($log, "https://[a-z0-9-]+\.trycloudflare\.com")
    if ($m.Success) { $url = $m.Value } else { Start-Sleep 2 }
  }
  if (-not $url) { Fail "Could not read the trycloudflare URL - run: .\windows\run-tunnel.ps1 -Quick -Logs" }
  Set-EnvValue "WEB_ORIGIN" $url; Set-EnvValue "API_PUBLIC_URL" $url
  docker @compose up -d api worker | Out-Null    # apply the URL
  $publicUrl = $url
  Warn "Quick URLs change every restart. Use your domain (run without -Quick) for a permanent address."
}

$admin = (Get-Content $EnvFile | Where-Object { $_ -match "^ADMIN_(EMAIL|PASSWORD)=" }) -replace "^ADMIN_", ""
Write-Host "`n  RecapAI is live at $publicUrl" -ForegroundColor Green
if ($firstRun) {
  Write-Host "  Admin login:" -ForegroundColor Cyan; $admin | ForEach-Object { Write-Host "    $_" -ForegroundColor Cyan }
  Write-Host "  Change the password after logging in (Account page)." -ForegroundColor Cyan
}
Write-Host "  Next: Admin -> AI Models & Keys -> Add provider key (Google Gemini) -> Recommended -> Save routing"
Write-Host "  Keep this PC on and Docker Desktop running. Stop: .\windows\run-tunnel.ps1 -Stop"
Start-Process $publicUrl
