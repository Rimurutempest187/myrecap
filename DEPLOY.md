# RecapAI — VPS + Cloudflare Deployment Guide

> **No VPS yet?** Run it from your Windows PC with Docker Desktop + Cloudflare Tunnel:
> `.\windows\run-tunnel.ps1` — see [windows/README-WINDOWS.md](windows/README-WINDOWS.md) (Option A).

**Server:** `169.58.6.42`  **Domain:** `myrecap.pinlonmail.com`  **Proxy/SSL:** Cloudflare

```
Visitor ──HTTPS──▶ Cloudflare (CDN, DDoS, WAF) ──HTTPS (Origin Cert)──▶ VPS 169.58.6.42
                                                                         └─ Caddy :443 → Next.js web / Node API
                                                                            PostgreSQL · Redis · FFmpeg worker (Docker)
```

---

## 0. VPS requirements
| | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu 22.04 / 24.04 or Debian 12 (64-bit) | Ubuntu 24.04 |
| CPU | 2 vCPU | 4+ vCPU (renders are CPU-bound) |
| RAM | 4 GB | 8 GB |
| Disk | 40 GB SSD | 100 GB+ (uploaded videos + renders are stored here) |

---

## 1. Cloudflare — DNS
1. Cloudflare dashboard → choose the zone **pinlonmail.com**.
2. **DNS → Records → Add record**
   - Type: `A`
   - Name: `myrecap`
   - IPv4 address: `169.58.6.42`
   - Proxy status: **Proxied (orange cloud ON)**
   - TTL: Auto → **Save**

## 2. Cloudflare — SSL/TLS settings
1. **SSL/TLS → Overview** → encryption mode **Full (strict)**.
2. **SSL/TLS → Edge Certificates**
   - Always Use HTTPS: **On**
   - Minimum TLS Version: **TLS 1.2**
   - Automatic HTTPS Rewrites: **On**

## 3. Cloudflare — Origin Certificate (the VPS uses this for HTTPS)
1. **SSL/TLS → Origin Server → Create Certificate**
2. Keep "Generate private key and CSR with Cloudflare", key type **RSA (2048)**
3. Hostnames: `myrecap.pinlonmail.com` (you can also keep `*.pinlonmail.com`)
4. Validity: **15 years** → **Create**
5. Two text boxes appear — **keep this page open** (the private key is shown only once):
   - **Origin Certificate** → you will save it as `origin.pem`
   - **Private Key** → you will save it as `origin.key`

## 4. Cloudflare — settings for video upload & live progress
1. **Speed → Optimization**: turn **Rocket Loader OFF** (it breaks the app's JavaScript).
2. **Caching → Configuration**: Browser Cache TTL = "Respect Existing Headers".
3. **Rules → Cache Rules → Create rule** "Bypass API":
   - When: URI Path starts with `/api/`
   - Then: **Bypass cache** → Deploy
4. **Network**: WebSockets **On** (default). Leave HTTP/2 and HTTP/3 on.

> Cloudflare limits each request to 100 MB (Free/Pro plans). The app already uploads large videos in 32 MB chunks, so 2 GB uploads work.
> Cloudflare times out a request after 100 seconds; jobs run in the background and progress is streamed with keep-alive pings, so this is not a problem.

---

## 5. VPS — upload the code
From your computer (download the project backup first and unpack it so you have a `webapp` folder), or clone from GitHub if you pushed it there:

```bash
# On your computer — copy the project to the server
scp -r webapp root@169.58.6.42:/opt/recapai
```
Or on the server:
```bash
ssh root@169.58.6.42
apt-get update && apt-get install -y git
git clone https://github.com/<you>/<repo>.git /opt/recapai
```

## 6. VPS — add the Origin Certificate
```bash
ssh root@169.58.6.42
cd /opt/recapai
mkdir -p deploy/certs
nano deploy/certs/origin.pem    # paste the "Origin Certificate" from step 3, save (Ctrl+O, Enter, Ctrl+X)
nano deploy/certs/origin.key    # paste the "Private Key" from step 3, save
```

## 7. VPS — install & start (one command)
```bash
cd /opt/recapai
sudo bash deploy/install.sh myrecap.pinlonmail.com YOUR-EMAIL@gmail.com
```
The script will:
- install Docker, create swap, configure the firewall (SSH open; ports 80/443 only from Cloudflare)
- create `.env` with strong random passwords and secrets
- check the Origin Certificate
- build and start PostgreSQL, Redis, API, worker, web and Caddy (the first build takes 5–15 minutes)
- install a nightly database backup to `/var/backups/recapai`

At the end it prints your **admin email and password** (also saved in `/root/recapai-admin-password.txt`).

## 8. First login & AI setup
1. Open **https://myrecap.pinlonmail.com** → **Log in** with the admin email/password → **Account** → change the password.
2. **Admin → AI Models & Keys → Add provider key** → *Google Gemini* → paste your key → **Save & test**.
3. On the Gemini card click **Recommended** → this adds chat models, 8 Burmese voices and dialogue transcription.
4. **Task routing**:
   - Vision analysis and Burmese script writer: primary **Gemini 3 Flash**, fallback **Gemini 3.1 Flash-Lite**
   - Speech-to-text: **Gemini dialogue transcription**
   - Default voice: **Gemini Kore** → **Save routing**
5. Test it: **New Recap** → upload a short video → keep **Auto-Pilot** on.

---

## 9. Day-to-day operations
```bash
cd /opt/recapai
C="docker compose -f docker-compose.yml -f deploy/docker-compose.cloudflare.yml"

$C ps                       # status of all services
$C logs -f --tail=100 api   # API logs        (worker / web / caddy too)
$C restart worker           # restart one service
sudo bash deploy/update.sh  # after uploading new code: backup → rebuild → restart (migrations automatic)
```

| Task | Command |
|---|---|
| Manual DB backup | `$C exec -T postgres sh -c 'pg_dump -U $POSTGRES_USER $POSTGRES_DB' \| gzip > backup.sql.gz` |
| Restore DB | `gunzip -c backup.sql.gz \| $C exec -T postgres sh -c 'psql -U $POSTGRES_USER $POSTGRES_DB'` |
| Disk usage of media | `docker system df -v \| grep media` |
| More render capacity | `$C up -d --scale worker=2` (needs more CPU/RAM) |

Back up two things off the server regularly: `/var/backups/recapai/*.sql.gz` and the `.env` file (without `.env` the encrypted API keys cannot be decrypted).

## 10. Troubleshooting
| Symptom | Fix |
|---|---|
| Cloudflare **Error 521** | Containers are down: `$C ps`, `$C logs caddy`. Is port 443 open in the provider's firewall too? |
| Cloudflare **Error 525/526** | SSL mode must be **Full (strict)** and `deploy/certs/origin.pem`/`origin.key` must be the Cloudflare Origin Certificate for this hostname. |
| `403 Forbidden` opening `https://169.58.6.42` | Expected — the server only answers requests that come through Cloudflare. |
| Upload stuck/failing | Turn Rocket Loader off; make sure the Cache Rule bypasses `/api/`. |
| "No AI model is configured" | Admin → AI Models & Keys → add Gemini key → Recommended → Save routing. |
| Gemini 429 quota errors | Free Gemini keys have daily limits — enable billing in Google AI Studio. |
| Renders slow | Use a VPS with more vCPUs; `FFMPEG_PRESET=superfast` in `.env`, then `sudo bash deploy/update.sh`. |

## 11. Optional: unlimited storage with Cloudflare R2
When the disk fills up, move media to R2 (no egress fees):
1. Cloudflare → **R2** → Create bucket `recapai-media` → **Manage API tokens** → create a token with Object Read & Write.
2. Bucket → Settings → **CORS**: allow origin `https://myrecap.pinlonmail.com`, methods `GET, PUT, HEAD`, headers `*`.
3. In `.env` set:
   ```
   STORAGE_DRIVER=r2
   R2_ACCOUNT_ID=<account id>
   S3_ACCESS_KEY_ID=<key>
   S3_SECRET_ACCESS_KEY=<secret>
   S3_BUCKET=recapai-media
   ```
4. `sudo bash deploy/update.sh` (new uploads go to R2; uploads then go straight from the browser to R2, bypassing the server).
