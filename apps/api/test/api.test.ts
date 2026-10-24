import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma, redis, jobQueue } from '@recap/core';

const app = createApp();
const ORIGIN = 'http://localhost:3000';
const uid = Date.now().toString(36);

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  else if (method !== 'GET') headers.origin = ORIGIN;
  const res = await app.request(path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function register(name: string) {
  const r = await call('POST', '/api/auth/register', { body: { email: `${name}-${uid}@test.dev`, password: 'Passw0rd!', name, acceptTerms: true } });
  expect(r.status).toBe(201);
  return { cookie: r.cookie!, user: r.json.user };
}

let alice: { cookie: string; user: any };
let bob: { cookie: string; user: any };
let projectId: string;

beforeAll(async () => {
  alice = await register('alice');
  bob = await register('bob');
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${uid}@test.dev` } } });
  await prisma.$disconnect();
  await jobQueue().close();
  redis().disconnect();
});

describe('auth', () => {
  it('rejects weak passwords and missing terms', async () => {
    const r = await call('POST', '/api/auth/register', { body: { email: `weak-${uid}@test.dev`, password: 'short', name: 'x', acceptTerms: true } });
    expect(r.status).toBe(400);
    const r2 = await call('POST', '/api/auth/register', { body: { email: `noterms-${uid}@test.dev`, password: 'Passw0rd!', name: 'x', acceptTerms: false } });
    expect(r2.status).toBe(400);
  });
  it('grants signup bonus credits with a ledger entry', async () => {
    expect(alice.user.creditBalance).toBeGreaterThan(0);
    const l = await prisma.creditLedger.findMany({ where: { userId: alice.user.id } });
    expect(l.some((x) => x.reason === 'SIGNUP_BONUS')).toBe(true);
  });
  it('rejects duplicate email and bad login', async () => {
    const d = await call('POST', '/api/auth/register', { body: { email: `alice-${uid}@test.dev`, password: 'Passw0rd!', name: 'a', acceptTerms: true } });
    expect(d.status).toBe(409);
    const l = await call('POST', '/api/auth/login', { body: { email: `alice-${uid}@test.dev`, password: 'wrongpass1' } });
    expect(l.status).toBe(401);
  });
  it('returns null user when anonymous and requires auth for projects', async () => {
    expect((await call('GET', '/api/auth/me')).json.user).toBeNull();
    expect((await call('GET', '/api/projects')).status).toBe(401);
  });
  it('blocks cross-origin state-changing requests (CSRF)', async () => {
    const r = await call('POST', '/api/projects', { cookie: alice.cookie, origin: 'https://evil.example', body: {} });
    expect(r.status).toBe(403);
  });
});

describe('projects & permissions', () => {
  it('requires copyright confirmation', async () => {
    const r = await call('POST', '/api/projects', { cookie: alice.cookie, body: { title: 'x', recapType: 'MOVIE', copyrightConfirmed: false } });
    expect(r.status).toBe(400);
  });
  it('requires instructions for custom recaps', async () => {
    const r = await call('POST', '/api/projects', { cookie: alice.cookie, body: { title: 'x', recapType: 'CUSTOM', copyrightConfirmed: true } });
    expect(r.status).toBe(400);
  });
  it('creates a project with sensible defaults', async () => {
    const r = await call('POST', '/api/projects', { cookie: alice.cookie, body: { title: 'ကမ္ဘာ', recapType: 'SHORTS', copyrightConfirmed: true } });
    expect(r.status).toBe(201);
    expect(r.json.project.aspectRatio).toBe('9:16');
    expect(r.json.project.copyrightConfirmed).toBe(true);
    projectId = r.json.project.id;
  });
  it("prevents other users from reading or modifying someone else's project", async () => {
    expect((await call('GET', `/api/projects/${projectId}`, { cookie: bob.cookie })).status).toBe(404);
    expect((await call('PATCH', `/api/projects/${projectId}`, { cookie: bob.cookie, body: { title: 'hack' } })).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${projectId}`, { cookie: bob.cookie })).status).toBe(404);
  });
  it('validates settings input', async () => {
    expect((await call('PATCH', `/api/projects/${projectId}`, { cookie: alice.cookie, body: { voiceRate: 5 } })).status).toBe(400);
    expect((await call('PATCH', `/api/projects/${projectId}`, { cookie: alice.cookie, body: { transition: 'explode' } })).status).toBe(400);
    expect((await call('PATCH', `/api/projects/${projectId}`, { cookie: alice.cookie, body: { voiceName: 'en-US-Fake' } })).status).toBe(400);
    expect((await call('PATCH', `/api/projects/${projectId}`, { cookie: alice.cookie, body: { subtitleStyle: { primaryColor: 'red' } } })).status).toBe(400);
  });
  it('rejects disallowed upload types and oversize files', async () => {
    const t = await call('POST', '/api/uploads', { cookie: alice.cookie, body: { projectId, filename: 'x.exe', mimeType: 'application/x-msdownload', sizeBytes: 100 } });
    expect(t.status).toBe(400);
    const s = await call('POST', '/api/uploads', { cookie: alice.cookie, body: { projectId, filename: 'x.mp4', mimeType: 'video/mp4', sizeBytes: 50 * 1024 * 1024 * 1024 } });
    expect(s.status).toBe(400);
  });
  it('issues a signed upload URL and rejects tampered signatures', async () => {
    const r = await call('POST', '/api/uploads', { cookie: alice.cookie, body: { projectId, filename: 'x.mp4', mimeType: 'video/mp4', sizeBytes: 10 } });
    expect(r.status).toBe(200);
    const u = new URL(r.json.upload.url);
    u.searchParams.set('sig', '00'.repeat(32));
    const res = await app.request(u.pathname + u.search, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body: '0123456789' });
    expect(res.status).toBe(403);
  });
  it('accepts chunked uploads (Cloudflare 100 MB limit), resyncs bad offsets and assembles the file', async () => {
    const data = Buffer.alloc(30_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const r = await call('POST', '/api/uploads', { cookie: alice.cookie, body: { projectId, filename: 'c.mp4', mimeType: 'video/mp4', sizeBytes: data.length } });
    expect(r.status).toBe(200);
    const u = new URL(r.json.upload.url);
    const put = (offset: number, chunk: Buffer) =>
      app.request(`${u.pathname}${u.search}&offset=${offset}`, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(chunk.length) }, body: chunk });
    const a = await put(0, data.subarray(0, 12_000));
    expect((await a.json()).received).toBe(12_000);
    // out-of-order chunk → 409 with the expected offset
    const bad = await put(24_000, data.subarray(24_000));
    expect(bad.status).toBe(409);
    expect((await bad.json()).expected).toBe(12_000);
    await put(12_000, data.subarray(12_000, 24_000));
    const last = await (await put(24_000, data.subarray(24_000))).json();
    expect(last).toEqual({ received: 30_000, complete: true });
    const done = await call('POST', `/api/uploads/${r.json.assetId}/complete`, { cookie: alice.cookie, body: { projectId } });
    expect(done.status).toBe(200);
    const { storage } = await import('@recap/core');
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: r.json.assetId } });
    expect((await storage().head(asset.storageKey))?.size).toBe(30_000);
    await prisma.job.deleteMany({ where: { projectId, type: 'PROBE' } }).catch(() => undefined);
  });
  it('cannot analyze without a validated video', async () => {
    const r = await call('POST', `/api/projects/${projectId}/analyze`, { cookie: alice.cookie, body: { requestId: 'req-12345678' } });
    expect(r.status).toBe(400);
  });
  it('saves and validates script segments', async () => {
    const bad = await call('PUT', `/api/projects/${projectId}/segments`, { cookie: alice.cookie, body: { segments: [{ sourceStart: 5, sourceEnd: 2, narration: 'x' }] } });
    expect(bad.status).toBe(400);
    const ok = await call('PUT', `/api/projects/${projectId}/segments`, { cookie: alice.cookie, body: { segments: [{ sourceStart: 0, sourceEnd: 5, narration: 'မင်္ဂလာပါ။' }] } });
    expect(ok.status).toBe(200);
    const d = await call('GET', `/api/projects/${projectId}`, { cookie: alice.cookie });
    expect(d.json.project.status).toBe('SCRIPT_READY');
    expect(d.json.estimates.voiceover.credits).toBeGreaterThanOrEqual(1);
  });
  it('refuses to render without voiceover', async () => {
    const r = await call('POST', `/api/projects/${projectId}/render`, { cookie: alice.cookie, body: { requestId: 'req-render-1' } });
    expect(r.status).toBe(400);
  });
});

describe('credits, idempotency & spending limits', () => {
  it('reserves credits once per idempotency key and refunds on cancel', async () => {
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } })).creditBalance;
    const r1 = await call('POST', `/api/projects/${projectId}/voiceover`, { cookie: alice.cookie, body: { requestId: 'idem-voice-1' } });
    expect(r1.status).toBe(202);
    const r2 = await call('POST', `/api/projects/${projectId}/voiceover`, { cookie: alice.cookie, body: { requestId: 'idem-voice-1' } });
    expect(r2.status).toBe(200);
    expect(r2.json.job.id).toBe(r1.json.job.id);
    const mid = (await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } })).creditBalance;
    expect(mid).toBe(before - r1.json.job.creditsReserved);
    // a second, different job for the same project is rejected while one is active
    const r3 = await call('POST', `/api/projects/${projectId}/voiceover`, { cookie: alice.cookie, body: { requestId: 'idem-voice-2' } });
    expect([409, 429]).toContain(r3.status);
    // bob cannot cancel alice's job
    expect((await call('POST', `/api/jobs/${r1.json.job.id}/cancel`, { cookie: bob.cookie })).status).toBe(404);
    // remove from the queue before a worker picks it up, then cancel
    const c = await call('POST', `/api/jobs/${r1.json.job.id}/cancel`, { cookie: alice.cookie });
    expect(c.status).toBe(200);
    // wait for finalization (queued → immediate; active → worker)
    for (let i = 0; i < 40; i++) {
      const j = await prisma.job.findUniqueOrThrow({ where: { id: r1.json.job.id } });
      if (['CANCELLED', 'COMPLETED', 'FAILED'].includes(j.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const j = await prisma.job.findUniqueOrThrow({ where: { id: r1.json.job.id } });
    const after = (await prisma.user.findUniqueOrThrow({ where: { id: alice.user.id } })).creditBalance;
    if (j.status === 'CANCELLED' || j.status === 'FAILED') expect(after).toBe(before);
    else expect(after).toBe(before - j.creditsCharged);
  });

  it('enforces the monthly spending limit', async () => {
    await call('PATCH', '/api/auth/me', { cookie: bob.cookie, body: { monthlyCreditLimit: 0 } });
    const p = await call('POST', '/api/projects', { cookie: bob.cookie, body: { title: 'b', recapType: 'MOVIE', copyrightConfirmed: true } });
    await call('PUT', `/api/projects/${p.json.project.id}/segments`, { cookie: bob.cookie, body: { segments: [{ sourceStart: 0, sourceEnd: 5, narration: 'စမ်းသပ်ချက်။' }] } });
    const r = await call('POST', `/api/projects/${p.json.project.id}/voiceover`, { cookie: bob.cookie, body: { requestId: 'limit-test-1' } });
    expect(r.status).toBe(402);
    expect(r.json.error.message).toMatch(/spending limit/i);
  });

  it('blocks jobs when the balance is insufficient', async () => {
    await prisma.user.update({ where: { id: bob.user.id }, data: { creditBalance: 0, monthlyCreditLimit: null } });
    const p = await prisma.project.findFirstOrThrow({ where: { userId: bob.user.id } });
    const r = await call('POST', `/api/projects/${p.id}/voiceover`, { cookie: bob.cookie, body: { requestId: 'nobal-test-1' } });
    expect(r.status).toBe(402);
  });
});

describe('admin & moderation', () => {
  it('forbids non-admins from admin APIs', async () => {
    expect((await call('GET', '/api/admin/stats', { cookie: alice.cookie })).status).toBe(403);
  });
  it('accepts valid takedown reports and rejects incomplete ones', async () => {
    const bad = await call('POST', '/api/takedown', { body: { reporterName: 'R', reporterEmail: 'r@x.dev', rightsHolder: 'Studio', description: 'short', swornStatement: true } });
    expect(bad.status).toBe(400);
    const ok = await call('POST', '/api/takedown', { body: { reporterName: 'Rights Owner', reporterEmail: `r-${uid}@test.dev`, rightsHolder: 'Studio X', projectId, description: 'This recap uses our film without a license agreement.', swornStatement: true } });
    expect(ok.status).toBe(201);
    await prisma.takedownReport.delete({ where: { id: ok.json.id } });
  });
  it('soft-deletes projects for the owner', async () => {
    const r = await call('DELETE', `/api/projects/${projectId}`, { cookie: alice.cookie });
    expect(r.status).toBe(200);
    expect((await call('GET', `/api/projects/${projectId}`, { cookie: alice.cookie })).status).toBe(404);
  });
});
