/**
 * AI model registry & routing.
 *
 * Admins add Providers (with encrypted API keys) and Models in the Admin Console, then assign
 * models to tasks (vision analysis, script writing, speech-to-text) with ordered fallbacks.
 * TTS voices are models of kind TTS_VOICE; users pick any enabled voice.
 *
 * If nothing is configured in the database, the registry falls back to the legacy env vars
 * (LLM_*, AZURE_SPEECH_*, STT_*) so existing deployments keep working.
 */
import { prisma, type AiModel, type AiProvider } from '../db.js';
import { env } from '../env.js';
import { decryptSecret } from '../secrets.js';
import { PROVIDER_DEFAULTS, chatWith, type ResolvedModel, type ResolvedProvider, type ChatOpts } from './providers.js';
import { LlmError, type ChatMessage, type ChatResult } from './llm.js';

export type AiTask = 'vision' | 'script' | 'stt';
export interface TaskRoute {
  primary: string | null; // AiModel.id
  fallbacks: string[];
}
export interface AiRouting {
  vision: TaskRoute;
  script: TaskRoute;
  stt: TaskRoute;
  defaultVoice: string | null;
  /** Let users choose the script model from userSelectable models */
  allowUserModelChoice: boolean;
}

export const EMPTY_ROUTING: AiRouting = {
  vision: { primary: null, fallbacks: [] },
  script: { primary: null, fallbacks: [] },
  stt: { primary: null, fallbacks: [] },
  defaultVoice: null,
  allowUserModelChoice: true,
};

const CACHE_MS = 15_000;
let cache: { at: number; models: ResolvedModel[]; routing: AiRouting } | null = null;

export function invalidateAiCache() {
  cache = null;
}

function resolveProvider(p: AiProvider): ResolvedProvider {
  let apiKey: string | null = null;
  try {
    apiKey = decryptSecret(p.apiKeyEnc);
  } catch {
    apiKey = null; // wrong SECRETS_KEY → treated as missing key
  }
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl || PROVIDER_DEFAULTS[p.kind].baseUrl || '',
    apiKey,
    region: p.region,
    config: (p.config as Record<string, unknown>) ?? {},
  };
}

export function resolveModel(m: AiModel & { provider: AiProvider }): ResolvedModel {
  return {
    id: m.id,
    kind: m.kind,
    modelId: m.modelId,
    displayName: m.displayName,
    supportsVision: m.supportsVision,
    jsonMode: m.jsonMode,
    maxOutputTokens: m.maxOutputTokens,
    inputUsdPer1M: m.inputUsdPer1M,
    outputUsdPer1M: m.outputUsdPer1M,
    unitUsdPer1M: m.unitUsdPer1M,
    creditMultiplier: m.creditMultiplier,
    config: (m.config as Record<string, unknown>) ?? {},
    provider: resolveProvider(m.provider),
  };
}

/** Virtual models built from env vars (legacy / bootstrap). IDs are prefixed with "env:". */
function envModels(): ResolvedModel[] {
  const e = env();
  const out: ResolvedModel[] = [];
  const base = { jsonMode: true, maxOutputTokens: null, unitUsdPer1M: 0, creditMultiplier: 1, config: {} };
  if (e.LLM_API_KEY) {
    const prov: ResolvedProvider = { id: 'env:llm', name: 'Env LLM', kind: 'OPENAI_COMPATIBLE', baseUrl: e.LLM_BASE_URL, apiKey: e.LLM_API_KEY, region: null, config: {} };
    out.push({ ...base, id: 'env:script', kind: 'CHAT', modelId: e.LLM_MODEL, displayName: `${e.LLM_MODEL} (env)`, supportsVision: true, inputUsdPer1M: e.LLM_INPUT_USD_PER_1M, outputUsdPer1M: e.LLM_OUTPUT_USD_PER_1M, provider: prov });
    if (e.VISION_MODEL && e.VISION_MODEL !== e.LLM_MODEL)
      out.push({ ...base, id: 'env:vision', kind: 'CHAT', modelId: e.VISION_MODEL, displayName: `${e.VISION_MODEL} (env)`, supportsVision: true, inputUsdPer1M: e.LLM_INPUT_USD_PER_1M, outputUsdPer1M: e.LLM_OUTPUT_USD_PER_1M, provider: prov });
  }
  if (e.STT_API_KEY && e.STT_BASE_URL) {
    const prov: ResolvedProvider = { id: 'env:stt', name: 'Env STT', kind: 'OPENAI_COMPATIBLE', baseUrl: e.STT_BASE_URL, apiKey: e.STT_API_KEY, region: null, config: {} };
    out.push({ ...base, id: 'env:stt', kind: 'STT', modelId: e.STT_MODEL, displayName: `${e.STT_MODEL} (env)`, supportsVision: false, inputUsdPer1M: 0, outputUsdPer1M: 0, unitUsdPer1M: e.STT_USD_PER_MIN, provider: prov });
  }
  if (e.TTS_PROVIDER === 'azure' && e.AZURE_SPEECH_KEY && e.AZURE_SPEECH_REGION) {
    const prov: ResolvedProvider = { id: 'env:azure', name: 'Env Azure Speech', kind: 'AZURE_SPEECH', baseUrl: '', apiKey: e.AZURE_SPEECH_KEY, region: e.AZURE_SPEECH_REGION, config: {} };
    for (const [v, label] of [['my-MM-NilarNeural', 'Nilar (နီလာ) — Female'], ['my-MM-ThihaNeural', 'Thiha (သီဟ) — Male']])
      out.push({ ...base, id: `env:${v}`, kind: 'TTS_VOICE', modelId: v, displayName: label, supportsVision: false, inputUsdPer1M: 0, outputUsdPer1M: 0, unitUsdPer1M: e.TTS_USD_PER_1M_CHARS, provider: prov });
  }
  if (e.TTS_PROVIDER === 'espeak') {
    const prov: ResolvedProvider = { id: 'env:espeak', name: 'eSpeak NG', kind: 'ESPEAK', baseUrl: '', apiKey: null, region: null, config: {} };
    out.push({ ...base, id: 'espeak-my', kind: 'TTS_VOICE', modelId: 'my', displayName: 'eSpeak NG Burmese (development only)', supportsVision: false, inputUsdPer1M: 0, outputUsdPer1M: 0, provider: prov });
  }
  return out;
}

async function load() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [rows, setting] = await Promise.all([
    prisma.aiModel.findMany({ where: { enabled: true, provider: { enabled: true } }, include: { provider: true }, orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }] }),
    prisma.systemSetting.findUnique({ where: { key: 'aiRouting' } }),
  ]);
  const dbModels = rows.map(resolveModel);
  const routing: AiRouting = { ...EMPTY_ROUTING, ...((setting?.value as Partial<AiRouting>) ?? {}) };
  // DB models take precedence; env models only fill kinds with nothing configured.
  const kinds = new Set(dbModels.map((m) => m.kind));
  const models = [...dbModels, ...envModels().filter((m) => !kinds.has(m.kind))];
  cache = { at: Date.now(), models, routing };
  return cache;
}

export async function getRouting(): Promise<AiRouting> {
  return (await load()).routing;
}

export async function listActiveModels(kind?: ResolvedModel['kind']) {
  const { models } = await load();
  return kind ? models.filter((m) => m.kind === kind) : models;
}

export async function getModel(id: string | null | undefined): Promise<ResolvedModel | null> {
  if (!id) return null;
  return (await load()).models.find((m) => m.id === id) ?? null;
}

/** Ordered candidate models for a task (primary → fallbacks → any other suitable enabled model). */
export async function modelsForTask(task: AiTask, preferredId?: string | null): Promise<ResolvedModel[]> {
  const { models, routing } = await load();
  const kind = task === 'stt' ? 'STT' : 'CHAT';
  const suitable = models.filter((m) => m.kind === kind && (task !== 'vision' || m.supportsVision));
  const route = routing[task];
  const order = [preferredId, route.primary, ...route.fallbacks].filter(Boolean) as string[];
  const picked: ResolvedModel[] = [];
  for (const id of order) {
    const m = suitable.find((x) => x.id === id);
    if (m && !picked.includes(m)) picked.push(m);
  }
  // If no explicit routing is set, use all suitable models in sort order.
  if (!picked.length) picked.push(...suitable);
  // Vision falls back to the script route if it is vision-capable (and vice versa).
  if (!picked.length && task === 'vision') return [];
  return picked;
}

export async function listVoices() {
  const { models, routing } = await load();
  const voices = models.filter((m) => m.kind === 'TTS_VOICE');
  const def = voices.find((v) => v.id === routing.defaultVoice) ?? voices[0] ?? null;
  return { voices, defaultVoiceId: def?.id ?? null };
}

export interface RunInfo {
  modelId: string;
  model: string;
  provider: string;
  attempts: Array<{ model: string; error: string }>;
}

/**
 * Run a chat completion against the task route with automatic failover.
 * Retryable failures (429/5xx/timeouts) and non-retryable provider errors (bad key, no credit)
 * both move to the next candidate; only when every candidate fails does it throw.
 */
export async function runChatTask(
  task: Exclude<AiTask, 'stt'>,
  messages: ChatMessage[],
  opts: Omit<ChatOpts, 'timeoutMs'> & { preferredModelId?: string | null; timeoutMs?: number; onUsage?: (m: ResolvedModel, r: ChatResult) => Promise<void> | void },
): Promise<ChatResult & { run: RunInfo }> {
  const candidates = await modelsForTask(task, opts.preferredModelId);
  if (!candidates.length) {
    throw new LlmError(
      task === 'vision'
        ? 'No vision-capable AI model is configured. An admin must add a provider key and a vision model in Admin → AI Models.'
        : 'No AI script model is configured. An admin must add a provider key and a chat model in Admin → AI Models.',
      undefined,
      false,
    );
  }
  const attempts: RunInfo['attempts'] = [];
  let anyRetryable = false;
  for (const m of candidates) {
    try {
      const r = await chatWith(m, messages, { ...opts, timeoutMs: opts.timeoutMs ?? env().LLM_TIMEOUT_MS });
      await opts.onUsage?.(m, r);
      return { ...r, run: { modelId: m.id, model: m.modelId, provider: m.provider.name, attempts } };
    } catch (err: any) {
      if (opts.signal?.aborted) throw err;
      if (!(err instanceof LlmError) || err.retryable) anyRetryable = true;
      attempts.push({ model: `${m.provider.name}/${m.modelId}`, error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  // Retry the whole job later only if at least one failure was transient (rate limit / 5xx / network).
  throw new LlmError(`All AI models failed for ${task}: ${attempts.map((a) => `${a.model} → ${a.error}`).join(' | ')}`, undefined, anyRetryable);
}
