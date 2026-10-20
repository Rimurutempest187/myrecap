'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { SiteHeader, SiteFooter } from '@/components/site-header';
import { api } from '@/lib/api';
import { PageLoader } from '@/components/ui';
import type { Plan } from '@/components/providers';

export default function PricingPage() {
  const [cfg, setCfg] = useState<{ plans: Plan[]; creditRules: Record<string, number> } | null>(null);
  useEffect(() => {
    api('/config').then(setCfg).catch(() => setCfg({ plans: [], creditRules: {} }));
  }, []);
  return (
    <>
      <SiteHeader />
      <main className="max-w-6xl mx-auto px-4 py-16">
        <h1 className="text-4xl font-extrabold text-center">Simple, credit-based pricing</h1>
        <p className="muted text-center mt-3">Credits are reserved before each job and unused credits are refunded automatically. Failed or cancelled jobs cost nothing.</p>
        {!cfg ? (
          <PageLoader />
        ) : (
          <>
            <div className="grid md:grid-cols-3 gap-5 mt-12">
              {cfg.plans.map((p, i) => (
                <div key={p.id} className={`card p-7 flex flex-col ${i === 1 ? 'border-brand-500 ring-2 ring-brand-500/30' : ''}`}>
                  {i === 1 && <span className="badge bg-brand-500 text-white self-start mb-3">Most popular</span>}
                  <h2 className="text-xl font-bold">{p.name}</h2>
                  <p className="mt-3">
                    <span className="text-4xl font-extrabold">${(p.priceCents / 100).toFixed(p.priceCents % 100 ? 2 : 0)}</span>
                    <span className="muted">/month</span>
                  </p>
                  <ul className="mt-6 space-y-2 text-sm flex-1">
                    {p.features.map((f) => (
                      <li key={f} className="flex gap-2">
                        <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" /> {f}
                      </li>
                    ))}
                  </ul>
                  <Link href={p.priceCents ? '/billing' : '/register'} className={`btn mt-6 ${i === 1 ? 'btn-primary' : 'btn-secondary'}`}>
                    {p.priceCents ? 'Choose plan' : 'Start free'}
                  </Link>
                </div>
              ))}
            </div>
            <section className="card p-6 mt-10">
              <h2 className="font-semibold mb-3">What does a recap cost?</h2>
              <ul className="text-sm muted grid sm:grid-cols-3 gap-3">
                <li><b className="text-[var(--text)]">AI analysis:</b> {cfg.creditRules.analyzePerSourceMinute} credit per source minute (min {cfg.creditRules.analyzeMin}, max {cfg.creditRules.analyzeMax})</li>
                <li><b className="text-[var(--text)]">Myanmar voiceover:</b> 1 credit per {cfg.creditRules.voicePerChars} characters</li>
                <li><b className="text-[var(--text)]">Rendering:</b> {cfg.creditRules.renderPerOutputMinute} credits per output minute</li>
              </ul>
              <p className="text-xs muted mt-3">Example: a 20-minute episode → 60-second Myanmar short ≈ 20 + 2 + 3 = 25 credits.</p>
            </section>
          </>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
