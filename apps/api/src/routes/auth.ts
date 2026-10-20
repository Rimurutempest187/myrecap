import { Hono } from 'hono';
import { prisma, env, applyCredits, badRequest, unauthorized, conflict, forbidden } from '@recap/core';
import { body, z } from '../lib/validate.js';
import { createSession, destroySession, hashPassword, verifyPassword, requireAuth } from '../lib/auth.js';
import { rateLimit } from '../lib/rateLimit.js';
import { publicUser } from '../lib/serialize.js';
import { audit } from '../lib/audit.js';
import type { AppEnv } from '../lib/types.js';

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and numbers');

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/register', rateLimit({ name: 'register', limit: 5, windowSec: 3600 }), async (c) => {
  const b = await body(
    c,
    z.object({
      email: z.string().email().max(200),
      password,
      name: z.string().trim().min(1).max(80),
      acceptTerms: z.literal(true, { message: 'You must accept the Terms of Service' }),
    }),
  );
  const email = b.email.toLowerCase().trim();
  if (await prisma.user.findUnique({ where: { email } })) throw conflict('An account with this email already exists');
  const settings = await prisma.systemSetting.findUnique({ where: { key: 'limits' } });
  const bonus = Number((settings?.value as any)?.signupBonusCredits ?? env().SIGNUP_BONUS_CREDITS);
  const free = await prisma.plan.findUnique({ where: { code: 'free' } });
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: { email, name: b.name, passwordHash: await hashPassword(b.password), planId: free?.id },
    });
    if (bonus > 0) {
      await applyCredits(tx, { userId: u.id, delta: bonus, reason: 'SIGNUP_BONUS', idempotencyKey: `signup:${u.id}`, note: 'Welcome credits' });
    }
    return tx.user.findUniqueOrThrow({ where: { id: u.id }, include: { plan: true } });
  });
  await createSession(c, user.id);
  await audit(c, user.id, 'user.register', 'user', user.id);
  return c.json({ user: publicUser(user) }, 201);
});

authRoutes.post('/login', rateLimit({ name: 'login', limit: 10, windowSec: 600 }), async (c) => {
  const b = await body(c, z.object({ email: z.string().email(), password: z.string().min(1).max(200) }));
  const user = await prisma.user.findUnique({ where: { email: b.email.toLowerCase().trim() }, include: { plan: true } });
  // constant-ish time: always verify a hash
  const ok = user ? await verifyPassword(b.password, user.passwordHash) : await verifyPassword(b.password, 'scrypt$00$00');
  if (!user || !ok) throw unauthorized('Invalid email or password');
  if (user.status !== 'ACTIVE') throw forbidden('This account is suspended. Contact support.');
  await createSession(c, user.id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(c, user.id, 'user.login', 'user', user.id);
  return c.json({ user: publicUser(user) });
});

authRoutes.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, async (c) => c.json({ user: publicUser(c.get('user')) }));

authRoutes.patch('/me', requireAuth, async (c) => {
  const b = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      monthlyCreditLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),
    }),
  );
  const u = await prisma.user.update({ where: { id: c.get('user').id }, data: b, include: { plan: true } });
  return c.json({ user: publicUser(u) });
});

authRoutes.post('/change-password', requireAuth, rateLimit({ name: 'pw', limit: 5, windowSec: 600 }), async (c) => {
  const b = await body(c, z.object({ currentPassword: z.string().min(1), newPassword: password }));
  const user = c.get('user');
  if (!(await verifyPassword(b.currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(b.newPassword) } });
  await prisma.session.deleteMany({ where: { userId: user.id, NOT: { id: c.get('sessionId') } } });
  await audit(c, user.id, 'user.change_password', 'user', user.id);
  return c.json({ ok: true });
});

/** Permanently delete the account and all content (GDPR-style). */
authRoutes.delete('/me', requireAuth, async (c) => {
  const b = await body(c, z.object({ password: z.string().min(1) }));
  const user = c.get('user');
  if (!(await verifyPassword(b.password, user.passwordHash))) throw badRequest('Password is incorrect');
  const { storage } = await import('@recap/core');
  await storage().deletePrefix(`users/${user.id}/`);
  await audit(c, user.id, 'user.delete_account', 'user', user.id);
  await prisma.user.delete({ where: { id: user.id } });
  await destroySession(c);
  return c.json({ ok: true });
});
