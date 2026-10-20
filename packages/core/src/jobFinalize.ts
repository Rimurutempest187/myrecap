import { prisma, type ProjectStatus } from './db.js';
import { settleJobCredits } from './credits.js';
import { publishJobEvent } from './events.js';

/** Project status to fall back to when a job of a type fails/cancels. */
export function fallbackStatus(type: string, hasScript: boolean, hasVoice: boolean): ProjectStatus {
  if (type === 'ANALYZE' || type === 'PROBE') return hasScript ? 'SCRIPT_READY' : 'UPLOADED';
  if (type === 'VOICEOVER') return hasVoice ? 'VOICED' : 'SCRIPT_READY';
  return hasVoice ? 'VOICED' : 'SCRIPT_READY';
}

async function projectFallback(projectId: string, type: string) {
  const [segs, voiced] = await Promise.all([
    prisma.scriptSegment.count({ where: { projectId } }),
    prisma.scriptSegment.count({ where: { projectId, audioKey: { not: null } } }),
  ]);
  return fallbackStatus(type, segs > 0, segs > 0 && voiced === segs);
}

export async function finalizeCancelled(jobId: string) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  if (job.status === 'CANCELLED' || job.status === 'COMPLETED') return job;
  await settleJobCredits(jobId, 0);
  const updated = await prisma.job.update({
    where: { id: jobId },
    data: { status: 'CANCELLED', stage: 'Cancelled', finishedAt: new Date(), error: null },
  });
  let projectStatus: ProjectStatus | undefined;
  if (job.projectId) {
    projectStatus = await projectFallback(job.projectId, job.type);
    await prisma.project.update({ where: { id: job.projectId }, data: { status: projectStatus } });
  }
  await publishJobEvent(job.userId, {
    jobId,
    projectId: job.projectId,
    type: job.type,
    status: 'CANCELLED',
    progress: updated.progress,
    stage: 'Cancelled',
    projectStatus,
  }).catch(() => undefined);
  return updated;
}

export async function finalizeFailed(jobId: string, error: string) {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') return job;
  await settleJobCredits(jobId, 0);
  const updated = await prisma.job.update({
    where: { id: jobId },
    data: { status: 'FAILED', stage: 'Failed', error: error.slice(0, 2000), finishedAt: new Date() },
  });
  let projectStatus: ProjectStatus | undefined;
  if (job.projectId) {
    projectStatus = await projectFallback(job.projectId, job.type);
    if (!(await prisma.scriptSegment.count({ where: { projectId: job.projectId } })) && job.type === 'ANALYZE') projectStatus = 'FAILED';
    await prisma.project.update({ where: { id: job.projectId }, data: { status: projectStatus, lastError: error.slice(0, 1000) } });
  }
  await publishJobEvent(job.userId, {
    jobId,
    projectId: job.projectId,
    type: job.type,
    status: 'FAILED',
    progress: updated.progress,
    stage: 'Failed',
    error: updated.error,
    projectStatus,
  }).catch(() => undefined);
  return updated;
}
