import { PrismaClient } from '@prisma/client';

const g = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma: PrismaClient =
  g.__prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') g.__prisma = prisma;

export * from '@prisma/client';
