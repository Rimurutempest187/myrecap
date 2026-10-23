/**
 * Auto-Pilot ("One-click recap"): after each job completes, start the next pipeline step automatically
 * (PROBE → ANALYZE → VOICEOVER → RENDER). Uses the same credit reservation, limits and idempotency
 * as manual starts. Any failure (insufficient credits, limits, errors) stops the chain and leaves the
 * project editable so the user can continue manually.
 */
import { prisma } from './db.js';
import { logger } from './logger.js';
import { createJob, voiceHash } from './jobs.js';
import { estimateAnalyzeCredits, estimateAnalyzeUsd, estimateVoiceCredits, estimateVoiceUsd, estimateRenderCredits, estimateRenderUsd } from './pricing.js';
import { computeTimeline } from './subtitles.js';
import { modelsForTask } from './ai/registry.js';
import { isValidVoice, defaultVoice } from './tts/index.js';
import type { JobType } from '@prisma/client';

const NEXT: Partial<Record<JobType, JobType>> = { PROBE: 'ANALYZE', ANALYZE: 'VOICEOVER', VOICEOVER: 'RENDER' };

async function planFor(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { plan: true } });
  return u.plan?.active ? u.plan : await prisma.plan.findUniqueOrThrow({ where: { code: 'free' } });
}

/** Start the next step for an auto-pilot project. Returns the created job type, or null when the chain ends. */
export async function continueAutoPilot(finishedJobId: string): Promise<JobType | null> {
  const done = await prisma.job.findUnique({ where: { id: finishedJobId } });
  if (!done?.projectId) return null;
  const next = NEXT[done.type];
  if (!next) return null;
  const p = await prisma.project.findUnique({ where: { id: done.projectId } });
  if (!p || p.deletedAt || !p.autoPilot) return null;
  try {
    return await startStep(p.id, next, `auto:${next}:${p.id}:${done.id}`);
  } catch (err: any) {
    const msg = `Auto-Pilot paused before ${next.toLowerCase()}: ${err?.message ?? err}. You can continue manually.`;
    logger.warn({ projectId: p.id, next, err: err?.message }, 'auto-pilot stopped');
    await prisma.project.update({ where: { id: p.id }, data: { autoPilot: false, lastError: msg.slice(0, 500) } });
    return null;
  }
}

/** Which step should run next for a project (null = finished or waiting for upload validation). */
export async function nextPipelineStep(projectId: string): Promise<JobType | null> {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const src = p.sourceAssetId ? await prisma.asset.findUnique({ where: { id: p.sourceAssetId } }) : null;
  if (!src || src.status !== 'READY') return null;
  const segs = await prisma.scriptSegment.findMany({ where: { projectId } });
  if (!segs.length) return 'ANALYZE';
  if (segs.some((s) => !s.audioKey || s.audioTextHash !== voiceHash(s.narration, p.voiceName, p.voiceRate, p.voicePitch))) return 'VOICEOVER';
  return 'RENDER';
}

/** Turn Auto-Pilot on and start the next step now (throws AppErrors such as insufficient credits). */
export async function startAutoPilot(projectId: string, requestId: string): Promise<JobType | null> {
  await prisma.project.update({ where: { id: projectId }, data: { autoPilot: true, lastError: null } });
  const step = await nextPipelineStep(projectId);
  if (!step) return null; // upload still validating — PROBE completion continues the chain
  try {
    return await startStep(projectId, step, `autostart:${step}:${projectId}:${requestId}`);
  } catch (err) {
    await prisma.project.update({ where: { id: projectId }, data: { autoPilot: false } });
    throw err;
  }
}

async function startStep(projectId: string, next: JobType, key: string): Promise<JobType | null> {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const plan = await planFor(p.userId);
  {
    if (next === 'ANALYZE') {
      const src = p.sourceAssetId ? await prisma.asset.findUnique({ where: { id: p.sourceAssetId } }) : null;
      if (!src?.durationSec || src.status !== 'READY') return null;
      const models = await modelsForTask('script', p.analysisModelId);
      if (!models.length) throw new Error('No AI model is configured');
      const credits = Math.max(1, Math.ceil(estimateAnalyzeCredits(src.durationSec) * (models[0].creditMultiplier || 1)));
      await createJob({
        userId: p.userId, projectId: p.id, type: 'ANALYZE', credits, estCostUsd: estimateAnalyzeUsd(src.durationSec),
        idempotencyKey: key, maxConcurrent: plan.maxConcurrentJobs, projectStatus: 'ANALYZING',
        input: { recapType: p.recapType, targetDurationSec: p.targetDurationSec, model: models[0].displayName, autoPilot: true },
      });
    } else if (next === 'VOICEOVER') {
      let voice = p.voiceName;
      if (!(await isValidVoice(voice))) {
        const def = await defaultVoice();
        if (!def) throw new Error('No voice is configured');
        voice = def;
        await prisma.project.update({ where: { id: p.id }, data: { voiceName: def } });
      }
      const segs = await prisma.scriptSegment.findMany({ where: { projectId: p.id } });
      if (!segs.length) return null;
      const chars = segs.filter((s) => !s.audioKey || s.audioTextHash !== voiceHash(s.narration, voice, p.voiceRate, p.voicePitch)).reduce((a, s) => a + Array.from(s.narration).length, 0);
      await createJob({
        userId: p.userId, projectId: p.id, type: 'VOICEOVER', credits: chars ? estimateVoiceCredits(chars) : 0, estCostUsd: estimateVoiceUsd(chars),
        idempotencyKey: key, maxConcurrent: plan.maxConcurrentJobs, projectStatus: 'VOICING', input: { autoPilot: true },
      });
    } else {
      const segs = await prisma.scriptSegment.findMany({ where: { projectId: p.id } });
      const out = computeTimeline(segs.map((s) => ({ idx: s.idx, audioDurationSec: s.audioDurationSec }))).reduce((a, t) => a + t.duration, 0);
      await createJob({
        userId: p.userId, projectId: p.id, type: 'RENDER', credits: estimateRenderCredits(out), estCostUsd: estimateRenderUsd(out),
        idempotencyKey: key, maxConcurrent: plan.maxConcurrentJobs, projectStatus: 'RENDERING',
        input: { maxHeight: plan.maxOutputHeight, watermark: plan.watermark, autoPilot: true },
      });
    }
    return next;
  }
}
