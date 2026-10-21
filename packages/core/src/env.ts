import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool.optional(),

  // Storage
  STORAGE_DRIVER: z.enum(['r2', 's3', 'local']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  R2_ACCOUNT_ID: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().default(3600),

  // Upload limits (hard ceilings; plans may be lower)
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(2048),
  MAX_VIDEO_MINUTES: z.coerce.number().positive().default(180),
  ALLOWED_VIDEO_MIME: z.string().default('video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo'),

  // AI (OpenAI-compatible)
  LLM_BASE_URL: z.string().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  VISION_MODEL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(180000),
  LLM_INPUT_USD_PER_1M: z.coerce.number().default(0.15),
  LLM_OUTPUT_USD_PER_1M: z.coerce.number().default(0.6),
  ANALYSIS_MAX_FRAMES: z.coerce.number().int().positive().default(48),
  ANALYSIS_FRAMES_PER_CALL: z.coerce.number().int().positive().default(16),
  SCENE_THRESHOLD: z.coerce.number().default(0.32),

  // Speech-to-text (optional, OpenAI Whisper-compatible)
  STT_BASE_URL: z.string().optional(),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().default('whisper-1'),
  STT_USD_PER_MIN: z.coerce.number().default(0.006),

  // TTS
  TTS_PROVIDER: z.enum(['azure', 'espeak', 'none']).default('none'),
  AZURE_SPEECH_KEY: z.string().optional(),
  AZURE_SPEECH_REGION: z.string().optional(),
  TTS_USD_PER_1M_CHARS: z.coerce.number().default(16),
  ALLOW_DEV_TTS_IN_PRODUCTION: bool.default(false),

  // Worker / FFmpeg
  WORK_DIR: z.string().default('./tmp'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  FFMPEG_THREADS: z.coerce.number().int().min(0).default(0),
  FFMPEG_PRESET: z.string().default('veryfast'),
  SUBTITLE_FONT: z.string().default('Noto Sans Myanmar'),
  FONTS_DIR: z.string().default('/usr/share/fonts'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  JOB_TIMEOUT_MIN: z.coerce.number().positive().default(60),
  RENDER_USD_PER_MIN: z.coerce.number().default(0.01),
  TEMP_RETENTION_HOURS: z.coerce.number().positive().default(6),
  DELETED_PROJECT_PURGE_DAYS: z.coerce.number().positive().default(7),

  // Payments
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Signup
  SIGNUP_BONUS_CREDITS: z.coerce.number().int().min(0).default(30),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),

  // Observability / backups
  LOG_LEVEL: z.string().default('info'),
  SENTRY_DSN: z.string().optional(),
  BACKUP_ENABLED: bool.default(false),
  BACKUP_CRON: z.string().default('0 3 * * *'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  PG_DUMP_PATH: z.string().default('pg_dump'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests only */
export function resetEnvCache() {
  cached = null;
}

/** Production safety checks. Returns a list of fatal problems. */
export function productionConfigProblems(e: Env = env(), role: 'api' | 'worker' = 'api'): string[] {
  const p: string[] = [];
  if (e.NODE_ENV !== 'production') return p;
  if (e.STORAGE_DRIVER === 'local') p.push('STORAGE_DRIVER=local is not allowed in production; use r2 or s3');
  if (e.STORAGE_DRIVER !== 'local' && (!e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY || !e.S3_BUCKET))
    p.push('S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_BUCKET are required');
  if (e.STORAGE_DRIVER === 'r2' && !e.R2_ACCOUNT_ID && !e.S3_ENDPOINT) p.push('R2_ACCOUNT_ID (or S3_ENDPOINT) is required for r2');
  // AI provider keys are managed in Admin → AI Models (encrypted in DB); env keys are optional bootstrap.
  if (role === 'worker' && e.TTS_PROVIDER === 'espeak' && !e.ALLOW_DEV_TTS_IN_PRODUCTION)
    p.push('TTS_PROVIDER=espeak is a development voice; add Azure Speech (or another neural voice) in Admin → AI Models and set TTS_PROVIDER=none');
  if (e.SESSION_SECRET.length < 32) p.push('SESSION_SECRET must be at least 32 characters');
  if (!process.env.SECRETS_KEY || process.env.SECRETS_KEY.length < 32) p.push('SECRETS_KEY should be set (32+ chars) to encrypt AI provider API keys independently of SESSION_SECRET');
  return p;
}
