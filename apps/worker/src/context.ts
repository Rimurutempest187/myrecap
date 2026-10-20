import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  prisma,
  env,
  publishJobEvent,
  JobCancelledError,
  createRedis,
  type Job as DbJob,
  type Prisma,
} from '@recap/core';

/**
 * Per-job execution context: progress reporting (throttled), cancellation polling,
 * a private temp working directory (always cleaned up), usage/cost recording.
 */
export class JobContext {
  readonly abort = new AbortController();
  readonly dir: string;
  private lastProgressAt = 0;
  private lastProgress = -1;
  private cancelTimer: NodeJS.Timeout | null = null;
  costUsd = 0;

  constructor(public job: DbJob) {
    this.dir = path.resolve(env().WORK_DIR, `job-${job.id}-${Date.now()}`);
  }

  get signal() {
    return this.abort.signal;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    // Poll DB for cancellation every 2s (cancel flag set by the API)
    this.cancelTimer = setInterval(async () => {
      try {
        const j = await prisma.job.findUnique({ where: { id: this.job.id }, select: { cancelRequested: true } });
        if (j?.cancelRequested && !this.abort.signal.aborted) this.abort.abort(new JobCancelledError());
      } catch {
        /* ignore transient */
      }
    }, 2000);
  }

  async cleanup() {
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  file(name: string) {
    return path.join(this.dir, name);
  }

  throwIfCancelled() {
    if (this.abort.signal.aborted) throw new JobCancelledError();
  }

  /** progress 0..100 */
  async progress(pct: number, stage?: string, force = false) {
    this.throwIfCancelled();
    const p = Math.max(0, Math.min(99, Math.round(pct)));
    const now = Date.now();
    if (!force && p === this.lastProgress && !stage) return;
    if (!force && now - this.lastProgressAt < 700 && Math.abs(p - this.lastProgress) < 5 && !stage) return;
    this.lastProgressAt = now;
    this.lastProgress = p;
    const data: Prisma.JobUpdateInput = { progress: p };
    if (stage) data.stage = stage;
    const j = await prisma.job.update({ where: { id: this.job.id }, data });
    await publishJobEvent(this.job.userId, {
      jobId: j.id,
      projectId: j.projectId,
      type: j.type,
      status: j.status,
      progress: p,
      stage: j.stage,
    }).catch(() => undefined);
  }

  async usage(kind: string, quantity: number, costUsd = 0) {
    this.costUsd += costUsd;
    await prisma.usageEvent.create({ data: { userId: this.job.userId, jobId: this.job.id, kind, quantity, costUsd } });
  }
}

export { createRedis };
