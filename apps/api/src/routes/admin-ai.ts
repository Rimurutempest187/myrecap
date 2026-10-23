/**
 * Admin → AI Models: manage provider API keys, models and task routing.
 * API keys are encrypted at rest (AES-256-GCM) and are never returned to the browser — only a hint.
 */
import { Hono } from 'hono';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  prisma,
  env,
  badRequest,
  notFound,
  encryptSecret,
  keyHint,
  invalidateAiCache,
  resolveModel,
  chatWith,
  discoverModels,
  testVoice,
  transcribeWith,
  getRouting,
  listActiveModels,
  PROVIDER_DEFAULTS,
  GEMINI_MY_VOICES,
  EMPTY_ROUTING,
  type AiRouting,
  type Prisma,
} from '@recap/core';
import { body, z } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import type { AppEnv } from '../lib/types.js';

export const adminAiRoutes = new Hono<AppEnv>();

const ProviderKind = z.enum(['OPENAI', 'GEMINI', 'ANTHROPIC', 'OPENROUTER', 'DEEPSEEK', 'GROQ', 'OPENAI_COMPATIBLE', 'AZURE_SPEECH', 'ESPEAK']);
const ModelKind = z.enum(['CHAT', 'TTS_VOICE', 'STT']);
type Kind = z.infer<typeof ProviderKind>;

/** Suggested models per provider so admins can add good defaults with one click. Prices are USD list prices (editable). */
export const MODEL_PRESETS: Record<Kind, Array<{ kind: 'CHAT' | 'TTS_VOICE' | 'STT'; modelId: string; displayName: string; supportsVision?: boolean; inputUsdPer1M?: number; outputUsdPer1M?: number; unitUsdPer1M?: number; description?: string }>> = {
  OPENAI: [
    { kind: 'CHAT', modelId: 'gpt-4o', displayName: 'GPT-4o', supportsVision: true, inputUsdPer1M: 2.5, outputUsdPer1M: 10, description: 'Strong vision + Burmese writing' },
    { kind: 'CHAT', modelId: 'gpt-4o-mini', displayName: 'GPT-4o mini', supportsVision: true, inputUsdPer1M: 0.15, outputUsdPer1M: 0.6, description: 'Fast and cheap' },
    { kind: 'STT', modelId: 'whisper-1', displayName: 'Whisper', unitUsdPer1M: 0.006, description: 'Speech-to-text for dialogue' },
    { kind: 'TTS_VOICE', modelId: 'gpt-4o-mini-tts:nova', displayName: 'OpenAI Nova (multilingual)', unitUsdPer1M: 15 },
  ],
  GEMINI: [
    { kind: 'CHAT', modelId: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', supportsVision: true, inputUsdPer1M: 0.3, outputUsdPer1M: 2.5, description: 'Fast, strong vision + natural Burmese scripts' },
    { kind: 'CHAT', modelId: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro', supportsVision: true, inputUsdPer1M: 1.25, outputUsdPer1M: 10, description: 'Best quality storytelling (slower)' },
    { kind: 'CHAT', modelId: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite', supportsVision: true, inputUsdPer1M: 0.1, outputUsdPer1M: 0.4, description: 'Cheapest, quick drafts' },
    { kind: 'STT', modelId: 'gemini-3.1-flash-lite', displayName: 'Gemini dialogue transcription', unitUsdPer1M: 0.002, description: 'Transcribes original dialogue (any language)' },
    ...GEMINI_MY_VOICES.map((v) => ({ kind: 'TTS_VOICE' as const, modelId: `gemini-3.1-flash-tts-preview:${v.voice}`, displayName: v.label, unitUsdPer1M: 20, description: v.description })),
  ],
  ANTHROPIC: [
    { kind: 'CHAT', modelId: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', supportsVision: true, inputUsdPer1M: 3, outputUsdPer1M: 15, description: 'Excellent storytelling' },
    { kind: 'CHAT', modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', supportsVision: true, inputUsdPer1M: 1, outputUsdPer1M: 5 },
  ],
  OPENROUTER: [
    { kind: 'CHAT', modelId: 'google/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash (OpenRouter)', supportsVision: true, inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
    { kind: 'CHAT', modelId: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini (OpenRouter)', supportsVision: true, inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  ],
  DEEPSEEK: [{ kind: 'CHAT', modelId: 'deepseek-chat', displayName: 'DeepSeek V3', inputUsdPer1M: 0.27, outputUsdPer1M: 1.1, description: 'Text-only script writer' }],
  GROQ: [
    { kind: 'CHAT', modelId: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B (Groq)', inputUsdPer1M: 0.59, outputUsdPer1M: 0.79 },
    { kind: 'STT', modelId: 'whisper-large-v3', displayName: 'Whisper large v3 (Groq)', unitUsdPer1M: 0.00185 },
  ],
  OPENAI_COMPATIBLE: [],
  AZURE_SPEECH: [
    { kind: 'TTS_VOICE', modelId: 'my-MM-NilarNeural', displayName: 'Nilar (နီလာ) — Female', unitUsdPer1M: 16, description: 'Natural Burmese neural voice' },
    { kind: 'TTS_VOICE', modelId: 'my-MM-ThihaNeural', displayName: 'Thiha (သီဟ) — Male', unitUsdPer1M: 16, description: 'Natural Burmese neural voice' },
  ],
  ESPEAK: [{ kind: 'TTS_VOICE', modelId: 'my', displayName: 'eSpeak NG Burmese (dev)', description: 'Robotic open-source voice for testing' }],
};

function publicProvider(p: Prisma.AiProviderGetPayload<{ include: { _count: { select: { models: true } } } }> | any) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    label: PROVIDER_DEFAULTS[p.kind as Kind].label,
    baseUrl: p.baseUrl,
    effectiveBaseUrl: p.baseUrl || PROVIDER_DEFAULTS[p.kind as Kind].baseUrl || null,
    hasKey: !!p.apiKeyEnc,
    keyHint: p.keyHint,
    region: p.region,
    enabled: p.enabled,
    lastTestAt: p.lastTestAt,
    lastTestOk: p.lastTestOk,
    lastTestMessage: p.lastTestMessage,
    models: p._count?.models ?? undefined,
    createdAt: p.createdAt,
  };
}

async function loadProvider(id: string) {
  const p = await prisma.aiProvider.findUnique({ where: { id } });
  if (!p) throw notFound('Provider not found');
  return p;
}

adminAiRoutes.get('/catalog', (c) =>
  c.json({
    providers: Object.entries(PROVIDER_DEFAULTS).map(([kind, d]) => ({ kind, ...d, presets: MODEL_PRESETS[kind as Kind] })),
    secretsKeyConfigured: !!process.env.SECRETS_KEY,
  }),
);

// ---------- Providers ----------
adminAiRoutes.get('/providers', async (c) => {
  const items = await prisma.aiProvider.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { models: true } } } });
  return c.json({ items: items.map(publicProvider) });
});

const providerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  kind: ProviderKind,
  baseUrl: z.string().url().max(300).nullable().optional().or(z.literal('')),
  apiKey: z.string().trim().max(500).optional(),
  region: z.string().trim().max(40).nullable().optional(),
  enabled: z.boolean().optional(),
  addPresets: z.boolean().optional(),
});

adminAiRoutes.post('/providers', async (c) => {
  const admin = c.get('user');
  const b = await body(c, providerSchema);
  const d = PROVIDER_DEFAULTS[b.kind];
  if (d.keyRequired && !b.apiKey) throw badRequest(`${d.label} requires an API key`);
  if (b.kind === 'OPENAI_COMPATIBLE' && !b.baseUrl) throw badRequest('Custom providers need a base URL (e.g. https://host/v1)');
  if (b.kind === 'AZURE_SPEECH' && !b.region) throw badRequest('Azure Speech needs a region (e.g. southeastasia)');
  const p = await prisma.aiProvider.create({
    data: {
      name: b.name,
      kind: b.kind,
      baseUrl: b.baseUrl || null,
      region: b.region || null,
      enabled: b.enabled ?? true,
      apiKeyEnc: b.apiKey ? encryptSecret(b.apiKey) : null,
      keyHint: b.apiKey ? keyHint(b.apiKey) : null,
    },
  });
  if (b.addPresets) {
    const presets = MODEL_PRESETS[b.kind];
    await prisma.aiModel.createMany({
      data: presets.map((m, i) => ({ providerId: p.id, ...m, sortOrder: i, userSelectable: m.kind === 'CHAT' })),
      skipDuplicates: true,
    });
  }
  invalidateAiCache();
  await audit(c, admin.id, 'admin.ai.provider.create', 'aiProvider', p.id, { kind: b.kind, name: b.name });
  return c.json({ provider: publicProvider(p) }, 201);
});

adminAiRoutes.patch('/providers/:id', async (c) => {
  const admin = c.get('user');
  const p = await loadProvider(c.req.param('id'));
  const b = await body(c, providerSchema.omit({ kind: true, addPresets: true }).partial().extend({ clearKey: z.boolean().optional() }));
  const data: Prisma.AiProviderUpdateInput = {};
  if (b.name !== undefined) data.name = b.name;
  if (b.baseUrl !== undefined) data.baseUrl = b.baseUrl || null;
  if (b.region !== undefined) data.region = b.region || null;
  if (b.enabled !== undefined) data.enabled = b.enabled;
  if (b.apiKey) {
    data.apiKeyEnc = encryptSecret(b.apiKey);
    data.keyHint = keyHint(b.apiKey);
    data.lastTestOk = null;
    data.lastTestMessage = null;
  } else if (b.clearKey) {
    data.apiKeyEnc = null;
    data.keyHint = null;
  }
  const u = await prisma.aiProvider.update({ where: { id: p.id }, data });
  invalidateAiCache();
  await audit(c, admin.id, 'admin.ai.provider.update', 'aiProvider', p.id, { fields: Object.keys(b).filter((k) => k !== 'apiKey'), keyRotated: !!b.apiKey });
  return c.json({ provider: publicProvider(u) });
});

adminAiRoutes.delete('/providers/:id', async (c) => {
  const admin = c.get('user');
  const p = await loadProvider(c.req.param('id'));
  await prisma.aiProvider.delete({ where: { id: p.id } });
  invalidateAiCache();
  await audit(c, admin.id, 'admin.ai.provider.delete', 'aiProvider', p.id, { name: p.name });
  return c.json({ ok: true });
});

function providerResolved(p: Awaited<ReturnType<typeof loadProvider>>) {
  // Reuse the registry resolver via a throwaway model wrapper.
  return resolveModel({
    id: 'probe', providerId: p.id, kind: 'CHAT', modelId: '', displayName: '', supportsVision: false, jsonMode: false, maxOutputTokens: null,
    inputUsdPer1M: 0, outputUsdPer1M: 0, unitUsdPer1M: 0, creditMultiplier: 1, userSelectable: false, enabled: true, sortOrder: 0,
    config: null, description: null, createdAt: new Date(), updatedAt: new Date(), provider: p,
  }).provider;
}

/** Validate the key by listing models (cheap, no tokens spent). */
adminAiRoutes.post('/providers/:id/test', async (c) => {
  const p = await loadProvider(c.req.param('id'));
  let ok = false;
  let message = '';
  try {
    const found = await discoverModels(providerResolved(p));
    ok = true;
    message = `Key OK — ${found.length} model(s)/voice(s) available`;
  } catch (e: any) {
    message = String(e?.message ?? e).slice(0, 300);
  }
  const u = await prisma.aiProvider.update({ where: { id: p.id }, data: { lastTestAt: new Date(), lastTestOk: ok, lastTestMessage: message } });
  return c.json({ ok, message, provider: publicProvider(u) });
});

/** Add the recommended models for this provider (skips ones already added). */
adminAiRoutes.post('/providers/:id/presets', async (c) => {
  const admin = c.get('user');
  const p = await loadProvider(c.req.param('id'));
  const b = await body(c, z.object({ kinds: z.array(ModelKind).optional() }).default({}));
  const presets = MODEL_PRESETS[p.kind].filter((m) => !b.kinds || b.kinds.includes(m.kind));
  const existing = await prisma.aiModel.count({ where: { providerId: p.id } });
  const r = await prisma.aiModel.createMany({
    data: presets.map((m, i) => ({ providerId: p.id, ...m, sortOrder: existing + i, userSelectable: m.kind === 'CHAT' })),
    skipDuplicates: true,
  });
  // If there is no default voice yet (or only the dev voice), use the first new neural voice.
  const routing = await getRouting();
  const firstVoice = await prisma.aiModel.findFirst({ where: { providerId: p.id, kind: 'TTS_VOICE', enabled: true }, orderBy: { sortOrder: 'asc' } });
  if (firstVoice) {
    const cur = routing.defaultVoice ? await prisma.aiModel.findUnique({ where: { id: routing.defaultVoice }, include: { provider: true } }) : null;
    if (!cur || cur.provider.kind === 'ESPEAK') {
      const next = { ...routing, defaultVoice: firstVoice.id };
      await prisma.systemSetting.upsert({ where: { key: 'aiRouting' }, create: { key: 'aiRouting', value: next as any }, update: { value: next as any } });
    }
  }
  invalidateAiCache();
  await audit(c, admin.id, 'admin.ai.presets.add', 'aiProvider', p.id, { added: r.count });
  return c.json({ added: r.count });
});

adminAiRoutes.get('/providers/:id/discover', async (c) => {
  const p = await loadProvider(c.req.param('id'));
  try {
    const found = await discoverModels(providerResolved(p));
    const existing = await prisma.aiModel.findMany({ where: { providerId: p.id }, select: { kind: true, modelId: true } });
    const have = new Set(existing.map((e) => `${e.kind}:${e.modelId}`));
    return c.json({ items: found.slice(0, 500).map((f) => ({ ...f, added: have.has(`${f.kind}:${f.id}`) })) });
  } catch (e: any) {
    throw badRequest(`Could not list models: ${String(e?.message ?? e).slice(0, 300)}`);
  }
});

// ---------- Models ----------
adminAiRoutes.get('/models', async (c) => {
  const [items, usage] = await Promise.all([
    prisma.aiModel.findMany({ include: { provider: { select: { id: true, name: true, kind: true, enabled: true } } }, orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { displayName: 'asc' }] }),
    prisma.usageEvent.groupBy({ by: ['modelId'], where: { modelId: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, _sum: { costUsd: true }, _count: true }),
  ]);
  const u = new Map(usage.map((x) => [x.modelId, { calls30d: x._count, cost30dUsd: Math.round((x._sum.costUsd ?? 0) * 1000) / 1000 }]));
  const active = await listActiveModels();
  const envModels = active.filter((m) => m.id.startsWith('env:') || m.id === 'espeak-my').map((m) => ({ id: m.id, kind: m.kind, modelId: m.modelId, displayName: m.displayName, provider: m.provider.name, supportsVision: m.supportsVision }));
  return c.json({ items: items.map((m) => ({ ...m, ...(u.get(m.id) ?? { calls30d: 0, cost30dUsd: 0 }) })), envModels });
});

const modelSchema = z.object({
  providerId: z.string().min(1).max(40),
  kind: ModelKind,
  modelId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(120),
  supportsVision: z.boolean().optional(),
  jsonMode: z.boolean().optional(),
  maxOutputTokens: z.number().int().min(256).max(200_000).nullable().optional(),
  inputUsdPer1M: z.number().min(0).max(1000).optional(),
  outputUsdPer1M: z.number().min(0).max(1000).optional(),
  unitUsdPer1M: z.number().min(0).max(10_000).optional(),
  creditMultiplier: z.number().min(0.1).max(20).optional(),
  userSelectable: z.boolean().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  description: z.string().max(300).nullable().optional(),
});

adminAiRoutes.post('/models', async (c) => {
  const admin = c.get('user');
  const b = await body(c, modelSchema);
  const p = await loadProvider(b.providerId);
  if (!PROVIDER_DEFAULTS[p.kind].capabilities.includes(b.kind)) throw badRequest(`${PROVIDER_DEFAULTS[p.kind].label} does not support ${b.kind}`);
  const exists = await prisma.aiModel.findFirst({ where: { providerId: p.id, kind: b.kind, modelId: b.modelId } });
  if (exists) throw badRequest('This model is already added for the provider');
  const m = await prisma.aiModel.create({ data: b });
  invalidateAiCache();
  await audit(c, admin.id, 'admin.ai.model.create', 'aiModel', m.id, { modelId: b.modelId, kind: b.kind });
  return c.json({ model: m }, 201);
});

adminAiRoutes.patch('/models/:id', async (c) => {
  const admin = c.get('user');
  const b = await body(c, modelSchema.omit({ providerId: true, kind: true }).partial());
  const m = await prisma.aiModel.update({ where: { id: c.req.param('id') }, data: b }).catch(() => {
    throw notFound('Model not found');
  });
  invalidateAiCache();
  await audit(c, admin.id, 'admin.ai.model.update', 'aiModel', m.id, b as any);
  return c.json({ model: m });
});

adminAiRoutes.delete('/models/:id', async (c) => {
  const admin = c.get('user');
  const m = await prisma.aiModel.delete({ where: { id: c.req.param('id') } }).catch(() => {
    throw notFound('Model not found');
  });
  // Clear user selections pointing at the deleted model.
  await prisma.project.updateMany({ where: { analysisModelId: m.id }, data: { analysisModelId: null } });
  invalidateAiCache();
  await audit(c, admin.id, 'admin.ai.model.delete', 'aiModel', m.id, { modelId: m.modelId });
  return c.json({ ok: true });
});

function runCmd(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300)))));
  });
}

/** Live test: chat ping (with JSON), voice sample (returns audio), or STT on a short generated clip. */
adminAiRoutes.post('/models/:id/test', async (c) => {
  const row = await prisma.aiModel.findUnique({ where: { id: c.req.param('id') }, include: { provider: true } });
  if (!row) throw notFound('Model not found');
  const m = resolveModel(row);
  const t0 = Date.now();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aitest-'));
  try {
    if (m.kind === 'CHAT') {
      const r = await chatWith(
        m,
        [
          { role: 'system', content: 'Reply with JSON only.' },
          { role: 'user', content: 'Return {"ok":true,"greeting":"<a one-sentence Burmese greeting in Myanmar Unicode>"}' },
        ],
        { json: m.jsonMode, maxTokens: 2048, timeoutMs: 60_000 },
      );
      return c.json({ ok: true, ms: Date.now() - t0, output: r.text.slice(0, 400), usage: { input: r.inputTokens, output: r.outputTokens } });
    }
    if (m.kind === 'TTS_VOICE') {
      const f = path.join(dir, 'v.mp3');
      await testVoice(m, f);
      const bytes = await readFile(f);
      return c.json({ ok: true, ms: Date.now() - t0, audio: `data:audio/mpeg;base64,${bytes.toString('base64')}` });
    }
    // STT: generate a 2-second tone clip and make sure the endpoint accepts it.
    const f = path.join(dir, 's.mp3');
    await runCmd(env().FFMPEG_PATH, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', '-b:a', '64k', f]);
    const r = await transcribeWith(m, 's.mp3', new Uint8Array(await readFile(f)));
    return c.json({ ok: true, ms: Date.now() - t0, output: `Transcription endpoint OK (${r.segments.length} segment(s))` });
  } catch (e: any) {
    return c.json({ ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 500) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- Routing ----------
const routeSchema = z.object({ primary: z.string().max(80).nullable(), fallbacks: z.array(z.string().max(80)).max(5) });

adminAiRoutes.get('/routing', async (c) => {
  const row = await prisma.systemSetting.findUnique({ where: { key: 'aiRouting' } });
  return c.json({ routing: { ...EMPTY_ROUTING, ...((row?.value as Partial<AiRouting>) ?? {}) } });
});

adminAiRoutes.put('/routing', async (c) => {
  const admin = c.get('user');
  const b = await body(
    c,
    z.object({ vision: routeSchema, script: routeSchema, stt: routeSchema, defaultVoice: z.string().max(80).nullable(), allowUserModelChoice: z.boolean() }),
  );
  invalidateAiCache();
  const active = await listActiveModels();
  const byId = new Map(active.map((m) => [m.id, m]));
  const check = (task: 'vision' | 'script' | 'stt', r: z.infer<typeof routeSchema>) => {
    for (const id of [r.primary, ...r.fallbacks].filter(Boolean) as string[]) {
      const m = byId.get(id);
      if (!m) throw badRequest(`${task}: model ${id} is not enabled`);
      if (task === 'stt' ? m.kind !== 'STT' : m.kind !== 'CHAT') throw badRequest(`${task}: ${m.displayName} is the wrong model type`);
      if (task === 'vision' && !m.supportsVision) throw badRequest(`vision: ${m.displayName} does not support images`);
    }
    return { primary: r.primary, fallbacks: [...new Set(r.fallbacks.filter((f) => f && f !== r.primary))] };
  };
  const routing: AiRouting = {
    vision: check('vision', b.vision),
    script: check('script', b.script),
    stt: check('stt', b.stt),
    defaultVoice: b.defaultVoice,
    allowUserModelChoice: b.allowUserModelChoice,
  };
  if (b.defaultVoice && byId.get(b.defaultVoice)?.kind !== 'TTS_VOICE') throw badRequest('Default voice must be an enabled voice');
  await prisma.systemSetting.upsert({ where: { key: 'aiRouting' }, create: { key: 'aiRouting', value: routing as any }, update: { value: routing as any } });
  invalidateAiCache();
  await audit(c, admin.id, 'admin.ai.routing.update', 'systemSetting', 'aiRouting', routing as any);
  return c.json({ routing: await getRouting() });
});
