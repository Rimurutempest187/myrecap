import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  prisma,
  applyCredits,
  notFound,
  badRequest,
  queueStats,
  storage,
  keys,
  listActiveModels,
  getRouting,
  requestCancel,

  env,
  type Prisma,
} from '@recap/core';
import { body, z } from '../lib/validate.js';
import { requireAdmin } from '../lib/auth.js';
import { publicJob, publicUser, publicPlan } from '../lib/serialize.js';
import { audit } from '../lib/audit.js';
import type { AppEnv } from '../lib/types.js';
import { adminAiRoutes } from './admin-ai.js';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireAdmin);
adminRoutes.route('/ai', adminAiRoutes);

adminRoutes.get('/stats', async (c) => {
  const since30 = new Date(Date.now() - 30 * 86400_000);
  const since1 = new Date(Date.now() - 86400_000);
  const [users, newUsers, projects, jobs24, failed24, renders30, revenue, cost30, queue, openReports, jobsByType] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: since30 } } }),
    prisma.project.count({ where: { deletedAt: null } }),
    prisma.job.count({ where: { createdAt: { gte: since1 } } }),
    prisma.job.count({ where: { createdAt: { gte: since1 }, status: 'FAILED' } }),
    prisma.job.count({ where: { createdAt: { gte: since30 }, type: 'RENDER', status: 'COMPLETED' } }),
    prisma.payment.aggregate({ where: { status: 'PAID', createdAt: { gte: since30 } }, _sum: { amountCents: true } }),
    prisma.usageEvent.aggregate({ where: { createdAt: { gte: since30 } }, _sum: { costUsd: true } }),
    queueStats().catch(() => null),
    prisma.takedownReport.count({ where: { status: { in: ['OPEN', 'REVIEWING'] } } }),
    prisma.job.groupBy({ by: ['type', 'status'], where: { createdAt: { gte: since30 } }, _count: true }),
  ]);
  const daily = await prisma.$queryRaw<Array<{ day: Date; jobs: bigint; credits: bigint | null }>>`
    SELECT date_trunc('day', "createdAt") AS day, count(*) AS jobs, sum("creditsCharged") AS credits
    FROM "Job" WHERE "createdAt" >= ${since30} GROUP BY 1 ORDER BY 1`;
  return c.json({
    users,
    newUsers30d: newUsers,
    projects,
    jobs24h: jobs24,
    failed24h: failed24,
    renders30d: renders30,
    revenue30dCents: revenue._sum.amountCents ?? 0,
    providerCost30dUsd: Math.round((cost30._sum.costUsd ?? 0) * 100) / 100,
    queue,
    openReports,
    jobsByType: jobsByType.map((j) => ({ type: j.type, status: j.status, count: j._count })),
    daily: daily.map((d) => ({ day: d.day, jobs: Number(d.jobs), credits: Number(d.credits ?? 0) })),
  });
});

adminRoutes.get('/health', async (c) => {
  const [db, q, models, routing, providers] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    queueStats().then(() => true).catch(() => false),
    listActiveModels(),
    getRouting(),
    prisma.aiProvider.findMany({ select: { name: true, enabled: true, lastTestOk: true } }),
  ]);
  const chat = models.filter((m) => m.kind === 'CHAT');
  const voices = models.filter((m) => m.kind === 'TTS_VOICE');
  const neural = voices.filter((v) => v.provider.kind !== 'ESPEAK');
  return c.json({
    db,
    redis: q,
    ai: {
      chatModels: chat.length,
      visionModels: chat.filter((m) => m.supportsVision).length,
      sttModels: models.filter((m) => m.kind === 'STT').length,
      voices: voices.length,
      neuralVoices: neural.length,
      providers: providers.length,
      failingProviders: providers.filter((p) => p.enabled && p.lastTestOk === false).map((p) => p.name),
      routed: { vision: !!routing.vision.primary, script: !!routing.script.primary, stt: !!routing.stt.primary },
    },
    tts: { ok: voices.length > 0, provider: neural.length ? 'neural' : voices.length ? 'espeak' : 'none', detail: voices.length ? `${voices.length} voice(s), ${neural.length} neural` : 'No voices configured — add Azure Speech or OpenAI TTS in AI Models' },
    llmConfigured: chat.length > 0,
    storage: env().STORAGE_DRIVER,
    payments: !!env().STRIPE_SECRET_KEY,
  });
});

adminRoutes.get('/users', async (c) => {
  const q = c.req.query();
  const where: Prisma.UserWhereInput = q.q
    ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }] }
    : {};
  const take = Math.min(100, Number(q.limit) || 50);
  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, include: { plan: true, _count: { select: { projects: true, jobs: true } } }, orderBy: { createdAt: 'desc' }, take, skip: Number(q.offset) || 0 }),
    prisma.user.count({ where }),
  ]);
  return c.json({ items: items.map((u) => ({ ...publicUser(u), lastLoginAt: u.lastLoginAt, projects: u._count.projects, jobs: u._count.jobs })), total });
});

adminRoutes.patch('/users/:id', async (c) => {
  const admin = c.get('user');
  const b = await body(
    c,
    z.object({
      role: z.enum(['USER', 'ADMIN']).optional(),
      status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
      planId: z.string().nullable().optional(),
      monthlyCreditLimit: z.number().int().min(0).nullable().optional(),
    }),
  );
  if (c.req.param('id') === admin.id && (b.role === 'USER' || b.status === 'SUSPENDED')) throw badRequest('You cannot demote or suspend yourself');
  const u = await prisma.user.update({ where: { id: c.req.param('id') }, data: b, include: { plan: true } });
  if (b.status === 'SUSPENDED') await prisma.session.deleteMany({ where: { userId: u.id } });
  await audit(c, admin.id, 'admin.user.update', 'user', u.id, b as any);
  return c.json({ user: publicUser(u) });
});

adminRoutes.post('/users/:id/credits', async (c) => {
  const admin = c.get('user');
  const b = await body(c, z.object({ delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0), note: z.string().min(3).max(200), requestId: z.string().min(8).max(64) }));
  const target = await prisma.user.findUnique({ where: { id: c.req.param('id') } });
  if (!target) throw notFound('User not found');
  const row = await prisma.$transaction((tx) =>
    applyCredits(tx, { userId: target.id, delta: b.delta, reason: 'ADMIN_ADJUST', idempotencyKey: `admin:${b.requestId}`, note: `${b.note} (by ${admin.email})` }),
  );
  await audit(c, admin.id, 'admin.credits.adjust', 'user', target.id, { delta: b.delta, note: b.note });
  return c.json({ balance: row.balanceAfter });
});

adminRoutes.get('/jobs', async (c) => {
  const q = c.req.query();
  const where: Prisma.JobWhereInput = {};
  if (q.status) where.status = q.status as any;
  if (q.type) where.type = q.type as any;
  const items = await prisma.job.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, Number(q.limit) || 50),
    include: { user: { select: { email: true } }, project: { select: { title: true } } },
  });
  return c.json({ items: items.map((j) => ({ ...publicJob(j), userEmail: j.user.email, projectTitle: j.project?.title, actualCostUsd: j.actualCostUsd })) });
});

adminRoutes.post('/jobs/:id/cancel', async (c) => {
  const job = await prisma.job.findUnique({ where: { id: c.req.param('id') } });
  if (!job) throw notFound('Job not found');
  await requestCancel(job.id, job.userId);
  await audit(c, c.get('user').id, 'admin.job.cancel', 'job', job.id);
  return c.json({ ok: true });
});

// ---- Plans & credit packs (configurable limits) ----
const planSchema = z.object({
  code: z.string().regex(/^[a-z0-9_-]{2,30}$/),
  name: z.string().min(1).max(60),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3).default('usd'),
  monthlyCredits: z.number().int().min(0),
  maxUploadMb: z.number().int().min(10).max(20000),
  maxVideoMinutes: z.number().int().min(1).max(600),
  maxConcurrentJobs: z.number().int().min(1).max(20),
  maxOutputHeight: z.number().int().refine((n) => [480, 720, 1080].includes(n), 'Must be 480, 720 or 1080'),
  watermark: z.boolean(),
  stripePriceId: z.string().nullable().optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  features: z.array(z.string().max(120)).max(20).default([]),
});

adminRoutes.get('/plans', async (c) => {
  const plans = await prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } });
  const packs = await prisma.creditPack.findMany({ orderBy: { credits: 'asc' } });
  return c.json({ plans: plans.map((p) => ({ ...publicPlan(p), stripePriceId: p.stripePriceId, active: p.active, sortOrder: p.sortOrder })), packs });
});

adminRoutes.post('/plans', async (c) => {
  const b = await body(c, planSchema);
  const p = await prisma.plan.create({ data: b });
  await audit(c, c.get('user').id, 'admin.plan.create', 'plan', p.id);
  return c.json({ plan: p }, 201);
});

adminRoutes.patch('/plans/:id', async (c) => {
  const b = await body(c, planSchema.partial());
  const p = await prisma.plan.update({ where: { id: c.req.param('id') }, data: b });
  await audit(c, c.get('user').id, 'admin.plan.update', 'plan', p.id, b as any);
  return c.json({ plan: p });
});

adminRoutes.post('/packs', async (c) => {
  const b = await body(c, z.object({ name: z.string().min(1).max(60), credits: z.number().int().positive(), priceCents: z.number().int().positive(), stripePriceId: z.string().nullable().optional(), active: z.boolean().default(true) }));
  const p = await prisma.creditPack.create({ data: b });
  return c.json({ pack: p }, 201);
});

adminRoutes.patch('/packs/:id', async (c) => {
  const b = await body(c, z.object({ name: z.string().min(1).max(60).optional(), credits: z.number().int().positive().optional(), priceCents: z.number().int().positive().optional(), stripePriceId: z.string().nullable().optional(), active: z.boolean().optional() }));
  const p = await prisma.creditPack.update({ where: { id: c.req.param('id') }, data: b });
  return c.json({ pack: p });
});

adminRoutes.get('/settings', async (c) => {
  const s = await prisma.systemSetting.findMany();
  return c.json({ settings: Object.fromEntries(s.map((x) => [x.key, x.value])) });
});

adminRoutes.put('/settings/limits', async (c) => {
  const b = await body(c, z.object({ signupBonusCredits: z.number().int().min(0).max(10000), maintenanceMode: z.boolean() }));
  await prisma.systemSetting.upsert({ where: { key: 'limits' }, create: { key: 'limits', value: b }, update: { value: b } });
  await audit(c, c.get('user').id, 'admin.settings.limits', 'setting', 'limits', b);
  return c.json({ ok: true });
});

// ---- Takedown reports & content moderation ----
adminRoutes.get('/reports', async (c) => {
  const items = await prisma.takedownReport.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  return c.json({ items });
});

adminRoutes.patch('/reports/:id', async (c) => {
  const b = await body(c, z.object({ status: z.enum(['OPEN', 'REVIEWING', 'ACTIONED', 'REJECTED']), resolutionNote: z.string().max(2000).optional(), removeContent: z.boolean().default(false) }));
  const r = await prisma.takedownReport.findUnique({ where: { id: c.req.param('id') } });
  if (!r) throw notFound('Report not found');
  if (b.removeContent && r.projectId) {
    const p = await prisma.project.findUnique({ where: { id: r.projectId } });
    if (p) {
      await storage().deletePrefix(keys.projectPrefix(p.userId, p.id)).catch(() => undefined);
      if (p.sourceAssetId) {
        const s = await prisma.asset.findUnique({ where: { id: p.sourceAssetId } });
        if (s) await storage().delete(s.storageKey).catch(() => undefined);
      }
      await prisma.project.update({ where: { id: p.id }, data: { deletedAt: new Date(), lastError: 'Removed due to a copyright complaint' } });
    }
  }
  const updated = await prisma.takedownReport.update({
    where: { id: r.id },
    data: { status: b.status, resolutionNote: b.resolutionNote, resolvedAt: ['ACTIONED', 'REJECTED'].includes(b.status) ? new Date() : null },
  });
  await audit(c, c.get('user').id, 'admin.report.update', 'report', r.id, b as any);
  return c.json({ report: updated });
});

// ---- Licensed music library ----
adminRoutes.post('/music', async (c) => {
  const b = await body(
    c,
    z.object({
      title: z.string().min(1).max(120),
      artist: z.string().min(1).max(120),
      license: z.string().min(2).max(120),
      licenseUrl: z.string().url().optional(),
      mood: z.string().max(40).optional(),
      sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
    }),
  );
  const t = await prisma.musicTrack.create({ data: { title: b.title, artist: b.artist, license: b.license, licenseUrl: b.licenseUrl, mood: b.mood, storageKey: `pending-${Date.now()}`, durationSec: 0, active: false } });
  const key = keys.music(t.id);
  await prisma.musicTrack.update({ where: { id: t.id }, data: { storageKey: key } });
  const upload = await storage().presignUpload(key, 'audio/mpeg', b.sizeBytes);
  return c.json({ trackId: t.id, upload }, 201);
});

adminRoutes.post('/music/:id/complete', async (c) => {
  const t = await prisma.musicTrack.findUnique({ where: { id: c.req.param('id') } });
  if (!t) throw notFound();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'music-'));
  try {
    const f = path.join(dir, 'm.mp3');
    await storage().downloadToFile(t.storageKey, f);
    const { audioDuration } = await import('@recap/core');
    const d = await audioDuration(f);
    const updated = await prisma.musicTrack.update({ where: { id: t.id }, data: { durationSec: d, active: true } });
    return c.json({ track: updated });
  } catch (e: any) {
    throw badRequest(`Invalid audio file: ${e.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

adminRoutes.patch('/music/:id', async (c) => {
  const b = await body(c, z.object({ active: z.boolean() }));
  const t = await prisma.musicTrack.update({ where: { id: c.req.param('id') }, data: b });
  return c.json({ track: t });
});

adminRoutes.get('/audit', async (c) => {
  const items = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { actor: { select: { email: true } } } });
  return c.json({ items: items.map((a) => ({ ...a, actorEmail: a.actor?.email })) });
});


