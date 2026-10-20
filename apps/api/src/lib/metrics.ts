import type { MiddlewareHandler } from 'hono';
import { queueStats, prisma } from '@recap/core';

/** Minimal Prometheus metrics without extra deps. */
const counters = new Map<string, number>();
const durations = new Map<string, { sum: number; count: number }>();

export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  const route = c.req.routePath || 'unknown';
  const key = `${c.req.method}|${route}|${c.res.status}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
  const d = durations.get(route) ?? { sum: 0, count: 0 };
  d.sum += (performance.now() - start) / 1000;
  d.count++;
  durations.set(route, d);
};

export async function metrics() {
  const lines: string[] = ['# TYPE http_requests_total counter'];
  for (const [k, v] of counters) {
    const [method, route, status] = k.split('|');
    lines.push(`http_requests_total{method="${method}",route="${route}",status="${status}"} ${v}`);
  }
  lines.push('# TYPE http_request_duration_seconds summary');
  for (const [route, d] of durations) {
    lines.push(`http_request_duration_seconds_sum{route="${route}"} ${d.sum.toFixed(4)}`);
    lines.push(`http_request_duration_seconds_count{route="${route}"} ${d.count}`);
  }
  try {
    const q = await queueStats();
    lines.push('# TYPE recap_queue_jobs gauge');
    for (const [state, n] of Object.entries(q)) lines.push(`recap_queue_jobs{state="${state}"} ${n}`);
  } catch {
    /* ignore */
  }
  try {
    const failed = await prisma.job.count({ where: { status: 'FAILED', createdAt: { gte: new Date(Date.now() - 3600_000) } } });
    lines.push('# TYPE recap_jobs_failed_last_hour gauge', `recap_jobs_failed_last_hour ${failed}`);
  } catch {
    /* ignore */
  }
  const mem = process.memoryUsage();
  lines.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`);
  return lines.join('\n') + '\n';
}
