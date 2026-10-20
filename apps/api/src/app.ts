import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { AppError, env, logger, prisma, redis, reportError } from '@recap/core';
import { csrfGuard } from './lib/auth.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { uploadRoutes } from './routes/uploads.js';
import { jobRoutes } from './routes/jobs.js';
import { storageRoutes } from './routes/storage.js';
import { metaRoutes } from './routes/meta.js';
import { billingRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';
import { metrics, metricsMiddleware } from './lib/metrics.js';
import type { AppEnv } from './lib/types.js';

export function createApp() {
  const app = new Hono<AppEnv>();
  const origins = env().WEB_ORIGIN.split(',').map((s) => s.trim());

  app.use('*', async (c, next) => {
    const id = c.req.header('x-request-id') || randomUUID();
    c.set('requestId', id);
    c.header('X-Request-Id', id);
    await next();
  });
  app.use('*', metricsMiddleware);
  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  app.use('/api/*', cors({ origin: origins, credentials: true, allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'], maxAge: 600 }));
  app.use('/api/*', async (c, next) => {
    // JSON bodies are small; uploads go directly to storage
    if (c.req.path.startsWith('/api/storage/local')) return next();
    return bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (cc) => cc.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } }, 413) })(c, next);
  });
  app.use('/api/*', csrfGuard);
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    if (!c.req.path.startsWith('/api/health') && !c.req.path.startsWith('/metrics')) {
      logger.info({ reqId: c.get('requestId'), method: c.req.method, path: c.req.path, status: c.res.status, ms }, 'request');
    }
  });

  app.get('/api/health', async (c) => {
    const checks = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redis().ping()]);
    const ok = checks.every((x) => x.status === 'fulfilled');
    return c.json({ ok, db: checks[0].status === 'fulfilled', redis: checks[1].status === 'fulfilled', time: new Date().toISOString() }, ok ? 200 : 503);
  });
  app.get('/metrics', async (c) => {
    const token = process.env.METRICS_TOKEN;
    if (token && c.req.header('authorization') !== `Bearer ${token}`) return c.text('unauthorized', 401);
    return c.text(await metrics(), 200, { 'Content-Type': 'text/plain; version=0.0.4' });
  });

  app.route('/api/auth', authRoutes);
  app.route('/api/projects', projectRoutes);
  app.route('/api/uploads', uploadRoutes);
  app.route('/api/jobs', jobRoutes);
  app.route('/api/storage', storageRoutes);
  app.route('/api/billing', billingRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api', metaRoutes);

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as any);
    }
    const anyErr = err as any;
    if (anyErr?.code === 'P2025') return c.json({ error: { code: 'NOT_FOUND', message: 'Record not found' } }, 404);
    if (anyErr?.code === 'P2002') return c.json({ error: { code: 'CONFLICT', message: 'Duplicate record' } }, 409);
    if (anyErr?.code === 'P2034') return c.json({ error: { code: 'CONFLICT', message: 'Concurrent update, please retry' } }, 409);
    void reportError(err, { reqId: c.get('requestId'), path: c.req.path, method: c.req.method });
    return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId: c.get('requestId') } }, 500);
  });

  return app;
}
