import { createHash } from 'node:crypto';
import { prisma, type JobType, type Prisma } from './db.js';
import { applyCredits, assertWithinSpendingLimit } from './credits.js';
import { enqueueJob, removeQueuedJob } from './queue.js';
import { conflict, tooMany } from './errors.js';
import { publishJobEvent } from './events.js';

export const ACTIVE_STATUSES = ['QUEUED', 'ACTIVE'] as const;

export function hashKey(...parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * Create a job: verifies concurrency limit, spending limit, reserves credits and enqueues.
 * Idempotent: the same idempotencyKey returns the existing job.
 */
export async function createJob(args: {
  userId: string;
  projectId: string;
  type: JobType;
  credits: number;
  estCostUsd: number;
  idempotencyKey: string;
  input?: Prisma.InputJsonValue;
  maxConcurrent: number;
  projectStatus?: Prisma.ProjectUpdateInput['status'];
}) {
  const existing = await prisma.job.findUnique({ where: { idempotencyKey: args.idempotencyKey } });
  if (existing) return { job: existing, created: false };

  const job = await prisma.$transaction(
    async (tx) => {
      const projectActive = await tx.job.findFirst({
        where: { projectId: args.projectId, status: { in: [...ACTIVE_STATUSES] } },
      });
      if (projectActive) throw conflict(`A ${projectActive.type.toLowerCase()} job is already running for this project`);
      const running = await tx.job.count({ where: { userId: args.userId, status: { in: [...ACTIVE_STATUSES] } } });
      if (running >= args.maxConcurrent) {
        throw tooMany(`Your plan allows ${args.maxConcurrent} concurrent job(s). Wait for running jobs to finish or upgrade.`);
      }
      await assertWithinSpendingLimit(tx, args.userId, args.credits);
      const j = await tx.job.create({
        data: {
          userId: args.userId,
          projectId: args.projectId,
          type: args.type,
          idempotencyKey: args.idempotencyKey,
          creditsReserved: args.credits,
          estCostUsd: args.estCostUsd,
          input: args.input,
          stage: 'Queued',
        },
      });
      if (args.credits > 0) {
        await applyCredits(tx, {
          userId: args.userId,
          delta: -args.credits,
          reason: 'JOB_RESERVE',
          idempotencyKey: `reserve:${j.id}`,
          jobId: j.id,
          note: `${args.type} job reservation`,
        });
      }
      if (args.projectStatus) {
        await tx.project.update({ where: { id: args.projectId }, data: { status: args.projectStatus, lastError: null } });
      }
      return j;
    },
    { isolationLevel: 'Serializable' },
  );
  await enqueueJob(job.id, job.type);
  await publishJobEvent(args.userId, {
    jobId: job.id,
    projectId: job.projectId,
    type: job.type,
    status: job.status,
    progress: 0,
    stage: job.stage,
  }).catch(() => undefined);
  return { job, created: true };
}

/** Request cancellation: queued jobs are removed immediately; active jobs are signalled. */
export async function requestCancel(jobId: string, userId: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, userId } });
  if (!job) return null;
  if (!ACTIVE_STATUSES.includes(job.status as any)) return job;
  await prisma.job.update({ where: { id: jobId }, data: { cancelRequested: true } });
  const removed = await removeQueuedJob(jobId);
  if (removed || job.status === 'QUEUED') {
    // Worker never picked it up; finalize here
    const { finalizeCancelled } = await import('./jobFinalize.js');
    await finalizeCancelled(jobId);
  }
  return prisma.job.findUnique({ where: { id: jobId } });
}

/** Hash of everything that affects a segment's synthesized audio. Shared by API & worker to detect stale voice. */
export function voiceHash(text: string, voice: string, rate: number, pitch: number) {
  return hashKey(text.replace(/\s+/g, ' ').trim(), voice, rate, pitch).slice(0, 16);
}
