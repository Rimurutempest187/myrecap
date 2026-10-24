<#
.SYNOPSIS
  Deploy / update RecapAI on your VPS from Windows PowerShell - one command.

.DESCRIPTION
  First time  : copies the Cloudflare Origin Certificate to the server, clones the GitHub repo,
                and runs deploy/install.sh (Docker, firewall, .env, build, start, backups).
  Next times  : pulls the latest code from GitHub and rebuilds (deploy/update.sh).

  Uses only tools built into Windows 10/11: ssh.exe and scp.exe (OpenSSH client).

.EXAMPLE
  .\windows\deploy-vps.ps1
  .\windows\deploy-vps.ps1 -Server 169.58.6.42 -Domain myrecap.pinlonmail.com -Email you@gmail.com
  .\windows\deploy-vps.ps1 -Logs          # follow worker/api logs
  .\windows\deploy-vps.ps1 -Status        # container status
#>
[CmdletBinding()]
param(
  [string]$Server = "169.58.6.42",
  [string]$User = "root",
  [int]$Port = 22,
  [string]$Domain = "myrecap.pinlonmail.com",
  [string]$Email = "",
  [string]$Repo = "https://github.com/Rimurutempest187/myrecap.git",
  [string]$Branch = "main",
  [string]$CertDir = "$PSScriptRoot\certs",
  [string]$RemoteDir = "/opt/recapai",
  [switch]$Logs,
  [switch]$Status
)

$ErrorActionPreference = "Stop"
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Magenta }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red; exit 1 }

# ---- prerequisites --------------------------------------------------------------
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  Fail "OpenSSH client not found. Run PowerShell as Administrator:  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0"
}
$target = "$User@$Server"
$sshArgs = @("-p", "$Port", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30")
function Remote([string]$cmd) {
  & ssh @sshArgs $target $cmd
  if ($LASTEXITCODE -ne 0) { Fail "Remote command failed (exit $LASTEXITCODE)" }
}
$compose = "docker compose -f docker-compose.yml -f deploy/docker-compose.cloudflare.yml"

if ($Logs)   { & ssh @sshArgs -t $target "cd $RemoteDir && $compose logs -f --tail=100 api worker"; exit }
if ($Status) { & ssh @sshArgs $target "cd $RemoteDir && $compose ps"; exit }

Step "Connecting to $target (enter the server password if asked)"
Remote "echo connected; uname -a"
Ok "SSH works"

# ---- first install or update? ----------------------------------------------------
$installed = (& ssh @sshArgs $target "test -f $RemoteDir/.env && echo yes || echo no").Trim()

if ($installed -eq "yes") {
  Step "RecapAI is already installed -> updating to the latest GitHub code"
  Remote "cd $RemoteDir && git fetch origin $Branch && git reset --hard origin/$Branch && bash deploy/update.sh"
  Ok "Updated. Open https://$Domain"
  exit
}

# ---- first install ---------------------------------------------------------------
if (-not $Email) { $Email = Read-Host "Admin email for the website" }

Step "Checking the Cloudflare Origin Certificate in $CertDir"
$pem = Join-Path $CertDir "origin.pem"
$key = Join-Path $CertDir "origin.key"
if (-not (Test-Path $pem) -or -not (Test-Path $key)) {
  New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
  Write-Host @"

  Create the certificate in Cloudflare:
    SSL/TLS -> Origin Server -> Create Certificate -> (RSA, 15 years) -> Create
  Then save the two boxes as text files:
    $pem   <- "Origin Certificate"
    $key   <- "Private Key"
  (Notepad opens now - paste, then File > Save.)
"@ -ForegroundColor Yellow
  if (-not (Test-Path $pem)) { Set-Content -Path $pem -Value "" -Encoding ascii; notepad $pem | Out-Null }
  if (-not (Test-Path $key) -or (Get-Item $key).Length -eq 0) { Set-Content -Path $key -Value "" -Encoding ascii; notepad $key | Out-Null }
  Read-Host "Press Enter after saving both files"
}
if ((Get-Content $pem -Raw) -notmatch "BEGIN CERTIFICATE") { Fail "origin.pem does not contain a certificate" }
if ((Get-Content $key -Raw) -notmatch "PRIVATE KEY")        { Fail "origin.key does not contain a private key" }
Ok "Certificate files look valid"

Step "Installing git on the server and cloning $Repo"
Remote "(command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)) && if [ -d $RemoteDir/.git ]; then cd $RemoteDir && git fetch origin $Branch && git reset --hard origin/$Branch; else git clone --branch $Branch $Repo $RemoteDir; fi && mkdir -p $RemoteDir/deploy/certs"
Ok "Code is on the server"

Step "Uploading the certificate"
& scp -P $Port -o StrictHostKeyChecking=accept-new $pem $key "${target}:$RemoteDir/deploy/certs/"
if ($LASTEXITCODE -ne 0) { Fail "scp failed" }
# Windows editors may add CRLF line endings - normalize on the server
Remote "sed -i 's/\r$//' $RemoteDir/deploy/certs/origin.pem $RemoteDir/deploy/certs/origin.key"
Ok "Certificate uploaded"

Step "Running the installer (first build takes 5-15 minutes)"
& ssh @sshArgs -t $target "cd $RemoteDir && bash deploy/install.sh $Domain $Email"
if ($LASTEXITCODE -ne 0) { Fail "Installer failed - copy the red error above and ask for help." }

Write-Host "`nDone! Open https://$Domain and log in with the admin email/password shown above." -ForegroundColor Green
Write-Host "Next time just run:  .\windows\deploy-vps.ps1   (it updates automatically)" -ForegroundColor Cyan
