'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Activity, Users, ListChecks, CreditCard, Flag, Music, Settings, RefreshCw, XCircle, CheckCircle2, AlertTriangle, Upload } from 'lucide-react';
import { api, newRequestId, uploadWithProgress } from '@/lib/api';
import { useToast } from '@/components/providers';
import { ErrorState, Modal, PageLoader, StatusBadge, Spinner } from '@/components/ui';

const TABS = [
  { k: 'overview', l: 'Overview', i: Activity },
  { k: 'users', l: 'Users', i: Users },
  { k: 'jobs', l: 'Jobs', i: ListChecks },
  { k: 'plans', l: 'Plans & limits', i: CreditCard },
  { k: 'reports', l: 'Takedowns', i: Flag },
  { k: 'music', l: 'Music library', i: Music },
  { k: 'audit', l: 'Audit log', i: Settings },
] as const;
type Tab = (typeof TABS)[number]['k'];

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Admin dashboard</h1>
      <nav className="card p-1.5 flex gap-1 overflow-x-auto" aria-label="Admin sections">
        {TABS.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)} className={clsx('flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium whitespace-nowrap', tab === t.k ? 'bg-brand-500 text-white' : 'hover:bg-black/5 dark:hover:bg-white/5')}>
            <t.i className="w-4 h-4" /> {t.l}
          </button>
        ))}
      </nav>
      {tab === 'overview' && <Overview />}
      {tab === 'users' && <UsersTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'plans' && <PlansTab />}
      {tab === 'reports' && <ReportsTab />}
      {tab === 'music' && <MusicTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    return api<T>(path).then(setData).catch((e) => setError(e.message));
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, load };
}

function Stat({ label, value, sub, warn }: { label: string; value: string | number; sub?: string; warn?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs muted">{label}</p>
      <p className={clsx('text-2xl font-bold', warn && 'text-red-500')}>{value}</p>
      {sub && <p className="text-xs muted">{sub}</p>}
    </div>
  );
}

function Overview() {
  const { data: s, error, load } = useLoad<any>('/admin/stats');
  const { data: h } = useLoad<any>('/admin/health');
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!s) return <PageLoader />;
  const max = Math.max(1, ...s.daily.map((d: any) => d.jobs));
  const Check = ({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) => (
    <div className="flex items-center gap-2 text-sm">
      {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <AlertTriangle className="w-4 h-4 text-red-500" />}
      <span className="font-medium">{label}</span>
      {detail && <span className="muted text-xs truncate">{detail}</span>}
    </div>
  );
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Users" value={s.users} sub={`+${s.newUsers30d} in 30 days`} />
        <Stat label="Projects" value={s.projects} />
        <Stat label="Jobs (24h)" value={s.jobs24h} sub={`${s.failed24h} failed`} warn={s.failed24h > 0 && s.failed24h / Math.max(1, s.jobs24h) > 0.2} />
        <Stat label="Renders (30d)" value={s.renders30d} />
        <Stat label="Revenue (30d)" value={`$${(s.revenue30dCents / 100).toFixed(2)}`} />
        <Stat label="Provider cost (30d)" value={`$${s.providerCost30dUsd.toFixed(2)}`} sub="AI + TTS + render estimate" />
        <Stat label="Queue" value={s.queue ? `${(s.queue.waiting ?? 0) + (s.queue.prioritized ?? 0)} waiting` : 'n/a'} sub={s.queue ? `${s.queue.active} active · ${s.queue.failed} failed` : 'Redis unavailable'} />
        <Stat label="Open takedowns" value={s.openReports} warn={s.openReports > 0} />
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] gap-5">
        <section className="card p-5">
          <h3 className="font-semibold mb-4">Jobs per day (30 days)</h3>
          <div className="flex items-end gap-1 h-40">
            {s.daily.length === 0 && <p className="text-sm muted">No jobs yet</p>}
            {s.daily.map((d: any) => (
              <div key={d.day} className="flex-1 bg-gradient-to-t from-brand-600 to-accent-500 rounded-t" style={{ height: `${(d.jobs / max) * 100}%` }} title={`${new Date(d.day).toLocaleDateString()}: ${d.jobs} jobs, ${d.credits} credits`} />
            ))}
          </div>
        </section>
        <section className="card p-5 space-y-3">
          <h3 className="font-semibold">System health</h3>
          {h ? (
            <>
              <Check ok={h.db} label="PostgreSQL" />
              <Check ok={h.redis} label="Redis / BullMQ" />
              <Check ok={h.llmConfigured} label="LLM API" detail={h.llmConfigured ? 'configured' : 'missing LLM_API_KEY'} />
              <Check ok={h.tts.ok} label={`TTS (${h.tts.provider})`} detail={h.tts.detail} />
              <Check ok={h.storage !== 'local'} label={`Storage: ${h.storage}`} detail={h.storage === 'local' ? 'use R2 in production' : ''} />
              <Check ok={h.payments} label="Stripe payments" detail={h.payments ? '' : 'not configured'} />
            </>
          ) : (
            <Spinner />
          )}
        </section>
      </div>
    </div>
  );
}

function UsersTab() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const { data, error, load } = useLoad<{ items: any[]; total: number }>(`/admin/users?q=${encodeURIComponent(q)}`);
  const { data: plans } = useLoad<{ plans: any[] }>('/admin/plans');
  const [adj, setAdj] = useState<any>(null);
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const update = async (id: string, body: any) => {
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body });
      toast('success', 'User updated');
      load();
    } catch (e: any) {
      toast('error', e.message);
    }
  };
  const adjust = async () => {
    try {
      const r = await api<{ balance: number }>(`/admin/users/${adj.id}/credits`, { body: { delta: parseInt(delta, 10), note, requestId: newRequestId() } });
      toast('success', `New balance: ${r.balance}`);
      setAdj(null);
      setDelta('');
      setNote('');
      load();
    } catch (e: any) {
      toast('error', e.message);
    }
  };
  if (error) return <ErrorState message={error} onRetry={load} />;
  return (
    <div className="space-y-3">
      <input className="input max-w-sm" placeholder="Search email or name…" value={q} onChange={(e) => setQ(e.target.value)} />
      {!data ? (
        <PageLoader />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs muted text-left">
              <tr><th className="p-3">User</th><th className="p-3">Plan</th><th className="p-3">Credits</th><th className="p-3">Projects</th><th className="p-3">Role</th><th className="p-3">Status</th><th className="p-3"></th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {data.items.map((u) => (
                <tr key={u.id}>
                  <td className="p-3"><p className="font-medium">{u.name}</p><p className="text-xs muted">{u.email}</p></td>
                  <td className="p-3">
                    <select className="input !py-1 text-xs" value={u.plan?.id ?? ''} onChange={(e) => update(u.id, { planId: e.target.value || null })}>
                      <option value="">Free (default)</option>
                      {plans?.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td className="p-3 tabular-nums">{u.creditBalance}</td>
                  <td className="p-3">{u.projects}</td>
                  <td className="p-3">
                    <select className="input !py-1 text-xs" value={u.role} onChange={(e) => update(u.id, { role: e.target.value })}>
                      <option>USER</option><option>ADMIN</option>
                    </select>
                  </td>
                  <td className="p-3">
                    <button className={clsx('badge', u.status === 'ACTIVE' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-red-500/15 text-red-500')} onClick={() => update(u.id, { status: u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' })} title="Toggle suspension">
                      {u.status}
                    </button>
                  </td>
                  <td className="p-3"><button className="btn btn-secondary text-xs" onClick={() => setAdj(u)}>Credits</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!adj} onClose={() => setAdj(null)} title={`Adjust credits — ${adj?.email}`}>
        <div className="space-y-3">
          <div><label className="label">Change (+/-)</label><input type="number" className="input" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="e.g. 100 or -20" /></div>
          <div><label className="label">Reason</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Support compensation" /></div>
          <div className="flex justify-end gap-2"><button className="btn btn-secondary" onClick={() => setAdj(null)}>Cancel</button><button className="btn btn-primary" disabled={!delta || parseInt(delta, 10) === 0 || note.length < 3} onClick={adjust}>Apply</button></div>
        </div>
      </Modal>
    </div>
  );
}

function JobsTab() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const { data, error, load } = useLoad<{ items: any[] }>(`/admin/jobs?limit=100${status ? `&status=${status}` : ''}`);
  if (error) return <ErrorState message={error} onRetry={load} />;
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <select className="input max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['QUEUED', 'ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <button className="btn btn-secondary" onClick={load}><RefreshCw className="w-4 h-4" /></button>
      </div>
      {!data ? <PageLoader /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs muted text-left"><tr><th className="p-3">Job</th><th className="p-3">User / project</th><th className="p-3">Status</th><th className="p-3">Credits</th><th className="p-3">Cost</th><th className="p-3">Created</th><th className="p-3"></th></tr></thead>
            <tbody className="divide-y divide-[var(--border)]">
              {data.items.map((j) => (
                <tr key={j.id}>
                  <td className="p-3"><p className="font-medium">{j.type}</p><p className="text-[10px] muted font-mono">{j.id}</p></td>
                  <td className="p-3"><p className="text-xs">{j.userEmail}</p><p className="text-xs muted truncate max-w-[180px] my-text">{j.projectTitle}</p></td>
                  <td className="p-3"><StatusBadge status={j.status} /><p className="text-xs muted mt-1 max-w-[220px] truncate" title={j.error ?? j.stage}>{j.error ?? `${j.progress}% ${j.stage ?? ''}`}</p></td>
                  <td className="p-3 tabular-nums text-xs">{j.creditsCharged}/{j.creditsReserved}</td>
                  <td className="p-3 tabular-nums text-xs">${(j.actualCostUsd || 0).toFixed(4)}</td>
                  <td className="p-3 text-xs muted whitespace-nowrap">{new Date(j.createdAt).toLocaleString()}</td>
                  <td className="p-3">{['QUEUED', 'ACTIVE'].includes(j.status) && <button className="btn btn-secondary text-xs" onClick={async () => { await api(`/admin/jobs/${j.id}/cancel`, { method: 'POST' }).catch((e) => toast('error', e.message)); load(); }}><XCircle className="w-4 h-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PlansTab() {
  const toast = useToast();
  const { data, error, load } = useLoad<{ plans: any[]; packs: any[] }>('/admin/plans');
  const { data: settings, load: loadSettings } = useLoad<{ settings: any }>('/admin/settings');
  const [edit, setEdit] = useState<any>(null);
  const [limits, setLimits] = useState<{ signupBonusCredits: number; maintenanceMode: boolean } | null>(null);
  useEffect(() => {
    if (settings) setLimits(settings.settings.limits ?? { signupBonusCredits: 30, maintenanceMode: false });
  }, [settings]);
  const savePlan = async () => {
    const { id, purchasable, ...body } = edit;
    body.features = typeof body.features === 'string' ? body.features.split('\n').map((s: string) => s.trim()).filter(Boolean) : body.features;
    body.stripePriceId = body.stripePriceId || null;
    for (const k of ['priceCents', 'monthlyCredits', 'maxUploadMb', 'maxVideoMinutes', 'maxConcurrentJobs', 'maxOutputHeight', 'sortOrder']) body[k] = Number(body[k]);
    try {
      await api(id ? `/admin/plans/${id}` : '/admin/plans', { method: id ? 'PATCH' : 'POST', body });
      toast('success', 'Plan saved');
      setEdit(null);
      load();
    } catch (e: any) {
      toast('error', e.details ? JSON.stringify(e.details.fieldErrors) : e.message);
    }
  };
  const savePack = async (p: any) => {
    try {
      await api(`/admin/packs/${p.id}`, { method: 'PATCH', body: { stripePriceId: p.stripePriceId || null, active: p.active, credits: Number(p.credits), priceCents: Number(p.priceCents) } });
      toast('success', 'Pack saved');
      load();
    } catch (e: any) {
      toast('error', e.message);
    }
  };
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <PageLoader />;
  return (
    <div className="space-y-6">
      {limits && (
        <section className="card p-5 space-y-3">
          <h3 className="font-semibold">Global limits</h3>
          <div className="flex flex-wrap gap-4 items-end">
            <div><label className="label">Signup bonus credits</label><input type="number" min={0} className="input w-40" value={limits.signupBonusCredits} onChange={(e) => setLimits({ ...limits, signupBonusCredits: +e.target.value })} /></div>
            <button className="btn btn-primary" onClick={async () => { await api('/admin/settings/limits', { method: 'PUT', body: limits }).then(() => toast('success', 'Saved')).catch((e) => toast('error', e.message)); loadSettings(); }}>Save</button>
          </div>
        </section>
      )}
      <section className="space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="font-semibold">Subscription plans</h3>
          <button className="btn btn-secondary text-xs" onClick={() => setEdit({ code: '', name: '', priceCents: 0, currency: 'usd', monthlyCredits: 0, maxUploadMb: 500, maxVideoMinutes: 30, maxConcurrentJobs: 1, maxOutputHeight: 1080, watermark: false, stripePriceId: '', active: true, sortOrder: 9, features: '' })}>+ New plan</button>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs muted text-left"><tr><th className="p-3">Plan</th><th className="p-3">Price</th><th className="p-3">Credits/mo</th><th className="p-3">Upload</th><th className="p-3">Max length</th><th className="p-3">Concurrency</th><th className="p-3">Output</th><th className="p-3">Stripe</th><th className="p-3"></th></tr></thead>
            <tbody className="divide-y divide-[var(--border)]">
              {data.plans.map((p) => (
                <tr key={p.id} className={clsx(!p.active && 'opacity-50')}>
                  <td className="p-3 font-medium">{p.name} <span className="text-xs muted">({p.code})</span></td>
                  <td className="p-3">${(p.priceCents / 100).toFixed(2)}</td>
                  <td className="p-3">{p.monthlyCredits}</td>
                  <td className="p-3">{p.maxUploadMb} MB</td>
                  <td className="p-3">{p.maxVideoMinutes} min</td>
                  <td className="p-3">{p.maxConcurrentJobs}</td>
                  <td className="p-3">{p.maxOutputHeight}p{p.watermark ? ' + WM' : ''}</td>
                  <td className="p-3 text-xs">{p.stripePriceId ? '✓' : '—'}</td>
                  <td className="p-3"><button className="btn btn-secondary text-xs" onClick={() => setEdit({ ...p, features: (p.features ?? []).join('\n'), stripePriceId: p.stripePriceId ?? '' })}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="font-semibold">Credit packs</h3>
        <div className="grid md:grid-cols-3 gap-3">
          {data.packs.map((p) => <PackEditor key={p.id} pack={p} onSave={savePack} />)}
        </div>
      </section>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : 'New plan'}>
        {edit && (
          <div className="grid grid-cols-2 gap-3 text-sm">
            {[['code', 'Code'], ['name', 'Name'], ['priceCents', 'Price (cents)'], ['monthlyCredits', 'Credits / month'], ['maxUploadMb', 'Max upload MB'], ['maxVideoMinutes', 'Max video minutes'], ['maxConcurrentJobs', 'Concurrent jobs'], ['maxOutputHeight', 'Output height (480/720/1080)'], ['sortOrder', 'Sort order'], ['stripePriceId', 'Stripe price ID']].map(([k, l]) => (
              <div key={k}><label className="label">{l}</label><input className="input" value={edit[k] ?? ''} disabled={k === 'code' && !!edit.id} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></div>
            ))}
            <label className="flex items-center gap-2"><input type="checkbox" checked={edit.watermark} onChange={(e) => setEdit({ ...edit, watermark: e.target.checked })} /> Watermark</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
            <div className="col-span-2"><label className="label">Features (one per line)</label><textarea rows={4} className="input" value={edit.features} onChange={(e) => setEdit({ ...edit, features: e.target.value })} /></div>
            <div className="col-span-2 flex justify-end gap-2"><button className="btn btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" onClick={savePlan}>Save plan</button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function PackEditor({ pack, onSave }: { pack: any; onSave: (p: any) => void }) {
  const [p, setP] = useState({ ...pack, stripePriceId: pack.stripePriceId ?? '' });
  return (
    <div className="card p-4 space-y-2 text-sm">
      <p className="font-semibold">{p.name}</p>
      <div className="grid grid-cols-2 gap-2">
        <div><label className="label">Credits</label><input className="input" value={p.credits} onChange={(e) => setP({ ...p, credits: e.target.value })} /></div>
        <div><label className="label">Price (cents)</label><input className="input" value={p.priceCents} onChange={(e) => setP({ ...p, priceCents: e.target.value })} /></div>
      </div>
      <div><label className="label">Stripe price ID</label><input className="input" value={p.stripePriceId} onChange={(e) => setP({ ...p, stripePriceId: e.target.value })} placeholder="price_…" /></div>
      <div className="flex justify-between items-center">
        <label className="flex items-center gap-2"><input type="checkbox" checked={p.active} onChange={(e) => setP({ ...p, active: e.target.checked })} /> Active</label>
        <button className="btn btn-secondary text-xs" onClick={() => onSave(p)}>Save</button>
      </div>
    </div>
  );
}

function ReportsTab() {
  const toast = useToast();
  const { data, error, load } = useLoad<{ items: any[] }>('/admin/reports');
  const act = async (id: string, status: string, removeContent = false) => {
    const resolutionNote = prompt('Resolution note (optional)') ?? undefined;
    try {
      await api(`/admin/reports/${id}`, { method: 'PATCH', body: { status, removeContent, resolutionNote } });
      toast('success', removeContent ? 'Content removed and report actioned' : 'Report updated');
      load();
    } catch (e: any) {
      toast('error', e.message);
    }
  };
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <PageLoader />;
  if (!data.items.length) return <div className="card p-8 text-center muted text-sm">No takedown reports.</div>;
  return (
    <div className="space-y-3">
      {data.items.map((r) => (
        <article key={r.id} className="card p-4 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={clsx('badge', r.status === 'OPEN' ? 'bg-red-500/15 text-red-500' : r.status === 'ACTIONED' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-slate-500/15 text-slate-400')}>{r.status}</span>
            <span className="font-semibold text-sm">{r.rightsHolder}</span>
            <span className="text-xs muted">by {r.reporterName} &lt;{r.reporterEmail}&gt; · {new Date(r.createdAt).toLocaleString()}</span>
          </div>
          <p className="text-sm">{r.description}</p>
          <p className="text-xs muted">{r.contentUrl && <>URL: <a className="underline" href={r.contentUrl} target="_blank" rel="noreferrer noopener">{r.contentUrl}</a> · </>}{r.projectId && <>Project: <span className="font-mono">{r.projectId}</span></>}</p>
          {r.resolutionNote && <p className="text-xs muted">Note: {r.resolutionNote}</p>}
          {['OPEN', 'REVIEWING'].includes(r.status) && (
            <div className="flex gap-2 flex-wrap">
              <button className="btn btn-secondary text-xs" onClick={() => act(r.id, 'REVIEWING')}>Mark reviewing</button>
              {r.projectId && <button className="btn btn-danger text-xs" onClick={() => act(r.id, 'ACTIONED', true)}>Remove content</button>}
              <button className="btn btn-secondary text-xs" onClick={() => act(r.id, 'ACTIONED')}>Actioned</button>
              <button className="btn btn-secondary text-xs" onClick={() => act(r.id, 'REJECTED')}>Reject</button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function MusicTab() {
  const toast = useToast();
  const { data, error, load } = useLoad<{ items: any[] }>('/music');
  const [f, setF] = useState({ title: '', artist: '', license: '', licenseUrl: '', mood: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await api<{ trackId: string; upload: { url: string; headers: Record<string, string> } }>('/admin/music', {
        body: { ...f, licenseUrl: f.licenseUrl || undefined, mood: f.mood || undefined, sizeBytes: file.size },
      });
      await uploadWithProgress(r.upload.url, file, r.upload.headers, () => undefined);
      await api(`/admin/music/${r.trackId}/complete`, { method: 'POST' });
      toast('success', 'Track added');
      setF({ title: '', artist: '', license: '', licenseUrl: '', mood: '' });
      setFile(null);
      load();
    } catch (e: any) {
      toast('error', e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <section className="card p-5 space-y-3">
        <h3 className="font-semibold">Add licensed track (MP3)</h3>
        <p className="text-xs muted">Only upload music you have a license to redistribute in user videos (e.g. royalty-free with commercial use, CC-BY with attribution). The license is shown to users.</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <input className="input" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <input className="input" placeholder="Artist" value={f.artist} onChange={(e) => setF({ ...f, artist: e.target.value })} />
          <input className="input" placeholder="License (e.g. CC BY 4.0)" value={f.license} onChange={(e) => setF({ ...f, license: e.target.value })} />
          <input className="input" placeholder="License URL" value={f.licenseUrl} onChange={(e) => setF({ ...f, licenseUrl: e.target.value })} />
          <input className="input" placeholder="Mood (epic, calm…)" value={f.mood} onChange={(e) => setF({ ...f, mood: e.target.value })} />
          <input type="file" accept="audio/mpeg,.mp3" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <button className="btn btn-primary" disabled={busy || !file || !f.title || !f.artist || f.license.length < 2} onClick={upload}>{busy ? <Spinner /> : <Upload className="w-4 h-4" />} Upload track</button>
      </section>
      {error ? <ErrorState message={error} onRetry={load} /> : !data ? <PageLoader /> : (
        <div className="card divide-y divide-[var(--border)]">
          {data.items.length === 0 && <p className="p-5 text-sm muted">No tracks yet.</p>}
          {data.items.map((t) => (
            <div key={t.id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1"><p className="font-medium text-sm">{t.title} — {t.artist}</p><p className="text-xs muted">{t.license} · {Math.round(t.durationSec)}s {t.mood && `· ${t.mood}`}</p></div>
              <audio src={t.previewUrl.replace(/^https?:\/\/[^/]+(?=\/api\/storage\/local)/, '')} controls preload="none" className="h-8" />
              <button className="btn btn-secondary text-xs" onClick={async () => { await api(`/admin/music/${t.id}`, { method: 'PATCH', body: { active: false } }); load(); }}>Disable</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AuditTab() {
  const { data, error, load } = useLoad<{ items: any[] }>('/admin/audit');
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <PageLoader />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs muted text-left"><tr><th className="p-3">Time</th><th className="p-3">Actor</th><th className="p-3">Action</th><th className="p-3">Target</th><th className="p-3">IP</th></tr></thead>
        <tbody className="divide-y divide-[var(--border)]">
          {data.items.map((a) => (
            <tr key={a.id}>
              <td className="p-3 text-xs muted whitespace-nowrap">{new Date(a.createdAt).toLocaleString()}</td>
              <td className="p-3 text-xs">{a.actorEmail ?? '—'}</td>
              <td className="p-3 font-mono text-xs">{a.action}</td>
              <td className="p-3 text-xs muted">{a.targetType} {a.targetId?.slice(0, 10)}</td>
              <td className="p-3 text-xs muted">{a.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
