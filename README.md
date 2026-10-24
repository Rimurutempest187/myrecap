# RecapAI — Myanmar AI Recap Video Generator

A full-stack web app for turning long videos into **Myanmar-narrated recap videos**:
Upload → AI analysis → editable Burmese script → Myanmar AI voiceover → Myanmar Unicode subtitles → FFmpeg rendering → preview → MP4 download.

Supports **Anime Recap, Movie Recap, Long-to-Shorts, Highlights and Custom Recap**, in **9:16, 16:9 and 1:1**.

---

## 1. Status

| Area | Status |
|---|---|
| Accounts: register, login, profile, password change, account deletion | ✅ Working |
| Project dashboard, search, filters, history, duplicate, delete | ✅ Working |
| Uploads: presigned direct-to-storage, type/size limits, ffprobe validation, duration limits by plan | ✅ Working |
| Scene detection (FFmpeg) + key-frame sampling | ✅ Working |
| AI vision analysis + Myanmar script with timestamp selection | ✅ Implemented — needs a provider API key (see §8) |
| **Admin → AI Models & Keys**: per-provider encrypted API keys (OpenAI, Gemini, Claude, OpenRouter, DeepSeek, Groq, custom OpenAI-compatible, Azure Speech, eSpeak), key test, model discovery, per-model pricing & credit multiplier, task routing (vision / script / STT) with ordered fallbacks and automatic failover, default voice, optional user model choice, 30-day usage per model | ✅ Working |
| Optional dialogue transcription (Whisper API) | ✅ Implemented (optional) |
| Script editor: narration, timestamps, add/remove/reorder, clip preview | ✅ Working |
| Myanmar voiceover — **Gemini TTS (8 Burmese voices, same Gemini key)** or Azure Neural `my-MM-*`; speed, pitch, voice preview | ✅ Working (verified end-to-end with Gemini) |
| Dev voice — eSpeak NG Burmese (local testing only) | ✅ Working |
| Auto Myanmar subtitles: syllable-safe line breaks, timed to voice, editable text and timing, style, SRT export | ✅ Working |
| FFmpeg render: per-scene clips, blur-fill or crop, transitions, original-audio ducking, licensed music, loudness normalization, burned-in subtitles, H.264/AAC faststart | ✅ Working |
| Live progress (SSE + Redis pub/sub), cancel, retry, idempotent job creation | ✅ Working |
| **Auto-Pilot (one-click recap)**: upload → AI analysis → Burmese script → Gemini/Azure voice → subtitles → MP4 with no clicks; same credit reservations and limits per step; stops cleanly on failure/cancel/insufficient credits; user can edit and re-render afterwards | ✅ Working (verified: 72s source → 53s 9:16 recap) |
| Credits: estimate → reserve → settle/refund, ledger, monthly spending limit, plan quotas | ✅ Working |
| Stripe subscriptions + credit packs (Checkout, Billing Portal, signed idempotent webhooks) | ✅ Implemented — needs Stripe keys |
| Admin: stats, health, users, credits, plans and limits, jobs, takedowns, music library, audit log | ✅ Working |
| Copyright confirmation, takedown form, content removal, licensed-music library | ✅ Working |
| Security: hashed passwords (scrypt), httpOnly session cookies, CSRF origin check, Redis rate limits, zod validation, private signed URLs, ownership checks | ✅ Working |
| Ops: migrations, seed, retries/backoff, timeouts, stuck-job reaper, temp cleanup, purge, nightly DB backups, `/metrics`, Sentry-compatible error reports | ✅ Working |
| Docker images (api / worker / web), docker-compose, Caddy HTTPS, CI | ✅ Provided |
| Dark/light themes, mobile-responsive UI, loading/empty/error states | ✅ Working |

**Verified end-to-end in the dev sandbox:** register → create project → upload (59 MB) → validation → script → voiceover (eSpeak) → subtitles → real FFmpeg render (720×1280 and 1080×1920 MP4, Myanmar subtitles burned in) → range-request preview → download. Also verified: cancel with refund, failed-job refund, idempotent replays, CSRF block, SSE progress.

### Not yet implemented / next steps
- Myanmar-specific payment methods (KBZPay, WavePay). Stripe is integrated; local gateways can be added as another provider in `routes/billing.ts`.
- Email verification and password-reset email (needs an email provider such as Resend or SES).
- Multipart uploads for files over 5 GB (current single PUT supports up to the 2 GB configured limit).
- Per-segment re-render or preview proxies to speed up iteration on very long recaps.
- A Prometheus/Grafana dashboard JSON (the `/metrics` endpoint is ready).

---

## 2. Architecture

```
Browser ──HTTPS──► Caddy ──/api/*──► API (Node + Hono, REST, SSE) ──► PostgreSQL (Prisma)
                     │                   │  enqueue                    ▲
                     └──/*──► Next.js    ▼                             │
                                       Redis (BullMQ queue + pub/sub) ─┤
                                         │                             │
                                         ▼                             │
                               Video worker(s): FFmpeg/FFprobe ────────┘
                               LLM/vision API · Azure Speech · Whisper (opt)
                                         │
                                         ▼
                               Cloudflare R2 (private bucket, presigned URLs)
```

| Path | Purpose |
|---|---|
| `packages/core` | Shared library: Prisma schema and migrations, env validation, storage (R2/S3/local), queue, credits ledger, pricing, LLM client and prompts, Azure/eSpeak TTS, Myanmar subtitle engine, FFmpeg helpers and render-graph builder |
| `apps/api` | REST API (Hono on Node): auth, projects, uploads, jobs + SSE, billing (Stripe), admin, takedowns, metrics |
| `apps/worker` | BullMQ worker: `PROBE` → `ANALYZE` → `VOICEOVER` → `RENDER`, plus maintenance (temp cleanup, purge, stuck-job reaper, DB backups) |
| `apps/web` | Next.js 15 + TypeScript + Tailwind v4 UI |
| `docker/` | Multi-target Dockerfile, Caddyfile (prod and dev), API entrypoint (migrate + seed) |

### Job pipeline
1. **PROBE** — downloads the upload, runs `ffprobe`, rejects non-videos or too long/short/small files, creates a thumbnail.
2. **ANALYZE** — FFmpeg scene detection (`select=gt(scene,…)`) → scenes merged/split → up to 48 key frames → vision model describes each frame and scores its interest → (optional) Whisper transcript → LLM writes Burmese narration plus source timestamps as JSON. The output is validated: clamped to the video length, at least 70% Myanmar script, retried up to 3×.
3. **VOICEOVER** — synthesizes only changed segments (content hash of text + voice + rate + pitch), measures durations, then auto-builds subtitle cues.
4. **RENDER** — one normalized clip per segment → `xfade`/`acrossfade` transitions → voice tracks placed with `adelay`, original audio ducked, music looped with fades, `loudnorm` → ASS subtitles burned in with libass + Noto Sans Myanmar → H.264/AAC MP4 with `+faststart` → verified with ffprobe → uploaded to R2.

### Reliability
- **Idempotency:** each job carries a client `requestId` (unique DB key); the BullMQ job ID equals the DB job ID; credit ledger rows have unique idempotency keys; Stripe events are keyed by session/invoice.
- **Retries:** 3 attempts with exponential backoff. Permanent errors (bad input, provider auth) fail immediately.
- **Timeouts:** per-process FFmpeg timeouts plus a hard per-job timeout (`JOB_TIMEOUT_MIN`). A reaper fails and refunds jobs stuck after a worker crash.
- **Cancellation:** queued jobs are removed instantly; active jobs see the flag within 2 s and FFmpeg is killed. Credits are fully refunded.
- **Cleanup:** every job uses a private temp dir that is always deleted; stale dirs are swept every 30 min; abandoned uploads and deleted projects are purged.

---

## 3. Credits and cost control

| Action | Credits |
|---|---|
| AI analysis | 1 per source minute (min 2, max 40) |
| Myanmar voiceover | 1 per 400 characters (changed segments only) |
| Render | 3 per output minute (min 2) |

- The estimated cost is shown before every action. Credits are **reserved** when the job is created and **settled** when it completes. Failed or cancelled jobs are refunded 100%.
- Users can set a **monthly spending limit** (Billing page). Admins can set per-user limits.
- Plans (editable in Admin → Plans & limits) control: monthly credits, max upload MB, max video minutes, concurrent jobs, output resolution and watermark.
- Provider cost (LLM tokens, TTS characters, render minutes) is recorded per job in `UsageEvent` and shown in the admin dashboard.

---

## 4. Local development

Requirements: Node 20+, PostgreSQL 15+, Redis 7+, FFmpeg with libass/libx264, the Noto Sans Myanmar font (Debian: `fonts-noto-core`), optionally `espeak-ng`, and Caddy (for the single-origin dev proxy).

```bash
docker compose -f docker-compose.dev.yml up -d     # Postgres + Redis (or use local installs)
cp .env.example .env                               # then set: NODE_ENV=development, STORAGE_DRIVER=local,
                                                   #   LOCAL_STORAGE_DIR=./storage, WORK_DIR=./tmp,
                                                   #   DATABASE_URL, REDIS_URL, WEB_ORIGIN/API_PUBLIC_URL=http://localhost:3000
npm ci
npm run build:backend
(cd packages/core && npx prisma migrate deploy && node --env-file=../../.env dist/seed.js)
npm run build -w @recap/web && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/ && cp -r apps/web/public apps/web/.next/standalone/apps/web/
pm2 start ecosystem.config.cjs                     # api :4000, worker, web :3001, Caddy edge :3000
open http://localhost:3000
```

Use `TTS_PROVIDER=espeak` locally if you don't have an Azure key; production refuses to start with it.

### Testing
```bash
npm test          # core unit tests, API integration tests (real Postgres + Redis), worker tests incl. real FFmpeg render
```
44 tests cover: Myanmar syllable/subtitle chunking, ASS/SRT generation, render-graph math, pricing, SSML escaping, storage-key safety, production config guards, auth, ownership/permission isolation, input validation, CSRF, signed-URL tampering, idempotent job creation, credit reservation/refund, spending limits, insufficient balance, admin authorization, takedown validation, soft delete, scene detection, and a full FFmpeg render with transitions, voice mix and Myanmar subtitles.

---

## 5. Production deployment (Docker)

> **Own VPS + Cloudflare (step-by-step, one-command installer):** see [DEPLOY.md](DEPLOY.md) and `deploy/install.sh`.
> **From Windows PowerShell (easiest):** see [windows/README-WINDOWS.md](windows/README-WINDOWS.md) — `.\windows\deploy-vps.ps1`.


Recommended host: a Linux VM (Ubuntu 22.04+) with **≥ 4 vCPU / 8 GB RAM** for one API and two workers. Rendering is CPU-bound; add worker containers or hosts to scale.

### 5.1 External services
1. **Cloudflare R2:** create a private bucket (e.g. `recapai-media`) and an R2 API token with Object Read & Write. Add a **CORS rule** so browsers can upload directly:
   ```json
   [{ "AllowedOrigins": ["https://recap.example.com"], "AllowedMethods": ["PUT", "GET", "HEAD"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
   ```
2. **Azure AI Speech:** create a Speech resource in a region with `my-MM` neural voices (e.g. `southeastasia`) and copy the key and region. Admin → Overview → System health verifies the voices.
3. **LLM / vision:** any OpenAI-compatible endpoint with vision and good Burmese output (OpenAI `gpt-4o`/`gpt-4o-mini`, Gemini via its OpenAI-compatible endpoint, OpenRouter, …). Set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `VISION_MODEL`.
4. **Stripe (optional):** create Products/Prices for Creator/Pro and the credit packs, and paste the price IDs in Admin → Plans & limits. Add a webhook to `https://<domain>/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`.
5. **DNS:** point an A record for your domain to the server.

### 5.2 Deploy
```bash
git clone <repo> recapai && cd recapai
cp .env.example .env && nano .env        # set every "change-me" value + keys above
openssl rand -hex 32                     # → SESSION_SECRET
openssl rand -hex 32                     # → SECRETS_KEY (encrypts provider API keys; never change it)
docker compose up -d --build
docker compose logs -f api worker        # migrations + seed run automatically on API start
```
Open `https://<DOMAIN>` and log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Change that password immediately on the Account page.

### 5.3 Connect AI models (Admin → AI Models & Keys)
1. **Add provider key** → choose the provider (e.g. Google Gemini), paste the key, keep "Add recommended models" ticked → **Save & test**. The key is encrypted with `SECRETS_KEY` (AES-256-GCM); only a hint like `AIz…9xQ` is ever shown again.
2. **Myanmar voice — a Gemini key is enough (Azure optional).** Click **Recommended** on the Gemini card: it adds 8 natural Burmese Gemini TTS voices (Kore, Charon, Puck, Aoede, Fenrir, Leda, Orus, Sulafat), Gemini dialogue transcription and current chat models. Gemini TTS fails over across `gemini-3.1-flash-tts-preview → 2.5-flash-preview-tts → 3.8-flash-tts → …` when one hits its quota; speed/pitch are applied with FFmpeg and silence is trimmed for tight subtitle timing. Optionally add **Microsoft Azure AI Speech** (key + region) for `my-MM-NilarNeural` / `my-MM-ThihaNeural`. Users can preview every voice (▶) before choosing; the eSpeak dev voice is hidden automatically once a natural voice exists.
3. Optional: OpenAI or Groq **Whisper** for speech-to-text of original dialogue.
4. **Task routing**: pick a primary model and fallbacks for *Vision analysis*, *Burmese script writer* and *Speech-to-text*, and the default voice. If the primary fails (rate limit, outage, invalid key, no credit) the next model runs automatically; the job is only retried later if a failure was transient.
5. Per model: set prices (for provider-cost tracking), a **credit multiplier** (charge more credits for premium models), **User can pick** (shows the model in the project editor) and enable/disable. "Browse" lists every model the key can access.

Changes apply to new jobs within 15 seconds (API and worker cache the registry briefly).

Scale rendering: `docker compose up -d --scale worker=3`. Workers can also run on separate machines pointing at the same Postgres, Redis and R2.

Upgrade: `git pull && docker compose up -d --build`. Migrations apply automatically and workers drain gracefully (`stop_grace_period: 120s`).

### 5.3 Services and health
| Service | Port | Health |
|---|---|---|
| caddy | 80/443 | — |
| web | 3000 (internal) | `GET /` |
| api | 4000 (internal) | `GET /api/health` (DB + Redis) |
| worker | 4100 (internal) | `GET /` |
| metrics | via Caddy | `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN` |

### 5.4 Backups and restore
- With `BACKUP_ENABLED=true` the worker runs `pg_dump` nightly (`BACKUP_CRON`) and uploads to `backups/db/` in R2, keeping `BACKUP_RETENTION_DAYS`.
- Manual backup: `DATABASE_URL=... ./scripts/backup-db.sh ./backups`
- Restore: `DATABASE_URL=... ./scripts/restore-db.sh backups/recapai-<stamp>.sql.gz`
- Also enable R2 object versioning or lifecycle rules for media if desired.

### 5.5 Monitoring and logs
- Structured JSON logs (pino) from every service, with secrets redacted; Docker rotates them.
- Prometheus metrics: HTTP counts and latency, queue depth per state, failed jobs in the last hour, memory.
- Set `SENTRY_DSN` (Sentry or GlitchTip) to receive API and worker exceptions.
- Admin dashboard: jobs per day, failure rate, queue, revenue, provider cost, health of DB / Redis / LLM / TTS / storage / payments.

---

## 6. API overview (all JSON, cookie session; mutating requests require same-origin `Origin`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` | Account and session |
| GET/PATCH/DELETE | `/api/auth/me` | Profile, spending limit, delete account |
| POST | `/api/auth/change-password` | Change password (revokes other sessions) |
| GET/POST | `/api/projects` | List / create (copyright confirmation required) |
| GET/PATCH/DELETE | `/api/projects/:id` | Detail with signed media URLs and estimates / update settings / delete + purge files |
| PUT | `/api/projects/:id/segments` | Replace script (narration + timestamps) |
| PUT | `/api/projects/:id/subtitles` · POST `/subtitles/regenerate` · GET `/subtitles.srt` | Subtitle editing / auto-timing / export |
| POST | `/api/projects/:id/analyze` · `/voiceover` · `/render` | Start a job (`{ requestId }` for idempotency) |
| GET | `/api/projects/:id/download` | Short-lived signed MP4 download URL |
| POST | `/api/projects/:id/duplicate` | Copy settings and script |
| POST | `/api/uploads` · `/api/uploads/:assetId/complete` | Presigned upload → server-side validation |
| GET | `/api/jobs` · `/api/jobs/:id` · `/api/jobs/events` (SSE) | Job history and live progress |
| POST | `/api/jobs/:id/cancel` · `/retry` | Cancel / retry |
| GET | `/api/billing/summary` · POST `/checkout/subscription` · `/checkout/credits` · `/portal` · `/webhook` | Credits and Stripe |
| GET | `/api/config` · `/api/music` · POST `/api/takedown` | Public config, licensed music, DMCA form |
| * | `/api/admin/*` | Stats, health, users, credits, jobs, plans, packs, settings, reports, music, audit |
| GET/POST/PATCH/DELETE | `/api/admin/ai/providers[/:id]` · POST `/:id/test` · GET `/:id/discover` | Provider keys (write-only), key test, model discovery |
| GET/POST/PATCH/DELETE | `/api/admin/ai/models[/:id]` · POST `/:id/test` | Models; live test (chat JSON ping, voice sample, STT) |
| GET/PUT | `/api/admin/ai/routing` | Task routing + fallbacks, default voice, user model choice |

---

## 7. Data model (PostgreSQL / Prisma)
`User`, `Session`, `Plan`, `CreditPack`, `Subscription`, `Payment`, `CreditLedger` (append-only, idempotent), `Asset` (source / voice / render / thumbnail in R2), `Project`, `ScriptSegment`, `Subtitle`, `Job`, `UsageEvent`, `MusicTrack` (with license), `TakedownReport`, `AuditLog`, `SystemSetting` (incl. `aiRouting`), `AiProvider` (encrypted key), `AiModel` (kind CHAT / TTS_VOICE / STT, prices, credit multiplier). `UsageEvent.modelId` records which model ran.
Migrations live in `packages/core/prisma/migrations`. Create a new one with `npm run db:migrate -- --name <change>`.

---

## 8. Notes on AI providers
- All AI calls go through the model registry (`packages/core/src/ai/registry.ts`) and provider adapters (`ai/providers.ts`, `tts/index.ts`). Models configured in the Admin Console take precedence; env vars are a fallback.
- **The LLM key in the development sandbox is a free-plan proxy key and is rejected for API use.** The analysis job fails cleanly with a clear error and a full credit refund. With a valid key the same code path runs unchanged. The script editor also lets users write or paste narration manually.
- Burmese quality depends on the model; GPT-4o-class or Gemini 1.5/2.x models produce natural spoken Myanmar. Scripts with less than 70% Myanmar characters are automatically rejected and regenerated.
- Azure `my-MM` voices are Microsoft's officially supported Burmese neural voices. The provider interface (`packages/core/src/tts`) makes adding another verified Burmese TTS straightforward.

## 9. Legal
Templates for Terms, Privacy and Copyright/Takedown pages are included (`/terms`, `/privacy`, `/copyright`). **Have them reviewed by a lawyer for your jurisdiction before launch.** Only add music you are licensed to redistribute.
