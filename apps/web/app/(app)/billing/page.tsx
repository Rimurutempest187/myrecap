'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, Coins, CreditCard, ExternalLink, TrendingDown } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { useAuth, useToast, type Plan } from '@/components/providers';
import { ErrorState, PageLoader, ProgressBar, Spinner } from '@/components/ui';

interface Summary {
  balance: number; monthlySpent: number; monthlyCreditLimit: number | null; plan: Plan;
  subscription: { status: string; plan: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  ledger: { id: string; delta: number; balanceAfter: number; reason: string; note: string | null; createdAt: string }[];
  payments: { id: string; kind: string; amountCents: number; currency: string; credits: number; status: string; createdAt: string }[];
  usage30d: { kind: string; quantity: number }[];
}
const REASON: Record<string, string> = { SIGNUP_BONUS: 'Welcome bonus', PLAN_GRANT: 'Plan credits', PURCHASE: 'Credit purchase', JOB_RESERVE: 'Job reserved', JOB_RELEASE: 'Refund / unused', ADMIN_ADJUST: 'Adjustment' };

function BillingInner() {
  const { refresh, user } = useAuth();
  const toast = useToast();
  const sp = useSearchParams();
  const [s, setS] = useState<Summary | null>(null);
  const [cfg, setCfg] = useState<{ plans: Plan[]; creditPacks: { id: string; name: string; credits: number; priceCents: number; purchasable: boolean }[]; paymentsEnabled: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [limit, setLimit] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api<Summary>('/billing/summary'), api('/config')]);
      setS(a);
      setCfg(b);
      setLimit(a.monthlyCreditLimit?.toString() ?? '');
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
    if (sp.get('status') === 'success') { toast('success', 'Payment successful — credits will appear shortly.'); refresh(); }
    if (sp.get('status') === 'cancelled') toast('info', 'Checkout cancelled');
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkout = async (kind: 'subscription' | 'credits', id: string) => {
    setBusy(id);
    try {
      const r = await api<{ url: string }>(`/billing/checkout/${kind}`, { body: kind === 'subscription' ? { planId: id } : { packId: id } });
      window.location.href = r.url;
    } catch (e: any) {
      toast('error', e.message);
      setBusy(null);
    }
  };
  const portal = async () => {
    try { window.location.href = (await api<{ url: string }>('/billing/portal', { method: 'POST' })).url; } catch (e: any) { toast('error', e.message); }
  };
  const saveLimit = async () => {
    try {
      await api('/auth/me', { method: 'PATCH', body: { monthlyCreditLimit: limit === '' ? null : Math.max(0, parseInt(limit, 10) || 0) } });
      toast('success', 'Spending limit saved');
      refresh();
      load();
    } catch (e: any) { toast('error', e.message); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!s || !cfg) return <PageLoader />;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Credits & plans</h1>
      <div className="grid sm:grid-cols-3 gap-4">
        <div className="card p-5"><p className="text-xs muted flex items-center gap-1"><Coins className="w-3 h-3" /> Balance</p><p className="text-3xl font-extrabold mt-1">{s.balance}</p><p className="text-xs muted">credits</p></div>
        <div className="card p-5"><p className="text-xs muted">Current plan</p><p className="text-2xl font-bold mt-1">{s.plan.name}</p><p className="text-xs muted">{s.plan.monthlyCredits} credits / month{s.subscription ? ` · ${s.subscription.status.toLowerCase()}` : ''}</p></div>
        <div className="card p-5">
          <p className="text-xs muted flex items-center gap-1"><TrendingDown className="w-3 h-3" /> Spent this month</p>
          <p className="text-2xl font-bold mt-1">{s.monthlySpent}{s.monthlyCreditLimit != null && <span className="text-base muted"> / {s.monthlyCreditLimit}</span>}</p>
          {s.monthlyCreditLimit != null && <ProgressBar value={(s.monthlySpent / Math.max(1, s.monthlyCreditLimit)) * 100} className="mt-2" />}
        </div>
      </div>

      <section className="card p-5 space-y-3">
        <h2 className="font-semibold">Monthly spending limit</h2>
        <p className="text-sm muted">Jobs that would exceed this many credits in a calendar month are blocked. Leave empty for no limit.</p>
        <div className="flex gap-2 max-w-sm">
          <input type="number" min={0} className="input" placeholder="No limit" value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Monthly credit limit" />
          <button className="btn btn-secondary" onClick={saveLimit}>Save</button>
        </div>
      </section>

      {!cfg.paymentsEnabled && <p className="text-sm text-amber-500 bg-amber-500/10 rounded-xl p-3">Online payments are not configured on this server yet. Contact the administrator to add credits.</p>}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-lg">Plans</h2>
          {s.subscription && cfg.paymentsEnabled && <button className="btn btn-secondary text-xs" onClick={portal}><ExternalLink className="w-4 h-4" /> Manage subscription</button>}
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          {cfg.plans.map((p) => {
            const current = user?.plan?.id === p.id;
            return (
              <div key={p.id} className={clsx('card p-5 flex flex-col', current && 'border-brand-500 ring-2 ring-brand-500/30')}>
                <div className="flex justify-between items-baseline">
                  <h3 className="font-bold text-lg">{p.name}</h3>
                  <p><span className="text-2xl font-extrabold">${(p.priceCents / 100).toFixed(2)}</span><span className="muted text-xs">/mo</span></p>
                </div>
                <ul className="mt-4 space-y-1.5 text-sm flex-1">
                  {p.features.map((f) => <li key={f} className="flex gap-2"><Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />{f}</li>)}
                </ul>
                {current ? (
                  <span className="btn btn-secondary mt-4 pointer-events-none">Current plan</span>
                ) : p.priceCents > 0 ? (
                  <button className="btn btn-primary mt-4" disabled={!p.purchasable || !cfg.paymentsEnabled || busy === p.id} onClick={() => checkout('subscription', p.id)}>
                    {busy === p.id ? <Spinner /> : <CreditCard className="w-4 h-4" />} {p.purchasable ? 'Subscribe' : 'Coming soon'}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="font-semibold text-lg mb-3">Buy credit packs</h2>
        <div className="grid sm:grid-cols-3 gap-4">
          {cfg.creditPacks.map((pk) => (
            <div key={pk.id} className="card p-5 flex items-center gap-4">
              <Coins className="w-8 h-8 text-amber-500" />
              <div className="flex-1"><p className="font-semibold">{pk.credits} credits</p><p className="text-xs muted">{pk.name} · ${(pk.priceCents / 100).toFixed(2)}</p></div>
              <button className="btn btn-secondary text-xs" disabled={!pk.purchasable || !cfg.paymentsEnabled || busy === pk.id} onClick={() => checkout('credits', pk.id)}>{busy === pk.id ? <Spinner /> : 'Buy'}</button>
            </div>
          ))}
        </div>
      </section>

      <section className="card overflow-hidden">
        <h2 className="font-semibold p-5 pb-3">Credit history</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs muted text-left"><tr><th className="px-5 py-2">Date</th><th className="px-5 py-2">Type</th><th className="px-5 py-2">Note</th><th className="px-5 py-2 text-right">Change</th><th className="px-5 py-2 text-right">Balance</th></tr></thead>
            <tbody className="divide-y divide-[var(--border)]">
              {s.ledger.map((l) => (
                <tr key={l.id}>
                  <td className="px-5 py-2 whitespace-nowrap muted">{new Date(l.createdAt).toLocaleString()}</td>
                  <td className="px-5 py-2 whitespace-nowrap">{REASON[l.reason] ?? l.reason}</td>
                  <td className="px-5 py-2 muted truncate max-w-xs">{l.note}</td>
                  <td className={clsx('px-5 py-2 text-right font-semibold tabular-nums', l.delta > 0 ? 'text-emerald-500' : 'text-red-400')}>{l.delta > 0 ? '+' : ''}{l.delta}</td>
                  <td className="px-5 py-2 text-right tabular-nums">{l.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default function BillingPage() {
  return <Suspense fallback={<PageLoader />}><BillingInner /></Suspense>;
}
