import type { MiddlewareHandler } from 'hono';
import { redis, tooMany } from '@recap/core';
import { clientIp } from './auth.js';

/** Fixed-window rate limiter backed by Redis (shared across API replicas). */
export function rateLimit(opts: { name: string; limit: number; windowSec: number; by?: 'ip' | 'user' }): MiddlewareHandler {
  return async (c, next) => {
    const user = (c.get as any)('user') as { id: string } | undefined;
    const who = opts.by === 'user' && user ? `u:${user.id}` : `ip:${clientIp(c)}`;
    const window = Math.floor(Date.now() / 1000 / opts.windowSec);
    const key = `rl:${opts.name}:${who}:${window}`;
    let count = 1;
    try {
      const r = redis();
      count = await r.incr(key);
      if (count === 1) await r.expire(key, opts.windowSec + 1);
    } catch {
      // fail-open if Redis is briefly unavailable
      return next();
    }
    c.header('X-RateLimit-Limit', String(opts.limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, opts.limit - count)));
    if (count > opts.limit) {
      c.header('Retry-After', String(opts.windowSec));
      throw tooMany('Too many requests, please slow down');
    }
    await next();
  };
}
