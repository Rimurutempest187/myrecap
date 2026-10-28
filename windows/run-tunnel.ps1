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

# ------------------------------------------------------------------ Docker helpers
$DockerExe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"

function Test-DockerEngine {
  # Windows PowerShell 5.1 turns redirected stderr of a native command into an exception when
  # $ErrorActionPreference = "Stop", so relax it just for this probe.
  $old = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
  try { docker info 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) } catch { return $false } finally { $ErrorActionPreference = $old }
}

function Invoke-Native([scriptblock]$Block) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
  try { & $Block 2>&1 | Out-String } catch { "" } finally { $ErrorActionPreference = $old }
}

function Wait-DockerEngine([int]$Seconds = 240) {
  for ($i = 0; $i -lt ($Seconds / 4); $i++) {
    if (Test-DockerEngine) { return $true }
    Start-Sleep 4
  }
  return $false
}

function Restart-DockerDesktop([string]$Why = "") {
  if ($Why) { Warn $Why }
  Warn "Restarting Docker Desktop (about 1-2 minutes)..."
  Get-Process -Name "Docker Desktop", "com.docker.backend", "com.docker.build", "com.docker.dev-envs" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 3
  Invoke-Native { wsl --shutdown } | Out-Null
  Start-Sleep 5
  if (Test-Path $DockerExe) { Start-Process $DockerExe } else { Warn "Open Docker Desktop manually." }
  if (Wait-DockerEngine 300) { Ok "Docker Desktop is running again"; return $true }
  Fail "Docker Desktop did not start. Open it manually, wait for 'Engine running', then run this script again."
}

# Give WSL2 (where Docker runs) enough memory + swap so the build does not crash the engine.
# Only creates %USERPROFILE%\.wslconfig when it does not exist yet (never overwrites your own file).
function Ensure-WslConfig {
  $cfg = Join-Path $env:USERPROFILE ".wslconfig"
  try { $ramGB = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB) } catch { $ramGB = 8 }
  if ($ramGB -lt 8) { Warn "This PC has $ramGB GB RAM. 8 GB+ is recommended; the first build may be slow." }
  if (Test-Path $cfg) { return $false }
  $mem = [math]::Max(3, [math]::Min(12, [math]::Floor($ramGB * 0.6)))
  $swapDir = $null
  if (Test-Path "D:\") { $swapDir = "D:\DockerData" }
  $lines = @("[wsl2]", "memory=${mem}GB", "swap=8GB")
  if ($swapDir) {
    New-Item -ItemType Directory -Force $swapDir | Out-Null
    $lines += "swapFile=" + (($swapDir + "\wsl-swap.vhdx") -replace '\\', '\\')
  }
  Set-Content -Path $cfg -Value $lines -Encoding ascii
  Ok "Created $cfg (WSL memory ${mem}GB + 8GB swap) so Docker builds do not run out of memory"
  return $true
}

# Run "docker compose <args>" with retries; restarts Docker Desktop automatically if the engine crashed.
function Invoke-Compose([string[]]$CArgs, [string]$Label, [int]$Tries = 3) {
  for ($t = 1; $t -le $Tries; $t++) {
    if (-not (Test-DockerEngine)) { Restart-DockerDesktop "Docker engine is not responding." | Out-Null }
    docker @compose @CArgs
    if ($LASTEXITCODE -eq 0) { return $true }
    if ($t -lt $Tries) {
      Warn "$Label failed (try $t of $Tries)."
      if (-not (Test-DockerEngine)) { Restart-DockerDesktop "The Docker engine crashed (usually: out of memory during the build)." | Out-Null }
      else { Start-Sleep 10 }
    }
  }
  return $false
}

# Build the three app images ONE AT A TIME (parallel builds use too much memory on a PC).
function Build-AppImages {
  foreach ($svc in @("api", "worker", "web")) {
    Step "Building $svc image (first time: api 5-15 min, worker/web faster - they reuse the cache)"
    if (-not (Invoke-Compose @("build", $svc) "Build $svc")) { Show-DockerHelp; Fail "Building the $svc image failed - see the messages above." }
    Ok "$svc image ready"
  }
}

function Show-DockerHelp {
  Write-Host ""
  Warn "Docker failed several times. Try, in this order, then run this script again:"
  Warn "  1) Restart Windows (clears stuck Docker/WSL state)."
  Warn "  2) Docker Desktop -> Settings -> Resources: give Memory 6 GB+ (if shown) -> Apply & restart."
  Warn "  3) Need 20 GB+ free on Docker's drive (Settings -> Resources -> Advanced -> Disk image location)."
  Warn "  4) Clean half-built data:  docker builder prune -a -f   (your app data volumes are kept)"
  Warn "  5) Still failing: Docker Desktop -> Troubleshoot (bug icon) -> 'Clean / Purge data' -> WSL 2, restart PC."
}

# ------------------------------------------------------------------ Docker check
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail "Docker Desktop is not installed. Run:  winget install --id Docker.DockerDesktop -e   then restart Windows and open Docker Desktop."
}
if (-not (Test-DockerEngine)) {
  Warn "Docker Desktop is not running (or its engine crashed) - starting it..."
  if (Test-Path $DockerExe) { Start-Process $DockerExe }
  if (-not (Wait-DockerEngine 180)) { Restart-DockerDesktop | Out-Null }
}
Ok "Docker engine is running"

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
  Build-AppImages
  if (-not (Invoke-Compose @("up", "-d") "Start")) { Show-DockerHelp; Fail "Starting the app failed." }
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
    Account Resources: Include -> your account
    Zone Resources:    Include -> All zones   (easiest; or Specific zone -> the main domain, e.g. pinlonmail.com)
    Note: the domain must be added to THIS Cloudflare account (Websites list shows it as Active).
"@ -ForegroundColor Yellow
  Start-Process "https://dash.cloudflare.com/profile/api-tokens"
  $sec = Read-Host "Paste the API token" -AsSecureString
  New-Item -ItemType Directory -Force (Split-Path $TokenFile) | Out-Null
  $sec | ConvertFrom-SecureString | Set-Content $TokenFile   # DPAPI: only your Windows user can decrypt
  return [System.Net.NetworkCredential]::new("", $sec).Password
}

$script:CfHeaders = $null
function Show-PermissionHelp([string]$Path) {
  if (Test-Path $TokenFile) { Remove-Item $TokenFile -ErrorAction SilentlyContinue }
  Write-Host ""
  if ($Path -like "*cfd_tunnel*") {
    Warn "The token is NOT allowed to create/edit Cloudflare Tunnels."
    Warn "Fix: dash.cloudflare.com/profile/api-tokens -> your token -> Edit (or create a new one) and make sure:"
    Warn "   Account | Cloudflare Tunnel | Edit      <- must be EDIT, not Read"
    Warn "   Account Resources: Include -> Karangmerry...'s Account (your account, not 'All accounts' of another user)"
  } elseif ($Path -like "*dns_records*") {
    Warn "The token is NOT allowed to edit DNS. Add:  Zone | DNS | Edit"
  }
  Warn "Then run:  .\windows\run-tunnel.ps1   (the saved token was removed; paste the new/updated token)"
  Warn "If the permission is already correct: open dash.cloudflare.com -> Zero Trust once and finish the free"
  Warn "onboarding (choose team name + Free plan). New accounts must do this before tunnels can be created."
}

function Cf([string]$Method, [string]$Path, $Body = $null) {
  $p = @{ Method = $Method; Uri = "https://api.cloudflare.com/client/v4$Path"; Headers = $script:CfHeaders; ContentType = "application/json" }
  if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 10 -Compress) }
  try { $r = Invoke-RestMethod @p } catch {
    $msg = $_.ErrorDetails.Message; if (-not $msg) { $msg = $_.Exception.Message }
    if ($msg -match '"code":\s*(10000|9109)' -or $msg -match 'Authentication error|Unauthorized') { Show-PermissionHelp $Path }
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
  # NOTE: always wrap API results in @(...). Windows PowerShell 5.1 unrolls a 1-item array into a single
  # object, and a single [PSCustomObject] has no .Count there, so "$z.Count -gt 0" would be false.
  for ($i = 0; $i -lt $parts.Length - 1 -and -not $zone; $i++) {
    $name = ($parts[$i..($parts.Length - 1)] -join ".")
    $z = @(Cf GET "/zones?name=$name")
    if ($z.Count -gt 0) { $zone = $z[0] }
  }
  if (-not $zone) {
    # Fallback: list every zone the token can see and pick the one that owns the domain.
    $all = @(Cf GET "/zones?per_page=50")
    foreach ($cand in $all) {
      if ($Domain -eq $cand.name -or $Domain.EndsWith("." + $cand.name)) { $zone = $cand; break }
    }
  }
  if (-not $zone) {
    # Diagnose: which zones can this token see? Then forget the token so the next run asks again.
    $visible = @()
    try { $visible = @(Cf GET "/zones?per_page=50") } catch { }
    if (Test-Path $TokenFile) { Remove-Item $TokenFile -ErrorAction SilentlyContinue }
    Write-Host ""
    if ($visible.Count -eq 0) {
      Warn "This token can not see ANY domain (zone). Cause: the token is missing 'Zone | Zone | Read',"
      Warn "or 'Zone Resources' does not include your domain."
    } else {
      Warn "This token can only see these domains:"
      foreach ($vz in $visible) { Write-Host ("      - {0}  (status: {1}, account: {2})" -f $vz.name, $vz.status, $vz.account.name) -ForegroundColor Yellow }
      Warn "None of them is $Domain or a parent domain of it. Check the spelling of -Domain,"
      Warn "the token's Zone Resources, or whether the domain is in another Cloudflare account."
    }
    Write-Host ""
    Warn "Fix: create a new token (Zone Resources -> Include -> All zones is easiest), then run this script again."
    Warn "The saved token was removed, so the script will ask for the new one."
    Fail "Zone for $Domain not found for this token."
  }
  $accountId = $zone.account.id
  Ok "Zone $($zone.name) (account $($zone.account.name))"

  # Tunnel (reuse if it exists)
  $t = @(Cf GET "/accounts/$accountId/cfd_tunnel?name=$TunnelName&is_deleted=false")
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
  $existing = @(Cf GET "/zones/$($zone.id)/dns_records?name=$Domain")
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
# Free-space check on the drive that holds Docker's disk image
# (C: by default; Settings -> Resources -> Advanced -> Disk image location can move it, e.g. to D:).
function Get-DockerDataDrive {
  foreach ($f in @("$env:APPDATA\Docker\settings-store.json", "$env:APPDATA\Docker\settings.json")) {
    if (-not (Test-Path $f)) { continue }
    try {
      $j = Get-Content $f -Raw | ConvertFrom-Json
      foreach ($k in @("CustomWslDistroDir", "customWslDistroDir", "DataFolder", "dataFolder")) {
        $v = $j.$k
        if ($v -and ($v -match '^([A-Za-z]):')) { return $Matches[1].ToUpper() }
      }
    } catch { }
  }
  return "C"
}
try {
  $dd = Get-DockerDataDrive
  $freeGB = [math]::Round((Get-PSDrive -Name $dd).Free / 1GB, 1)
  if ($freeGB -lt 15) { Warn "Docker disk is on ${dd}: with only $freeGB GB free. The first build needs about 15-20 GB." }
  else { Ok "Docker disk on ${dd}: - $freeGB GB free" }
} catch { }

# Memory for WSL2/Docker (restart Docker once if the config was just created so it takes effect)
if (Ensure-WslConfig) { Restart-DockerDesktop "Applying the new WSL memory settings." | Out-Null }

# Pull ready-made images first, with retries (big downloads sometimes break on slow/unstable internet).
Step "Downloading base images (postgres, redis, caddy, cloudflared)"
if (-not (Invoke-Compose @("pull", "--ignore-buildable") "Download")) { Show-DockerHelp; Fail "Could not download the base images." }

Build-AppImages

Step "Starting all services"
if ($Quick) {
  # the named tunnel needs a token; in quick mode run everything except it
  Set-EnvValue "TUNNEL_TOKEN" "quick-mode"
  $ok = Invoke-Compose @("up", "-d", "postgres", "redis", "api", "worker", "web", "caddy", "cloudflared-quick") "Start"
} else {
  $ok = Invoke-Compose @("up", "-d") "Start"
}
if (-not $ok) { Show-DockerHelp; Fail "docker compose up failed - see the messages above." }

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
    $log = Invoke-Native { docker @compose logs cloudflared-quick }
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
