import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { prisma, notFound, badRequest, requestCancel, createRedis, userChannel, createJob, hashKey } from '@recap/core';
import { requireAuth } from '../lib/auth.js';
import { publicJob } from '../lib/serialize.js';
import { effectivePlan } from '../lib/plan.js';
import type { AppEnv } from '../lib/types.js';

export const jobRoutes = new Hono<AppEnv>();
jobRoutes.use('*', requireAuth);

jobRoutes.get('/', async (c) => {
  const user = c.get('user');
  const take = Math.min(100, Number(c.req.query('limit')) || 30);
  const jobs = await prisma.job.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take,
    include: { project: { select: { id: true, title: true } } },
  });
  return c.json({ items: jobs.map((j) => ({ ...publicJob(j), projectTitle: j.project?.title ?? null })) });
});

/** Server-Sent Events stream of job progress for the current user (backed by Redis pub/sub). */
jobRoutes.get('/events', async (c) => {
  const user = c.get('user');
  // Disable proxy buffering/compression (Caddy, Cloudflare, nginx) so progress events arrive instantly.
  const res = streamSSE(c, async (stream) => {
    // 2 KB comment pads past intermediary buffers so the browser receives the stream immediately.
    await stream.write(`:${' '.repeat(2048)}\n\n`);
    const sub = createRedis();
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });
    await sub.subscribe(userChannel(user.id));
    sub.on('message', (_ch, msg) => {
      if (!closed) stream.writeSSE({ event: 'job', data: msg }).catch(() => (closed = true));
    });
    await stream.writeSSE({ event: 'ready', data: '{}' });
    while (!closed) {
      await stream.sleep(15_000);
      if (!closed) await stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => (closed = true));
    }
    await sub.quit().catch(() => sub.disconnect());
  });
  // Set after streamSSE (it overwrites Cache-Control). no-transform stops Cloudflare from compressing
  // (= buffering) the stream; X-Accel-Buffering disables nginx-style proxy buffering.
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
});

jobRoutes.get('/:id', async (c) => {
  const job = await prisma.job.findFirst({ where: { id: c.req.param('id'), userId: c.get('user').id } });
  if (!job) throw notFound('Job not found');
  return c.json({ job: publicJob(job) });
});

jobRoutes.post('/:id/cancel', async (c) => {
  const job = await requestCancel(c.req.param('id'), c.get('user').id);
  if (!job) throw notFound('Job not found');
  return c.json({ job: publicJob(job) });
});

/** Retry a failed or cancelled job with the same parameters (new idempotency key per attempt). */
jobRoutes.post('/:id/retry', async (c) => {
  const user = c.get('user');
  const job = await prisma.job.findFirst({ where: { id: c.req.param('id'), userId: user.id } });
  if (!job) throw notFound('Job not found');
  if (!['FAILED', 'CANCELLED'].includes(job.status)) throw badRequest('Only failed or cancelled jobs can be retried');
  if (!job.projectId) throw badRequest('Job has no project');
  const project = await prisma.project.findFirst({ where: { id: job.projectId, userId: user.id, deletedAt: null } });
  if (!project) throw notFound('Project not found');
  const plan = await effectivePlan(user);
  const statusFor = { ANALYZE: 'ANALYZING', VOICEOVER: 'VOICING', RENDER: 'RENDERING', PROBE: undefined } as const;
  const { job: nj } = await createJob({
    userId: user.id,
    projectId: job.projectId,
    type: job.type,
    credits: job.creditsReserved,
    estCostUsd: job.estCostUsd,
    idempotencyKey: `retry:${job.id}:${hashKey(Date.now())}`,
    maxConcurrent: job.type === 'PROBE' ? plan.maxConcurrentJobs + 1 : plan.maxConcurrentJobs,
    input: (job.input as any) ?? undefined,
    projectStatus: statusFor[job.type] as any,
  });
  return c.json({ job: publicJob(nj) }, 202);
});
