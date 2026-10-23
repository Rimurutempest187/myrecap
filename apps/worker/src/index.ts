import { Worker, UnrecoverableError, type Job as BullJob } from 'bullmq';
import {
  prisma,
  env,
  logger,
  createRedis,
  QUEUE_NAME,
  MAINT_QUEUE_NAME,
  maintenanceQueue,
  productionConfigProblems,
  settleJobCredits,
  finalizeCancelled,
  finalizeFailed,
  publishJobEvent,
  PermanentJobError,
  JobCancelledError,
  reportError,
  continueAutoPilot,
  type JobPayload,
} from '@recap/core';
import { createServer } from 'node:http';
import { JobContext } from './context.js';
import { processProbe } from './processors/probe.js';
import { processAnalyze } from './processors/analyze.js';
import { processVoiceover } from './processors/voiceover.js';
import { processRender } from './processors/render.js';
import { cleanupTempDirs, purgeDeleted, reapStuckJobs, backupDatabase } from './maintenance.js';

process.env.SERVICE_NAME ||= 'worker';
const e = env();
const problems = productionConfigProblems(e, 'worker');
if (problems.length) {
  logger.fatal({ problems }, 'Refusing to start: invalid production configuration');
  process.exit(1);
}

const processors = { PROBE: processProbe, ANALYZE: processAnalyze, VOICEOVER: processVoiceover, RENDER: processRender } as const;

function friendlyError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/ENOSPC/.test(m)) return 'Server is out of disk space. Please retry later.';
  if (/timed out/i.test(m)) return 'Processing took too long and was stopped. Try a shorter video or retry.';
  return m.slice(0, 1000);
}

async function handle(bj: BullJob<JobPayload>) {
  const { jobId } = bj.data;
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new UnrecoverableError('Job record missing');
  // Idempotency: never re-run finished jobs
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') return { skipped: true };
  if (job.cancelRequested) {
    await finalizeCancelled(job.id);
    return { cancelled: true };
  }
  const started = await prisma.job.update({
    where: { id: job.id },
    data: { status: 'ACTIVE', startedAt: job.startedAt ?? new Date(), attempts: { increment: 1 }, error: null, stage: 'Starting' },
  });
  await publishJobEvent(job.userId, { jobId: job.id, projectId: job.projectId, type: job.type, status: 'ACTIVE', progress: started.progress, stage: 'Starting' }).catch(() => undefined);

  const ctx = new JobContext(started);
  await ctx.init();
  const hardTimeout = setTimeout(() => ctx.abort.abort(new Error(`Job timed out after ${e.JOB_TIMEOUT_MIN} minutes`)), e.JOB_TIMEOUT_MIN * 60_000);
  try {
    const out = await processors[job.type](ctx);
    const { charged } = await settleJobCredits(job.id, out.charge);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'COMPLETED', progress: 100, stage: 'Done', finishedAt: new Date(), result: out.result as any, actualCostUsd: ctx.costUsd },
    });
    await publishJobEvent(job.userId, { jobId: job.id, projectId: job.projectId, type: job.type, status: 'COMPLETED', progress: 100, stage: 'Done', projectStatus: out.projectStatus }).catch(() => undefined);
    logger.info({ jobId: job.id, type: job.type, charged, costUsd: ctx.costUsd }, 'job completed');
    await continueAutoPilot(job.id).catch((e2) => logger.warn({ err: e2?.message, jobId: job.id }, 'auto-pilot continuation failed'));
    return out.result;
  } catch (err: any) {
    const cancelled = err instanceof JobCancelledError || (ctx.signal.aborted && ctx.signal.reason instanceof JobCancelledError);
    if (cancelled) {
      await finalizeCancelled(job.id);
      logger.info({ jobId: job.id }, 'job cancelled');
      return { cancelled: true };
    }
    const reason = ctx.signal.aborted && ctx.signal.reason instanceof Error ? ctx.signal.reason : err;
    const permanent = reason instanceof PermanentJobError;
    const lastAttempt = bj.attemptsMade + 1 >= (bj.opts.attempts ?? 1);
    logger.error({ jobId: job.id, type: job.type, err: reason?.message, stderr: reason?.stderr?.slice?.(-1500), permanent, attempt: bj.attemptsMade + 1 }, 'job failed');
    if (!permanent) void reportError(reason, { jobId: job.id, type: job.type, attempt: bj.attemptsMade + 1 });
    if (permanent || lastAttempt) {
      await finalizeFailed(job.id, friendlyError(reason));
      throw new UnrecoverableError(friendlyError(reason));
    }
    await prisma.job.update({ where: { id: job.id }, data: { status: 'QUEUED', stage: `Retrying after error: ${friendlyError(reason).slice(0, 120)}`, error: friendlyError(reason) } });
    await publishJobEvent(job.userId, { jobId: job.id, projectId: job.projectId, type: job.type, status: 'QUEUED', progress: 0, stage: 'Retrying…' }).catch(() => undefined);
    throw reason;
  } finally {
    clearTimeout(hardTimeout);
    await ctx.cleanup();
  }
}

const worker = new Worker<JobPayload>(QUEUE_NAME, handle, {
  connection: createRedis(),
  concurrency: e.WORKER_CONCURRENCY,
  lockDuration: 120_000,
  stalledInterval: 60_000,
  maxStalledCount: 2,
});
worker.on('ready', () => logger.info({ concurrency: e.WORKER_CONCURRENCY }, 'worker ready'));
worker.on('error', (err) => logger.error({ err }, 'worker error'));

// ---- maintenance (repeatable jobs, run by exactly one worker at a time via BullMQ) ----
const maint = new Worker(
  MAINT_QUEUE_NAME,
  async (j) => {
    switch (j.name) {
      case 'cleanup-temp':
        return { removed: await cleanupTempDirs() };
      case 'purge-deleted':
        return purgeDeleted();
      case 'reap-stuck':
        return { reaped: await reapStuckJobs() };
      case 'backup-db':
        return { key: await backupDatabase() };
    }
  },
  { connection: createRedis(), concurrency: 1 },
);
maint.on('failed', (j, err) => logger.error({ job: j?.name, err: err.message }, 'maintenance task failed'));

async function scheduleMaintenance() {
  const q = maintenanceQueue();
  await q.upsertJobScheduler('cleanup-temp', { every: 30 * 60_000 }, { name: 'cleanup-temp' });
  await q.upsertJobScheduler('purge-deleted', { every: 6 * 3600_000 }, { name: 'purge-deleted' });
  await q.upsertJobScheduler('reap-stuck', { every: 5 * 60_000 }, { name: 'reap-stuck' });
  if (e.BACKUP_ENABLED) await q.upsertJobScheduler('backup-db', { pattern: e.BACKUP_CRON }, { name: 'backup-db' });
}
scheduleMaintenance().catch((err) => logger.error({ err }, 'failed to schedule maintenance'));
cleanupTempDirs().catch(() => undefined);

// Health endpoint for Docker/K8s
const healthPort = Number(process.env.WORKER_HEALTH_PORT || 4100);
createServer(async (_req, res) => {
  const ok = worker.isRunning();
  res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok, running: worker.isRunning() }));
}).listen(healthPort, '0.0.0.0');

async function shutdown(sig: string) {
  logger.info({ sig }, 'worker shutting down (waiting for active jobs)');
  await Promise.allSettled([worker.close(), maint.close()]);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => void reportError(err, { kind: 'unhandledRejection' }));
