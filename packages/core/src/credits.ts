import { prisma, type Prisma, LedgerReason } from './db.js';
import { paymentRequired } from './errors.js';

type Tx = Prisma.TransactionClient;

function monthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Net credits spent this calendar month (reservations minus releases). */
export async function monthlySpend(userId: string, tx: Tx = prisma): Promise<number> {
  const rows = await tx.creditLedger.groupBy({
    by: ['reason'],
    where: { userId, createdAt: { gte: monthStart() }, reason: { in: ['JOB_RESERVE', 'JOB_RELEASE'] } },
    _sum: { delta: true },
  });
  const sum = rows.reduce((a, r) => a + (r._sum.delta ?? 0), 0);
  return Math.max(0, -sum);
}

/**
 * Atomically add (positive) or remove (negative) credits, writing a ledger row.
 * Idempotent per key: a repeated key is a no-op and returns the previous row.
 */
export async function applyCredits(
  tx: Tx,
  args: { userId: string; delta: number; reason: LedgerReason; idempotencyKey: string; jobId?: string; note?: string },
) {
  const existing = await tx.creditLedger.findUnique({ where: { idempotencyKey: args.idempotencyKey } });
  if (existing) return existing;
  if (args.delta < 0) {
    const r = await tx.user.updateMany({
      where: { id: args.userId, creditBalance: { gte: -args.delta } },
      data: { creditBalance: { increment: args.delta } },
    });
    if (r.count === 0) {
      const u = await tx.user.findUnique({ where: { id: args.userId }, select: { creditBalance: true } });
      throw paymentRequired(`Not enough credits: need ${-args.delta}, have ${u?.creditBalance ?? 0}`, {
        required: -args.delta,
        balance: u?.creditBalance ?? 0,
      });
    }
  } else if (args.delta > 0) {
    await tx.user.update({ where: { id: args.userId }, data: { creditBalance: { increment: args.delta } } });
  }
  const u = await tx.user.findUniqueOrThrow({ where: { id: args.userId }, select: { creditBalance: true } });
  return tx.creditLedger.create({
    data: {
      userId: args.userId,
      delta: args.delta,
      balanceAfter: u.creditBalance,
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
      jobId: args.jobId,
      note: args.note,
    },
  });
}

/** Check monthly spending limit (user-defined), throws 402 when exceeded. */
export async function assertWithinSpendingLimit(tx: Tx, userId: string, amount: number) {
  const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { monthlyCreditLimit: true } });
  if (u.monthlyCreditLimit == null) return;
  const spent = await monthlySpend(userId, tx);
  if (spent + amount > u.monthlyCreditLimit) {
    throw paymentRequired(
      `Monthly spending limit reached (${spent}/${u.monthlyCreditLimit} credits used; this job needs ${amount}). Raise your limit in Settings.`,
      { spent, limit: u.monthlyCreditLimit, required: amount },
    );
  }
}

/** Settle a job: release (reserved - charged). Idempotent. */
export async function settleJobCredits(jobId: string, charged: number) {
  return prisma.$transaction(async (tx) => {
    const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
    const finalCharge = Math.max(0, Math.min(job.creditsReserved, Math.round(charged)));
    const refund = job.creditsReserved - finalCharge;
    if (refund > 0) {
      await applyCredits(tx, {
        userId: job.userId,
        delta: refund,
        reason: 'JOB_RELEASE',
        idempotencyKey: `release:${jobId}`,
        jobId,
        note: finalCharge === 0 ? 'Job did not complete — full refund' : 'Unused reserved credits',
      });
    }
    await tx.job.update({ where: { id: jobId }, data: { creditsCharged: finalCharge } });
    return { charged: finalCharge, refunded: refund };
  });
}
