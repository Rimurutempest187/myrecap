/**
 * Error reporting. If SENTRY_DSN is set, errors are sent to Sentry's store endpoint
 * (no SDK dependency; works with self-hosted Sentry/GlitchTip). Always logged via pino.
 */
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

function parseDsn(dsn: string) {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\//, '');
  return { key: u.username, url: `${u.protocol}//${u.host}/api/${projectId}/store/` };
}

export async function reportError(err: unknown, context: Record<string, unknown> = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error({ err: e, ...context }, 'reported error');
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const { key, url } = parseDsn(dsn);
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}, sentry_client=recapai/1.0`,
      },
      body: JSON.stringify({
        event_id: randomUUID().replace(/-/g, ''),
        timestamp: new Date().toISOString(),
        platform: 'node',
        level: 'error',
        server_name: process.env.SERVICE_NAME ?? 'recap',
        environment: process.env.NODE_ENV,
        exception: { values: [{ type: e.name, value: e.message, stacktrace: { frames: (e.stack ?? '').split('\n').slice(1, 30).map((l) => ({ function: l.trim() })).reverse() } }] },
        extra: context,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* never throw from the error reporter */
  }
}
