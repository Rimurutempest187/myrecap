import type { Context } from 'hono';
import { prisma, logger, type Prisma } from '@recap/core';
import { clientIp } from './auth.js';

export async function audit(c: Context | null, actorId: string | null, action: string, targetType?: string, targetId?: string, meta?: Prisma.InputJsonValue) {
  try {
    await prisma.auditLog.create({ data: { actorId, action, targetType, targetId, meta, ip: c ? clientIp(c) : null } });
  } catch (e) {
    logger.warn({ err: e }, 'audit log write failed');
  }
}
