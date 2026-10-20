import { Queue, QueueEvents } from 'bullmq';
import { createRedis } from './redis.js';
import type { JobType } from '@prisma/client';

export const QUEUE_NAME = 'recap-jobs';
export const MAINT_QUEUE_NAME = 'recap-maintenance';

export interface JobPayload {
  jobId: string; // our DB Job.id
  type: JobType;
}

let q: Queue<JobPayload> | null = null;
let mq: Queue | null = null;

export function jobQueue(): Queue<JobPayload> {
  if (!q) {
    q = new Queue<JobPayload>(QUEUE_NAME, {
      connection: createRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 15_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
        removeOnFail: { age: 14 * 24 * 3600 },
      },
    });
  }
  return q;
}

export function maintenanceQueue(): Queue {
  if (!mq) mq = new Queue(MAINT_QUEUE_NAME, { connection: createRedis() });
  return mq;
}

/** Enqueue with BullMQ jobId == DB job id, so duplicate enqueues are ignored (idempotent). */
export async function enqueueJob(jobId: string, type: JobType, priority = 5) {
  await jobQueue().add(type, { jobId, type }, { jobId, priority });
}

export async function removeQueuedJob(jobId: string) {
  const j = await jobQueue().getJob(jobId);
  if (!j) return false;
  const state = await j.getState();
  if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
    await j.remove();
    return true;
  }
  return false;
}

export async function queueStats() {
  const counts = await jobQueue().getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized');
  return counts;
}

export { QueueEvents };
