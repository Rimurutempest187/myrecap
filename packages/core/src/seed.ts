/**
 * Seeds plans, credit packs, an admin user (from ADMIN_EMAIL/ADMIN_PASSWORD) and default settings.
 * Safe to run repeatedly (upserts).
 */
import { scrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { prisma } from './db.js';
import { applyCredits } from './credits.js';

const scryptAsync = promisify(scrypt);

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const key = (await scryptAsync(pw, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export const DEFAULT_PLANS = [
  {
    code: 'free', name: 'Free', priceCents: 0, monthlyCredits: 30, maxUploadMb: 300, maxVideoMinutes: 20,
    maxConcurrentJobs: 1, maxOutputHeight: 720, watermark: true, sortOrder: 0,
    features: ['30 credits / month', '720p export', 'Up to 20-minute source videos', 'Watermark'],
  },
  {
    code: 'creator', name: 'Creator', priceCents: 999, monthlyCredits: 300, maxUploadMb: 1024, maxVideoMinutes: 90,
    maxConcurrentJobs: 2, maxOutputHeight: 1080, watermark: false, sortOrder: 1,
    features: ['300 credits / month', '1080p export, no watermark', 'Up to 90-minute source videos', '2 concurrent jobs'],
  },
  {
    code: 'pro', name: 'Pro', priceCents: 2999, monthlyCredits: 1200, maxUploadMb: 2048, maxVideoMinutes: 180,
    maxConcurrentJobs: 4, maxOutputHeight: 1080, watermark: false, sortOrder: 2,
    features: ['1200 credits / month', '1080p export, no watermark', 'Up to 3-hour source videos', '4 concurrent jobs', 'Priority queue'],
  },
];

async function main() {
  for (const p of DEFAULT_PLANS) {
    const priceEnv = process.env[`STRIPE_PRICE_${p.code.toUpperCase()}`];
    await prisma.plan.upsert({
      where: { code: p.code },
      create: { ...p, stripePriceId: priceEnv || null },
      update: { name: p.name, features: p.features, ...(priceEnv ? { stripePriceId: priceEnv } : {}) },
    });
  }
  const packs = [
    { name: 'Starter pack', credits: 100, priceCents: 499 },
    { name: 'Creator pack', credits: 500, priceCents: 1999 },
    { name: 'Studio pack', credits: 1500, priceCents: 4999 },
  ];
  for (const pk of packs) {
    const exists = await prisma.creditPack.findFirst({ where: { name: pk.name } });
    if (!exists) await prisma.creditPack.create({ data: pk });
  }
  await prisma.systemSetting.upsert({
    where: { key: 'limits' },
    create: { key: 'limits', value: { signupBonusCredits: Number(process.env.SIGNUP_BONUS_CREDITS ?? 30), maintenanceMode: false } },
    update: {},
  });

  const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  const pw = process.env.ADMIN_PASSWORD;
  if (email && pw) {
    const free = await prisma.plan.findUnique({ where: { code: 'pro' } });
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      const u = await prisma.user.create({
        data: { email, name: 'Administrator', passwordHash: await hashPassword(pw), role: 'ADMIN', planId: free?.id },
      });
      await prisma.$transaction((tx) =>
        applyCredits(tx, { userId: u.id, delta: 1000, reason: 'ADMIN_ADJUST', idempotencyKey: `seed-admin:${u.id}`, note: 'Initial admin credits' }),
      );
      console.log(`Created admin ${email}`);
    } else if (existing.role !== 'ADMIN') {
      await prisma.user.update({ where: { id: existing.id }, data: { role: 'ADMIN' } });
      console.log(`Promoted ${email} to admin`);
    }
  }
  console.log('Seed complete');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
