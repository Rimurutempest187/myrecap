import { prisma, type Plan } from '@recap/core';
import type { AuthUser } from './types.js';

let freeCache: { plan: Plan; at: number } | null = null;

export async function effectivePlan(user: AuthUser): Promise<Plan> {
  if (user.plan && user.plan.active) return user.plan;
  if (!freeCache || Date.now() - freeCache.at > 60_000) {
    const p = await prisma.plan.findUnique({ where: { code: 'free' } });
    if (!p) throw new Error('Free plan missing; run the seed script');
    freeCache = { plan: p, at: Date.now() };
  }
  return freeCache.plan;
}
