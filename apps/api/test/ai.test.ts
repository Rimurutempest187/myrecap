import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { prisma, redis, jobQueue, runChatTask, invalidateAiCache } from '@recap/core';

const app = createApp();
const ORIGIN = 'http://localhost:3000';
const uid = `ai${Date.now().toString(36)}`;
let admin = '';
let user = '';
let server: http.Server;
let base = '';
const hits: Record<string, number> = {};
const geminiCalls: string[] = [];
let savedRouting: unknown = null;
const providerIds: string[] = [];

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (method !== 'GET') headers.origin = ORIGIN;
  const res = await app.request(path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

beforeAll(async () => {
  // Mock OpenAI-compatible server: /bad/* always 503, /good/* answers, /auth/* checks the bearer key.
  server = http.createServer((req, res) => {
    const kind = req.url!.split('/')[1];
    hits[kind] = (hits[kind] ?? 0) + 1;
    if (kind === 'bad') { res.writeHead(503); return res.end('overloaded'); }
    if (kind === 'gem') {
      // Fake Gemini native TTS: first TTS model is over quota, the fallback returns 1s of 24 kHz PCM.
      geminiCalls.push(req.url!);
      if (req.url!.includes('gemini-3.1-flash-tts-preview')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 429, message: 'quota per day', details: [{ retryDelay: '3600s' }] } }));
      }
      const pcm = Buffer.alloc(48000);
      for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(Math.sin((i / 24000) * 2 * Math.PI * 220) * 8000), i * 2);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] }));
    }
    if (kind === 'auth' && req.headers.authorization !== 'Bearer sk-correct-key-123') { res.writeHead(401); return res.end('bad key'); }
    if (req.url!.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-b' }] })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const a = await call('POST', '/api/auth/register', { body: { email: `adm-${uid}@test.dev`, password: 'Passw0rd!', name: 'adm', acceptTerms: true } });
  await prisma.user.update({ where: { id: a.json.user.id }, data: { role: 'ADMIN' } });
  admin = a.cookie!;
  const u = await call('POST', '/api/auth/register', { body: { email: `usr-${uid}@test.dev`, password: 'Passw0rd!', name: 'usr', acceptTerms: true } });
  user = u.cookie!;
  savedRouting = (await prisma.systemSetting.findUnique({ where: { key: 'aiRouting' } }))?.value ?? null;
});

afterAll(async () => {
  await prisma.aiProvider.deleteMany({ where: { id: { in: providerIds } } });
  if (savedRouting) await prisma.systemSetting.update({ where: { key: 'aiRouting' }, data: { value: savedRouting as any } });
  else await prisma.systemSetting.deleteMany({ where: { key: 'aiRouting' } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${uid}@test.dev` } } });
  server.close();
  await prisma.$disconnect();
  await jobQueue().close();
  redis().disconnect();
});

describe('admin AI providers & model routing', () => {
  let bad = '', good = '', authP = '';
  let badModel = '', goodModel = '';

  it('forbids non-admins', async () => {
    expect((await call('GET', '/api/admin/ai/providers', { cookie: user })).status).toBe(403);
  });

  it('stores keys encrypted and never returns them', async () => {
    const r = await call('POST', '/api/admin/ai/providers', { cookie: admin, body: { name: `Auth ${uid}`, kind: 'OPENAI_COMPATIBLE', baseUrl: `${base}/auth/v1`, apiKey: 'sk-correct-key-123' } });
    expect(r.status).toBe(201);
    authP = r.json.provider.id;
    providerIds.push(authP);
    expect(r.text).not.toContain('sk-correct-key-123');
    expect(r.json.provider.keyHint).toBe('sk-…-123');
    const row = await prisma.aiProvider.findUniqueOrThrow({ where: { id: authP } });
    expect(row.apiKeyEnc).toMatch(/^v1:/);
    expect(row.apiKeyEnc).not.toContain('correct');
    const list = await call('GET', '/api/admin/ai/providers', { cookie: admin });
    expect(list.text).not.toContain('sk-correct-key-123');
    expect(list.text).not.toContain(row.apiKeyEnc!);
  });

  it('tests keys and discovers models', async () => {
    const t = await call('POST', `/api/admin/ai/providers/${authP}/test`, { cookie: admin });
    expect(t.json.ok).toBe(true);
    const d = await call('GET', `/api/admin/ai/providers/${authP}/discover`, { cookie: admin });
    expect(d.json.items.map((i: any) => i.id)).toContain('mock-a');
    await call('PATCH', `/api/admin/ai/providers/${authP}`, { cookie: admin, body: { apiKey: 'sk-wrong-key-999' } });
    const t2 = await call('POST', `/api/admin/ai/providers/${authP}/test`, { cookie: admin });
    expect(t2.json.ok).toBe(false);
  });

  it('validates model capabilities', async () => {
    const az = await call('POST', '/api/admin/ai/providers', { cookie: admin, body: { name: `Az ${uid}`, kind: 'AZURE_SPEECH', apiKey: 'azkey-123456789', region: 'southeastasia' } });
    providerIds.push(az.json.provider.id);
    const r = await call('POST', '/api/admin/ai/models', { cookie: admin, body: { providerId: az.json.provider.id, kind: 'CHAT', modelId: 'x', displayName: 'x' } });
    expect(r.status).toBe(400);
  });

  it('fails over from a broken model to the next one and records which model ran', async () => {
    bad = (await call('POST', '/api/admin/ai/providers', { cookie: admin, body: { name: `Bad ${uid}`, kind: 'OPENAI_COMPATIBLE', baseUrl: `${base}/bad/v1` } })).json.provider.id;
    good = (await call('POST', '/api/admin/ai/providers', { cookie: admin, body: { name: `Good ${uid}`, kind: 'OPENAI_COMPATIBLE', baseUrl: `${base}/good/v1` } })).json.provider.id;
    providerIds.push(bad, good);
    badModel = (await call('POST', '/api/admin/ai/models', { cookie: admin, body: { providerId: bad, kind: 'CHAT', modelId: 'bad-1', displayName: `Bad ${uid}`, supportsVision: true, userSelectable: true } })).json.model.id;
    const gm = await call('POST', '/api/admin/ai/models', { cookie: admin, body: { providerId: good, kind: 'CHAT', modelId: 'good-1', displayName: `Good ${uid}`, inputUsdPer1M: 2, outputUsdPer1M: 8, creditMultiplier: 2, userSelectable: true } });
    goodModel = gm.json.model.id;

    // vision route cannot use a non-vision model
    const badRoute = await call('PUT', '/api/admin/ai/routing', { cookie: admin, body: { vision: { primary: goodModel, fallbacks: [] }, script: { primary: null, fallbacks: [] }, stt: { primary: null, fallbacks: [] }, defaultVoice: null, allowUserModelChoice: true } });
    expect(badRoute.status).toBe(400);

    const ok = await call('PUT', '/api/admin/ai/routing', { cookie: admin, body: { vision: { primary: badModel, fallbacks: [] }, script: { primary: badModel, fallbacks: [goodModel] }, stt: { primary: null, fallbacks: [] }, defaultVoice: null, allowUserModelChoice: true } });
    expect(ok.status).toBe(200);

    invalidateAiCache();
    const r = await runChatTask('script', [{ role: 'user', content: 'hi' }], { json: true });
    expect(r.run.modelId).toBe(goodModel);
    expect(r.run.attempts).toHaveLength(1);
    expect(r.run.attempts[0].error).toContain('503');
    expect(r.costUsd).toBeCloseTo(0.002 + 0.004);
    expect(hits.bad).toBeGreaterThan(0);
  });

  it('marks a run retryable only when a transient failure happened', async () => {
    await call('PUT', '/api/admin/ai/routing', { cookie: admin, body: { vision: { primary: badModel, fallbacks: [] }, script: { primary: badModel, fallbacks: [] }, stt: { primary: null, fallbacks: [] }, defaultVoice: null, allowUserModelChoice: true } });
    await call('PATCH', `/api/admin/ai/models/${goodModel}`, { cookie: admin, body: { enabled: false } });
    invalidateAiCache();
    const others = await prisma.aiModel.findMany({ where: { kind: 'CHAT', enabled: true, id: { notIn: [badModel] } } });
    if (others.length === 0) {
      await expect(runChatTask('script', [{ role: 'user', content: 'hi' }], { json: true })).rejects.toMatchObject({ retryable: true });
    }
    await call('PATCH', `/api/admin/ai/models/${goodModel}`, { cookie: admin, body: { enabled: true } });
  });

  it('exposes user-selectable models publicly and lets users pick them', async () => {
    invalidateAiCache();
    const cfg = await call('GET', '/api/config');
    const ids = cfg.json.aiModels.map((m: any) => m.id);
    expect(ids).toContain(goodModel);
    const p = await call('POST', '/api/projects', { cookie: user, body: { title: 'AI pick', recapType: 'MOVIE', copyrightConfirmed: true } });
    const ok = await call('PATCH', `/api/projects/${p.json.project.id}`, { cookie: user, body: { analysisModelId: goodModel } });
    expect(ok.status).toBe(200);
    expect(ok.json.project.analysisModelId).toBe(goodModel);
    expect((await call('PATCH', `/api/projects/${p.json.project.id}`, { cookie: user, body: { analysisModelId: 'nope' } })).status).toBe(400);
    // Disabling user choice hides models and rejects selection
    await call('PUT', '/api/admin/ai/routing', { cookie: admin, body: { vision: { primary: null, fallbacks: [] }, script: { primary: null, fallbacks: [] }, stt: { primary: null, fallbacks: [] }, defaultVoice: null, allowUserModelChoice: false } });
    invalidateAiCache();
    expect((await call('GET', '/api/config')).json.aiModels).toHaveLength(0);
    expect((await call('PATCH', `/api/projects/${p.json.project.id}`, { cookie: user, body: { analysisModelId: goodModel } })).status).toBe(400);
  });

  it('speaks Burmese with Gemini TTS (no Azure) and fails over across Gemini TTS models', async () => {
    const g = await call('POST', '/api/admin/ai/providers', { cookie: admin, body: { name: `Gem ${uid}`, kind: 'GEMINI', apiKey: 'AIza-test-key-0000', baseUrl: `${base}/gem/v1beta/openai` } });
    expect(g.status).toBe(201);
    providerIds.push(g.json.provider.id);
    const pr = await call('POST', `/api/admin/ai/providers/${g.json.provider.id}/presets`, { cookie: admin, body: { kinds: ['TTS_VOICE'] } });
    expect(pr.json.added).toBe(8);
    const voices = (await call('GET', '/api/admin/ai/models', { cookie: admin })).json.items.filter((m: any) => m.providerId === g.json.provider.id);
    const kore = voices.find((v: any) => v.modelId.endsWith(':Kore'));
    const t = await call('POST', `/api/admin/ai/models/${kore.id}/test`, { cookie: admin });
    expect(t.json.ok).toBe(true);
    expect(t.json.audio).toMatch(/^data:audio\/mpeg;base64,/);
    expect(geminiCalls[0]).toContain('gemini-3.1-flash-tts-preview');
    expect(geminiCalls.some((u) => u.includes('gemini-2.5-flash-preview-tts'))).toBe(true);
    // Public config now offers the Gemini voices
    invalidateAiCache();
    const cfg = await call('GET', '/api/config');
    expect(cfg.json.voices.some((v: any) => v.id === kore.id)).toBe(true);
    expect(cfg.json.voices.some((v: any) => v.engine === 'ESPEAK')).toBe(false);
  });

  it('clears project selections when a model is deleted', async () => {
    const p = await prisma.project.findFirst({ where: { analysisModelId: goodModel } });
    expect(p).not.toBeNull();
    expect((await call('DELETE', `/api/admin/ai/models/${goodModel}`, { cookie: admin })).status).toBe(200);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: p!.id } })).analysisModelId).toBeNull();
  });
});
