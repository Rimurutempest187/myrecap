import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { prisma, env, unauthorized, forbidden, hashPassword } from '@recap/core';
import type { AppEnv } from './types.js';

const scryptAsync = promisify(scrypt);
export const SESSION_COOKIE = 'recap_session';

export { hashPassword };

export async function verifyPassword(pw: string, stored: string) {
  const [algo, saltHex, keyHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = (await scryptAsync(pw, Buffer.from(saltHex, 'hex'), 64)) as Buffer;
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(c: Context, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const e = env();
  const expiresAt = new Date(Date.now() + e.SESSION_TTL_DAYS * 86400_000);
  const s = await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
      userAgent: c.req.header('user-agent')?.slice(0, 300),
      ip: clientIp(c),
    },
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    domain: e.COOKIE_DOMAIN || undefined,
    expires: expiresAt,
  });
  return s;
}

export async function destroySession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  deleteCookie(c, SESSION_COOKIE, { path: '/', domain: env().COOKIE_DOMAIN || undefined });
}

export function clientIp(c: Context): string {
  // Behind Cloudflare the real visitor IP is in CF-Connecting-IP (Caddy only accepts traffic from Cloudflare when TRUST_CLOUDFLARE=true).
  const cf = process.env.TRUST_CLOUDFLARE === 'true' ? c.req.header('cf-connecting-ip') : undefined;
  if (cf) return cf.trim();
  const xf = c.req.header('x-forwarded-for');
  if (xf) return xf.split(',')[0].trim();
  return c.req.header('x-real-ip') || (c.env as any)?.incoming?.socket?.remoteAddress || 'unknown';
}

async function loadUser(c: Context) {
  const token = getCookie(c, SESSION_COOKIE) || c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { plan: true } } },
  });
  if (!session || session.expiresAt < new Date()) return null;
  if (session.user.status !== 'ACTIVE') return null;
  // touch at most once per 10 min
  if (Date.now() - session.lastUsedAt.getTime() > 600_000) {
    prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  return session;
}

export async function optionalUser(c: Context) {
  const s = await loadUser(c);
  return s?.user ?? null;
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = await loadUser(c);
  if (!s) throw unauthorized();
  c.set('user', s.user);
  c.set('sessionId', s.id);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = await loadUser(c);
  if (!s) throw unauthorized();
  if (s.user.role !== 'ADMIN') throw forbidden('Admin access required');
  c.set('user', s.user);
  c.set('sessionId', s.id);
  await next();
};

/** CSRF defence for cookie-authenticated, state-changing requests: require same-origin Origin header. */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  if (c.req.path.startsWith('/api/billing/webhook') || c.req.path.startsWith('/api/storage/local')) return next();
  const origin = c.req.header('origin');
  if (!origin) return next(); // non-browser clients (no ambient cookies via CORS) — still need a valid session
  const allowed = new Set(env().WEB_ORIGIN.split(',').map((s) => s.trim()));
  const self = new URL(c.req.url).origin;
  const host = c.req.header('x-forwarded-host') || c.req.header('host');
  if (allowed.has(origin) || origin === self || (host && new URL(origin).host === host)) return next();
  throw forbidden('Cross-origin request blocked');
};
