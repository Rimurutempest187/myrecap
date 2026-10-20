import { Hono } from 'hono';
import Stripe from 'stripe';
import { prisma, env, applyCredits, badRequest, notFound, logger, monthlySpend, AppError } from '@recap/core';
import { body, z } from '../lib/validate.js';
import { requireAuth } from '../lib/auth.js';
import { publicPlan } from '../lib/serialize.js';
import { effectivePlan } from '../lib/plan.js';
import type { AppEnv } from '../lib/types.js';

let stripeClient: Stripe | null = null;
function stripe(): Stripe {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new AppError(503, 'PAYMENTS_DISABLED', 'Payments are not configured on this server');
  if (!stripeClient) stripeClient = new Stripe(key);
  return stripeClient;
}

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.get('/summary', requireAuth, async (c) => {
  const user = c.get('user');
  const [ledger, subs, payments, spent, plan] = await Promise.all([
    prisma.creditLedger.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.subscription.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, include: { plan: true }, take: 5 }),
    prisma.payment.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    monthlySpend(user.id),
    effectivePlan(user),
  ]);
  const usage = await prisma.usageEvent.groupBy({
    by: ['kind'],
    where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } },
    _sum: { quantity: true, costUsd: true },
  });
  return c.json({
    balance: user.creditBalance,
    monthlySpent: spent,
    monthlyCreditLimit: user.monthlyCreditLimit,
    plan: publicPlan(plan),
    subscription: subs[0]
      ? { status: subs[0].status, plan: subs[0].plan.name, currentPeriodEnd: subs[0].currentPeriodEnd, cancelAtPeriodEnd: subs[0].cancelAtPeriodEnd }
      : null,
    ledger: ledger.map((l) => ({ id: l.id, delta: l.delta, balanceAfter: l.balanceAfter, reason: l.reason, note: l.note, jobId: l.jobId, createdAt: l.createdAt })),
    payments: payments.map((p) => ({ id: p.id, kind: p.kind, amountCents: p.amountCents, currency: p.currency, credits: p.credits, status: p.status, createdAt: p.createdAt })),
    usage30d: usage.map((u) => ({ kind: u.kind, quantity: u._sum.quantity ?? 0 })),
  });
});

async function ensureCustomer(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (u.stripeCustomerId) return u.stripeCustomerId;
  const cust = await stripe().customers.create({ email: u.email, name: u.name, metadata: { userId: u.id } });
  await prisma.user.update({ where: { id: u.id }, data: { stripeCustomerId: cust.id } });
  return cust.id;
}

billingRoutes.post('/checkout/subscription', requireAuth, async (c) => {
  const user = c.get('user');
  const b = await body(c, z.object({ planId: z.string() }));
  const plan = await prisma.plan.findFirst({ where: { id: b.planId, active: true } });
  if (!plan) throw notFound('Plan not found');
  if (!plan.stripePriceId) throw badRequest('This plan is not available for purchase');
  const customer = await ensureCustomer(user.id);
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: `${env().WEB_ORIGIN.split(',')[0]}/billing?status=success`,
    cancel_url: `${env().WEB_ORIGIN.split(',')[0]}/billing?status=cancelled`,
    client_reference_id: user.id,
    metadata: { userId: user.id, planId: plan.id, kind: 'SUBSCRIPTION' },
    subscription_data: { metadata: { userId: user.id, planId: plan.id } },
  });
  return c.json({ url: session.url });
});

billingRoutes.post('/checkout/credits', requireAuth, async (c) => {
  const user = c.get('user');
  const b = await body(c, z.object({ packId: z.string() }));
  const pack = await prisma.creditPack.findFirst({ where: { id: b.packId, active: true } });
  if (!pack) throw notFound('Credit pack not found');
  if (!pack.stripePriceId) throw badRequest('This pack is not available for purchase');
  const customer = await ensureCustomer(user.id);
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer,
    line_items: [{ price: pack.stripePriceId, quantity: 1 }],
    success_url: `${env().WEB_ORIGIN.split(',')[0]}/billing?status=success`,
    cancel_url: `${env().WEB_ORIGIN.split(',')[0]}/billing?status=cancelled`,
    client_reference_id: user.id,
    metadata: { userId: user.id, packId: pack.id, credits: String(pack.credits), kind: 'TOPUP' },
  });
  return c.json({ url: session.url });
});

billingRoutes.post('/portal', requireAuth, async (c) => {
  const customer = await ensureCustomer(c.get('user').id);
  const s = await stripe().billingPortal.sessions.create({ customer, return_url: `${env().WEB_ORIGIN.split(',')[0]}/billing` });
  return c.json({ url: s.url });
});

/** Stripe webhook — signature-verified, idempotent (payments keyed by provider ref, ledger keyed by event). */
billingRoutes.post('/webhook', async (c) => {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new AppError(503, 'PAYMENTS_DISABLED', 'Webhook secret not configured');
  const sig = c.req.header('stripe-signature');
  const raw = await c.req.text();
  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(raw, sig ?? '', secret);
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'stripe webhook signature failed');
    throw badRequest('Invalid signature');
  }
  try {
    await handleStripeEvent(event);
  } catch (e) {
    logger.error({ err: e, type: event.type }, 'stripe webhook handling failed');
    throw e; // Stripe retries on non-2xx
  }
  return c.json({ received: true });
});

async function handleStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = s.metadata?.userId;
      if (!userId || s.payment_status !== 'paid') return;
      if (s.metadata?.kind === 'TOPUP') {
        const credits = Number(s.metadata.credits ?? 0);
        await prisma.$transaction(async (tx) => {
          const existing = await tx.payment.findUnique({ where: { providerRef: s.id } });
          if (existing?.status === 'PAID') return;
          await tx.payment.upsert({
            where: { providerRef: s.id },
            create: { userId, providerRef: s.id, kind: 'TOPUP', amountCents: s.amount_total ?? 0, currency: s.currency ?? 'usd', credits, status: 'PAID' },
            update: { status: 'PAID' },
          });
          await applyCredits(tx, { userId, delta: credits, reason: 'PURCHASE', idempotencyKey: `stripe:${s.id}`, note: 'Credit pack purchase' });
        });
      }
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const userId = sub.metadata?.userId;
      const planId = sub.metadata?.planId;
      if (!userId || !planId) return;
      const statusMap: Record<string, 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE'> = {
        active: 'ACTIVE', trialing: 'ACTIVE', past_due: 'PAST_DUE', unpaid: 'PAST_DUE', canceled: 'CANCELED',
        incomplete: 'INCOMPLETE', incomplete_expired: 'CANCELED', paused: 'PAST_DUE',
      };
      const status = event.type === 'customer.subscription.deleted' ? 'CANCELED' : statusMap[sub.status] ?? 'INCOMPLETE';
      const periodEnd = (sub as any).current_period_end ?? (sub as any).items?.data?.[0]?.current_period_end;
      await prisma.subscription.upsert({
        where: { providerSubId: sub.id },
        create: { userId, planId, status, providerSubId: sub.id, currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null, cancelAtPeriodEnd: sub.cancel_at_period_end },
        update: { status, planId, currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null, cancelAtPeriodEnd: sub.cancel_at_period_end },
      });
      if (status === 'ACTIVE') await prisma.user.update({ where: { id: userId }, data: { planId } });
      if (status === 'CANCELED') {
        const free = await prisma.plan.findUnique({ where: { code: 'free' } });
        await prisma.user.update({ where: { id: userId }, data: { planId: free?.id ?? null } });
      }
      return;
    }
    case 'invoice.paid': {
      // Monthly credit grant for subscriptions — idempotent per invoice.
      const inv = event.data.object as Stripe.Invoice;
      const subId = (inv as any).subscription ?? (inv as any).parent?.subscription_details?.subscription;
      if (!subId) return;
      const sub = await prisma.subscription.findUnique({ where: { providerSubId: String(subId) }, include: { plan: true } });
      let userId = sub?.userId;
      let plan = sub?.plan;
      if (!sub) {
        const s = await stripe().subscriptions.retrieve(String(subId));
        userId = s.metadata?.userId;
        plan = s.metadata?.planId ? (await prisma.plan.findUnique({ where: { id: s.metadata.planId } })) ?? undefined : undefined;
      }
      if (!userId || !plan) return;
      await prisma.$transaction(async (tx) => {
        await tx.payment.upsert({
          where: { providerRef: inv.id! },
          create: { userId: userId!, providerRef: inv.id!, kind: 'SUBSCRIPTION', amountCents: inv.amount_paid, currency: inv.currency, credits: plan!.monthlyCredits, status: 'PAID' },
          update: { status: 'PAID' },
        });
        await applyCredits(tx, { userId: userId!, delta: plan!.monthlyCredits, reason: 'PLAN_GRANT', idempotencyKey: `invoice:${inv.id}`, note: `${plan!.name} monthly credits` });
      });
      return;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object as Stripe.Invoice;
      const subId = (inv as any).subscription ?? (inv as any).parent?.subscription_details?.subscription;
      if (subId) await prisma.subscription.updateMany({ where: { providerSubId: String(subId) }, data: { status: 'PAST_DUE' } });
      return;
    }
    default:
      return;
  }
}
