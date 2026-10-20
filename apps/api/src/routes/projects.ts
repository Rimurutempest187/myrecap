import { Hono } from 'hono';
import {
  prisma,
  storage,
  env,
  badRequest,
  notFound,
  conflict,
  createJob,
  voiceHash,
  estimateAnalyzeCredits,
  estimateAnalyzeUsd,
  estimateVoiceCredits,
  estimateVoiceUsd,
  estimateRenderCredits,
  estimateRenderUsd,
  computeTimeline,
  buildSrt,
  isValidVoice,
  availableVoices,
  TRANSITIONS,
  MY_CHARS_PER_SEC,
  keys,
  type Prisma,
} from '@recap/core';
import { body, z } from '../lib/validate.js';
import { requireAuth, clientIp } from '../lib/auth.js';
import { rateLimit } from '../lib/rateLimit.js';
import { effectivePlan } from '../lib/plan.js';
import { publicAsset, publicJob, publicProject } from '../lib/serialize.js';
import { audit } from '../lib/audit.js';
import type { AppEnv } from '../lib/types.js';

const RATIO = { '9:16': 'R9_16', '16:9': 'R16_9', '1:1': 'R1_1' } as const;
const RecapType = z.enum(['ANIME', 'MOVIE', 'SHORTS', 'HIGHLIGHTS', 'CUSTOM']);

const subtitleStyleSchema = z
  .object({
    fontSize: z.number().min(24).max(120).optional(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    boxed: z.boolean().optional(),
    position: z.enum(['bottom', 'middle', 'top']).optional(),
  })
  .strict();

const settingsSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  recapType: RecapType.optional(),
  aspectRatio: z.enum(['9:16', '16:9', '1:1']).optional(),
  fitMode: z.enum(['blur', 'crop']).optional(),
  customPrompt: z.string().max(2000).nullable().optional(),
  targetDurationSec: z.number().int().min(15).max(1200).optional(),
  voiceName: z.string().max(80).optional(),
  voiceRate: z.number().min(0.5).max(2).optional(),
  voicePitch: z.number().int().min(-50).max(50).optional(),
  originalAudioVolume: z.number().min(0).max(1).optional(),
  musicTrackId: z.string().nullable().optional(),
  musicVolume: z.number().min(0).max(1).optional(),
  transition: z.enum(TRANSITIONS).optional(),
  subtitleStyle: subtitleStyleSchema.nullable().optional(),
  subtitlesEnabled: z.boolean().optional(),
});

const BUSY = ['ANALYZING', 'VOICING', 'RENDERING'];

export const projectRoutes = new Hono<AppEnv>();
projectRoutes.use('*', requireAuth);

async function ownProject(userId: string, id: string) {
  const p = await prisma.project.findFirst({ where: { id, userId, deletedAt: null } });
  if (!p) throw notFound('Project not found');
  return p;
}

function toData(b: z.infer<typeof settingsSchema>): Prisma.ProjectUpdateInput {
  const { aspectRatio, subtitleStyle, musicTrackId, ...rest } = b;
  const d: Prisma.ProjectUpdateInput = { ...rest };
  if (aspectRatio) d.aspectRatio = RATIO[aspectRatio];
  if (subtitleStyle !== undefined) d.subtitleStyle = subtitleStyle === null ? (null as any) : subtitleStyle;
  if (musicTrackId !== undefined) d.musicTrackId = musicTrackId;
  return d;
}

async function validateSettings(b: z.infer<typeof settingsSchema>) {
  if (b.voiceName && !isValidVoice(b.voiceName)) throw badRequest(`Unknown voice ${b.voiceName}`);
  if (b.musicTrackId) {
    const m = await prisma.musicTrack.findFirst({ where: { id: b.musicTrackId, active: true } });
    if (!m) throw badRequest('Unknown music track');
  }
  if (b.recapType === 'CUSTOM' && b.customPrompt !== undefined && !b.customPrompt?.trim()) {
    throw badRequest('Custom recap requires instructions');
  }
}

projectRoutes.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query();
  const take = Math.min(50, Math.max(1, Number(q.limit) || 20));
  const where: Prisma.ProjectWhereInput = { userId: user.id, deletedAt: null };
  if (q.status) where.status = q.status as any;
  if (q.q) where.title = { contains: q.q.slice(0, 100), mode: 'insensitive' };
  const [items, total] = await Promise.all([
    prisma.project.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: Math.max(0, Number(q.offset) || 0) }),
    prisma.project.count({ where }),
  ]);
  const thumbIds = items.map((p) => p.thumbnailAssetId).filter(Boolean) as string[];
  const thumbs = await prisma.asset.findMany({ where: { id: { in: thumbIds } } });
  const thumbMap = new Map<string, string>();
  for (const t of thumbs) thumbMap.set(t.id, await storage().presignDownload(t.storageKey, { inline: true }));
  return c.json({
    items: items.map((p) => ({ ...publicProject(p), thumbnailUrl: p.thumbnailAssetId ? thumbMap.get(p.thumbnailAssetId) ?? null : null })),
    total,
  });
});

projectRoutes.post('/', rateLimit({ name: 'project-create', limit: 60, windowSec: 3600, by: 'user' }), async (c) => {
  const user = c.get('user');
  const b = await body(
    c,
    settingsSchema.extend({
      title: z.string().trim().min(1).max(120),
      recapType: RecapType,
      copyrightConfirmed: z.literal(true, { message: 'You must confirm you have the rights to use this video' }),
    }),
  );
  const { copyrightConfirmed, ...settings } = b;
  await validateSettings(settings);
  if (settings.recapType === 'CUSTOM' && !settings.customPrompt?.trim()) throw badRequest('Custom recap requires instructions');
  const defaults: Record<string, number> = { SHORTS: 50, HIGHLIGHTS: 90, ANIME: 180, MOVIE: 240, CUSTOM: 120 };
  const data = toData(settings) as Prisma.ProjectCreateInput;
  const project = await prisma.project.create({
    data: {
      ...(data as any),
      title: settings.title,
      recapType: settings.recapType,
      aspectRatio: settings.aspectRatio ? RATIO[settings.aspectRatio] : settings.recapType === 'SHORTS' ? 'R9_16' : 'R16_9',
      targetDurationSec: settings.targetDurationSec ?? defaults[settings.recapType],
      voiceName: settings.voiceName ?? availableVoices()[0].id,
      user: { connect: { id: user.id } },
      copyrightConfirmedAt: new Date(),
      copyrightIp: clientIp(c),
    },
  });
  await audit(c, user.id, 'project.create', 'project', project.id, { copyrightConfirmed });
  return c.json({ project: publicProject(project) }, 201);
});

projectRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  const [segments, subtitles, jobs, source, output, thumb] = await Promise.all([
    prisma.scriptSegment.findMany({ where: { projectId: p.id }, orderBy: { idx: 'asc' } }),
    prisma.subtitle.findMany({ where: { projectId: p.id }, orderBy: { idx: 'asc' } }),
    prisma.job.findMany({ where: { projectId: p.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    p.sourceAssetId ? prisma.asset.findUnique({ where: { id: p.sourceAssetId } }) : null,
    p.outputAssetId ? prisma.asset.findUnique({ where: { id: p.outputAssetId } }) : null,
    p.thumbnailAssetId ? prisma.asset.findUnique({ where: { id: p.thumbnailAssetId } }) : null,
  ]);
  const st = storage();
  const sourceUrl = source && source.status === 'READY' ? await st.presignDownload(source.storageKey, { inline: true }) : null;
  const outputUrl = output && output.status === 'READY' ? await st.presignDownload(output.storageKey, { inline: true }) : null;
  const thumbnailUrl = thumb ? await st.presignDownload(thumb.storageKey, { inline: true }) : null;
  const segOut = await Promise.all(
    segments.map(async (s) => ({
      id: s.id,
      idx: s.idx,
      sourceStart: s.sourceStart,
      sourceEnd: s.sourceEnd,
      narration: s.narration,
      sceneNote: s.sceneNote,
      audioDurationSec: s.audioDurationSec,
      audioUrl: s.audioKey ? await st.presignDownload(s.audioKey, { inline: true }) : null,
      voiceStale: !!s.audioKey && s.audioTextHash !== voiceHash(s.narration, p.voiceName, p.voiceRate, p.voicePitch),
    })),
  );
  return c.json({
    project: publicProject(p),
    source: publicAsset(source),
    sourceUrl,
    output: publicAsset(output),
    outputUrl,
    thumbnailUrl,
    segments: segOut,
    subtitles: subtitles.map((s) => ({ id: s.id, idx: s.idx, segmentIdx: s.segmentIdx, startSec: s.startSec, endSec: s.endSec, text: s.text })),
    jobs: jobs.map(publicJob),
    estimates: await estimates(p.id),
  });
});

async function estimates(projectId: string) {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const source = p.sourceAssetId ? await prisma.asset.findUnique({ where: { id: p.sourceAssetId } }) : null;
  const segs = await prisma.scriptSegment.findMany({ where: { projectId } });
  const pending = segs.filter((s) => !s.audioKey || s.audioTextHash !== voiceHash(s.narration, p.voiceName, p.voiceRate, p.voicePitch));
  const chars = pending.reduce((a, s) => a + Array.from(s.narration).length, 0);
  const allChars = segs.reduce((a, s) => a + Array.from(s.narration).length, 0);
  const outDur = segs.length
    ? computeTimeline(
        segs.map((s) => ({ idx: s.idx, audioDurationSec: s.audioDurationSec ?? Array.from(s.narration).length / (MY_CHARS_PER_SEC * p.voiceRate) })),
      ).reduce((a, t) => a + t.duration, 0)
    : p.targetDurationSec;
  return {
    analyze: source?.durationSec ? { credits: estimateAnalyzeCredits(source.durationSec), usd: round(estimateAnalyzeUsd(source.durationSec)) } : null,
    voiceover: segs.length ? { credits: chars ? estimateVoiceCredits(chars) : 0, usd: round(estimateVoiceUsd(chars)), chars, totalChars: allChars, pendingSegments: pending.length } : null,
    render: segs.length ? { credits: estimateRenderCredits(outDur), usd: round(estimateRenderUsd(outDur)), outputDurationSec: Math.round(outDur) } : null,
  };
}
const round = (n: number) => Math.round(n * 10000) / 10000;

projectRoutes.get('/:id/estimate', async (c) => {
  const p = await ownProject(c.get('user').id, c.req.param('id'));
  return c.json(await estimates(p.id));
});

projectRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  const b = await body(c, settingsSchema);
  await validateSettings(b);
  if (BUSY.includes(p.status) && (b.voiceName || b.voiceRate || b.aspectRatio || b.recapType)) {
    throw conflict('Settings are locked while a job is running');
  }
  const updated = await prisma.project.update({ where: { id: p.id }, data: toData(b) });
  return c.json({ project: publicProject(updated) });
});

/** Replace the full script (edit narration, timestamps, add/remove/reorder segments). */
projectRoutes.put('/:id/segments', async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  if (BUSY.includes(p.status)) throw conflict('Script is locked while a job is running');
  const source = p.sourceAssetId ? await prisma.asset.findUnique({ where: { id: p.sourceAssetId } }) : null;
  const dur = source?.durationSec ?? 0;
  const b = await body(
    c,
    z.object({
      segments: z
        .array(
          z.object({
            sourceStart: z.number().min(0),
            sourceEnd: z.number().positive(),
            narration: z.string().trim().min(1).max(2000),
            sceneNote: z.string().max(300).nullable().optional(),
          }),
        )
        .min(1)
        .max(120),
    }),
  );
  for (const [i, s] of b.segments.entries()) {
    if (s.sourceEnd <= s.sourceStart) throw badRequest(`Segment ${i + 1}: end must be after start`);
    if (dur && s.sourceStart >= dur) throw badRequest(`Segment ${i + 1}: start is beyond the video length (${dur.toFixed(1)}s)`);
  }
  const existing = await prisma.scriptSegment.findMany({ where: { projectId: p.id }, orderBy: { idx: 'asc' } });
  await prisma.$transaction(async (tx) => {
    await tx.subtitle.deleteMany({ where: { projectId: p.id } });
    await tx.scriptSegment.deleteMany({ where: { projectId: p.id } });
    await tx.scriptSegment.createMany({
      data: b.segments.map((s, i) => {
        // keep voice audio if narration unchanged (match by text)
        const prev = existing.find((e) => e.narration.trim() === s.narration.trim() && e.audioKey);
        return {
          projectId: p.id,
          idx: i,
          sourceStart: s.sourceStart,
          sourceEnd: dur ? Math.min(s.sourceEnd, dur) : s.sourceEnd,
          narration: s.narration,
          sceneNote: s.sceneNote ?? null,
          audioKey: prev?.audioKey ?? null,
          audioDurationSec: prev?.audioDurationSec ?? null,
          audioTextHash: prev?.audioTextHash ?? null,
        };
      }),
    });
    const voicedAll = b.segments.every((s) =>
      existing.some((e) => e.narration.trim() === s.narration.trim() && e.audioTextHash === voiceHash(s.narration, p.voiceName, p.voiceRate, p.voicePitch)),
    );
    await tx.project.update({ where: { id: p.id }, data: { status: voicedAll ? 'VOICED' : 'SCRIPT_READY' } });
  });
  if (!(await prisma.scriptSegment.count({ where: { projectId: p.id, audioKey: null } }))) {
    // all segments voiced → regenerate subtitle timing from narration
    const { regenerateSubtitles } = await import('../lib/subs.js');
    await regenerateSubtitles(p.id);
  }
  return c.json({ ok: true });
});

/** Edit subtitles (text + timing). */
projectRoutes.put('/:id/subtitles', async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  if (p.status === 'RENDERING') throw conflict('Subtitles are locked while rendering');
  const b = await body(
    c,
    z.object({
      subtitles: z
        .array(z.object({ startSec: z.number().min(0), endSec: z.number().positive(), text: z.string().trim().min(1).max(300), segmentIdx: z.number().int().nullable().optional() }))
        .max(2000),
    }),
  );
  for (const [i, s] of b.subtitles.entries()) if (s.endSec <= s.startSec) throw badRequest(`Subtitle ${i + 1}: end must be after start`);
  const sorted = b.subtitles.slice().sort((a, b2) => a.startSec - b2.startSec);
  await prisma.$transaction([
    prisma.subtitle.deleteMany({ where: { projectId: p.id } }),
    prisma.subtitle.createMany({
      data: sorted.map((s, i) => ({ projectId: p.id, idx: i, startSec: s.startSec, endSec: s.endSec, text: s.text, segmentIdx: s.segmentIdx ?? null })),
    }),
  ]);
  return c.json({ ok: true, count: sorted.length });
});

projectRoutes.post('/:id/subtitles/regenerate', async (c) => {
  const p = await ownProject(c.get('user').id, c.req.param('id'));
  const { regenerateSubtitles } = await import('../lib/subs.js');
  const n = await regenerateSubtitles(p.id);
  return c.json({ ok: true, count: n });
});

projectRoutes.get('/:id/subtitles.srt', async (c) => {
  const p = await ownProject(c.get('user').id, c.req.param('id'));
  const subs = await prisma.subtitle.findMany({ where: { projectId: p.id }, orderBy: { idx: 'asc' } });
  c.header('Content-Type', 'application/x-subrip; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="recap-${p.id}.srt"`);
  return c.body(buildSrt(subs));
});

// ---------------- Pipeline actions ----------------
const jobLimiter = rateLimit({ name: 'jobs', limit: 40, windowSec: 3600, by: 'user' });

projectRoutes.post('/:id/analyze', jobLimiter, async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  if (!p.sourceAssetId) throw badRequest('Upload a video first');
  const source = await prisma.asset.findUniqueOrThrow({ where: { id: p.sourceAssetId } });
  if (source.status !== 'READY' || !source.durationSec) throw badRequest('The video is still being validated. Please wait a moment.');
  if (p.recapType === 'CUSTOM' && !p.customPrompt?.trim()) throw badRequest('Custom recap requires instructions');
  const plan = await effectivePlan(user);
  const b = await body(c, z.object({ requestId: z.string().min(8).max(64) }));
  const credits = estimateAnalyzeCredits(source.durationSec);
  const { job, created } = await createJob({
    userId: user.id,
    projectId: p.id,
    type: 'ANALYZE',
    credits,
    estCostUsd: estimateAnalyzeUsd(source.durationSec),
    idempotencyKey: `analyze:${p.id}:${b.requestId}`,
    maxConcurrent: plan.maxConcurrentJobs,
    projectStatus: 'ANALYZING',
    input: { recapType: p.recapType, targetDurationSec: p.targetDurationSec },
  });
  return c.json({ job: publicJob(job), created }, created ? 202 : 200);
});

projectRoutes.post('/:id/voiceover', jobLimiter, async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  const segs = await prisma.scriptSegment.findMany({ where: { projectId: p.id } });
  if (!segs.length) throw badRequest('Generate or write a script first');
  if (!isValidVoice(p.voiceName)) throw badRequest('Selected voice is not available. Choose another voice.');
  const b = await body(c, z.object({ requestId: z.string().min(8).max(64) }));
  const pending = segs.filter((s) => !s.audioKey || s.audioTextHash !== voiceHash(s.narration, p.voiceName, p.voiceRate, p.voicePitch));
  const chars = pending.reduce((a, s) => a + Array.from(s.narration).length, 0);
  const plan = await effectivePlan(user);
  const { job, created } = await createJob({
    userId: user.id,
    projectId: p.id,
    type: 'VOICEOVER',
    credits: chars ? estimateVoiceCredits(chars) : 0,
    estCostUsd: estimateVoiceUsd(chars),
    idempotencyKey: `voice:${p.id}:${b.requestId}`,
    maxConcurrent: plan.maxConcurrentJobs,
    projectStatus: 'VOICING',
  });
  return c.json({ job: publicJob(job), created }, created ? 202 : 200);
});

projectRoutes.post('/:id/render', jobLimiter, async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  const segs = await prisma.scriptSegment.findMany({ where: { projectId: p.id } });
  if (!segs.length) throw badRequest('Generate a script first');
  const stale = segs.filter((s) => !s.audioKey || s.audioTextHash !== voiceHash(s.narration, p.voiceName, p.voiceRate, p.voicePitch));
  if (stale.length) throw badRequest(`Voiceover is missing or outdated for ${stale.length} segment(s). Generate the voiceover first.`);
  const b = await body(c, z.object({ requestId: z.string().min(8).max(64) }));
  const outDur = computeTimeline(segs.map((s) => ({ idx: s.idx, audioDurationSec: s.audioDurationSec }))).reduce((a, t) => a + t.duration, 0);
  const plan = await effectivePlan(user);
  const { job, created } = await createJob({
    userId: user.id,
    projectId: p.id,
    type: 'RENDER',
    credits: estimateRenderCredits(outDur),
    estCostUsd: estimateRenderUsd(outDur),
    idempotencyKey: `render:${p.id}:${b.requestId}`,
    maxConcurrent: plan.maxConcurrentJobs,
    projectStatus: 'RENDERING',
    input: { maxHeight: plan.maxOutputHeight, watermark: plan.watermark },
  });
  return c.json({ job: publicJob(job), created }, created ? 202 : 200);
});

projectRoutes.get('/:id/download', async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  if (!p.outputAssetId) throw notFound('No rendered video yet');
  const a = await prisma.asset.findUniqueOrThrow({ where: { id: p.outputAssetId } });
  const safeTitle = p.title.replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'recap';
  const url = await storage().presignDownload(a.storageKey, { filename: `${safeTitle}.mp4`, ttlSec: 900 });
  await audit(c, user.id, 'project.download', 'project', p.id);
  return c.json({ url });
});

/** Soft delete immediately (hidden), storage purged right away; DB rows purged by the maintenance job. */
projectRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  const active = await prisma.job.findFirst({ where: { projectId: p.id, status: { in: ['QUEUED', 'ACTIVE'] } } });
  if (active) {
    const { requestCancel } = await import('@recap/core');
    await requestCancel(active.id, user.id);
  }
  await prisma.project.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
  // delete files now
  await storage().deletePrefix(keys.projectPrefix(user.id, p.id)).catch(() => undefined);
  if (p.sourceAssetId) {
    const s = await prisma.asset.findUnique({ where: { id: p.sourceAssetId } });
    if (s) await storage().delete(s.storageKey).catch(() => undefined);
  }
  await prisma.asset.updateMany({
    where: { id: { in: [p.sourceAssetId, p.outputAssetId, p.thumbnailAssetId].filter(Boolean) as string[] } },
    data: { status: 'DELETED' },
  });
  await audit(c, user.id, 'project.delete', 'project', p.id);
  return c.json({ ok: true });
});

projectRoutes.post('/:id/duplicate', async (c) => {
  const user = c.get('user');
  const p = await ownProject(user.id, c.req.param('id'));
  const segs = await prisma.scriptSegment.findMany({ where: { projectId: p.id }, orderBy: { idx: 'asc' } });
  // A duplicate shares the source video (read-only) but gets its own voice/render outputs.
  const copy = await prisma.project.create({
    data: {
      userId: user.id,
      title: `${p.title} (copy)`.slice(0, 120),
      recapType: p.recapType,
      aspectRatio: p.aspectRatio,
      fitMode: p.fitMode,
      customPrompt: p.customPrompt,
      targetDurationSec: p.targetDurationSec,
      voiceName: p.voiceName,
      voiceRate: p.voiceRate,
      voicePitch: p.voicePitch,
      originalAudioVolume: p.originalAudioVolume,
      musicTrackId: p.musicTrackId,
      musicVolume: p.musicVolume,
      transition: p.transition,
      subtitleStyle: p.subtitleStyle ?? undefined,
      subtitlesEnabled: p.subtitlesEnabled,
      analysis: p.analysis ?? undefined,
      sourceAssetId: null,
      status: 'DRAFT',
      copyrightConfirmedAt: p.copyrightConfirmedAt,
      copyrightIp: p.copyrightIp,
      segments: {
        create: segs.map((s) => ({ idx: s.idx, sourceStart: s.sourceStart, sourceEnd: s.sourceEnd, narration: s.narration, sceneNote: s.sceneNote })),
      },
    },
  });
  return c.json({ project: publicProject(copy), note: 'Script copied. Upload the source video again to continue.' }, 201);
});

export { estimates };
