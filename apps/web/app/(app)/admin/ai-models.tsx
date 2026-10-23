'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { KeyRound, Plus, Trash2, PlugZap, Search, CheckCircle2, AlertTriangle, Play, Save, Cpu, Mic, Eye, Route, Power, ExternalLink, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/components/providers';
import { ErrorState, Modal, PageLoader, Spinner } from '@/components/ui';

type Provider = {
  id: string; name: string; kind: string; label: string; baseUrl: string | null; effectiveBaseUrl: string | null; hasKey: boolean; keyHint: string | null;
  region: string | null; enabled: boolean; lastTestAt: string | null; lastTestOk: boolean | null; lastTestMessage: string | null; models?: number;
};
type Model = {
  id: string; providerId: string; kind: 'CHAT' | 'TTS_VOICE' | 'STT'; modelId: string; displayName: string; supportsVision: boolean; jsonMode: boolean;
  inputUsdPer1M: number; outputUsdPer1M: number; unitUsdPer1M: number; creditMultiplier: number; userSelectable: boolean; enabled: boolean; sortOrder: number;
  description: string | null; provider: { id: string; name: string; kind: string; enabled: boolean }; calls30d: number; cost30dUsd: number;
};
type Catalog = { providers: Array<{ kind: string; label: string; baseUrl?: string; capabilities: string[]; keyRequired: boolean; docs: string; presets: any[] }>; secretsKeyConfigured: boolean };
type TaskRoute = { primary: string | null; fallbacks: string[] };
type Routing = { vision: TaskRoute; script: TaskRoute; stt: TaskRoute; defaultVoice: string | null; allowUserModelChoice: boolean };

const KIND_LABEL = { CHAT: 'Chat / LLM', TTS_VOICE: 'Voice (TTS)', STT: 'Speech-to-text' } as const;
const KIND_ICON = { CHAT: Cpu, TTS_VOICE: Mic, STT: Mic } as const;

export function AiModelsTab() {
  const toast = useToast();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [envModels, setEnvModels] = useState<any[]>([]);
  const [routing, setRouting] = useState<Routing | null>(null);
  const [error, setError] = useState('');
  const [addProv, setAddProv] = useState(false);
  const [editProv, setEditProv] = useState<Provider | null>(null);
  const [addModelFor, setAddModelFor] = useState<Provider | null>(null);
  const [discover, setDiscover] = useState<{ p: Provider; items: any[] | null; q: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string; audio?: string }>>({});

  const load = useCallback(async () => {
    setError('');
    try {
      const [c, p, m, r] = await Promise.all([
        api<Catalog>('/admin/ai/catalog'),
        api<{ items: Provider[] }>('/admin/ai/providers'),
        api<{ items: Model[]; envModels: any[] }>('/admin/ai/models'),
        api<{ routing: Routing }>('/admin/ai/routing'),
      ]);
      setCatalog(c);
      setProviders(p.items);
      setModels(m.items);
      setEnvModels(m.envModels);
      setRouting(r.routing);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast('success', ok);
      await load();
      return r;
    } catch (e: any) {
      toast('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const testProvider = (p: Provider) =>
    act(`tp:${p.id}`, async () => {
      const r = await api<{ ok: boolean; message: string }>(`/admin/ai/providers/${p.id}/test`, { method: 'POST' });
      toast(r.ok ? 'success' : 'error', `${p.name}: ${r.message}`);
    });

  const testModel = async (m: Model) => {
    setBusy(`tm:${m.id}`);
    try {
      const r = await api<any>(`/admin/ai/models/${m.id}/test`, { method: 'POST' });
      setTestResult((t) => ({ ...t, [m.id]: { ok: r.ok, text: r.ok ? `${r.output ?? 'Voice sample ready'} · ${r.ms}ms` : r.error, audio: r.audio } }));
    } catch (e: any) {
      setTestResult((t) => ({ ...t, [m.id]: { ok: false, text: e.message } }));
    } finally {
      setBusy(null);
    }
  };

  const patchModel = (m: Model, body: Partial<Model>) => act(`pm:${m.id}`, () => api(`/admin/ai/models/${m.id}`, { method: 'PATCH', body }));

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!providers || !catalog || !routing) return <PageLoader />;

  const enabledModels = models.filter((m) => m.enabled && m.provider.enabled);
  const groups = (['CHAT', 'TTS_VOICE', 'STT'] as const).map((k) => ({ kind: k, items: models.filter((m) => m.kind === k) }));

  return (
    <div className="space-y-6">
      <div className="card p-5 flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2"><KeyRound className="w-5 h-5 text-brand-500" /> AI providers & models</h2>
          <p className="text-sm muted max-w-2xl">
            Add an API key per provider, enable the models you want, then route each task (vision analysis, Burmese script writing, speech-to-text) to a primary model with fallbacks.
            Keys are encrypted (AES-256-GCM) and never shown again. If a model fails (rate limit, outage, bad key) the next one runs automatically.
          </p>
          {!catalog.secretsKeyConfigured && (
            <p className="text-xs text-amber-500 mt-2 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> SECRETS_KEY is not set — keys are encrypted with SESSION_SECRET. Set a dedicated SECRETS_KEY in production before adding keys.</p>
          )}
        </div>
        <button className="btn btn-primary shrink-0" onClick={() => setAddProv(true)}><Plus className="w-4 h-4" /> Add provider key</button>
      </div>

      {!models.some((m) => m.kind === 'TTS_VOICE' && m.enabled && m.provider.kind !== 'ESPEAK') && providers.some((p) => p.kind === 'GEMINI') && (
        <div className="card p-4 border-amber-500/40 bg-amber-500/5 text-sm flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <p><b>No natural Myanmar voice yet.</b> Your Gemini key can also speak Burmese — no Azure key needed. Click <b>Recommended</b> on the Gemini card to add 8 Burmese voices and dialogue transcription.</p>
        </div>
      )}

      {/* Providers */}
      <section className="space-y-3">
        <h3 className="font-semibold">Providers</h3>
        {providers.length === 0 && (
          <div className="card p-6 text-sm muted">
            No providers yet. {envModels.length > 0 ? 'The models from environment variables below are being used as a fallback.' : 'AI analysis is disabled until you add a provider.'}
          </div>
        )}
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {providers.map((p) => (
            <article key={p.id} className={clsx('card p-4 space-y-3', !p.enabled && 'opacity-60')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{p.name}</p>
                  <p className="text-xs muted">{p.label}{p.region ? ` · ${p.region}` : ''}</p>
                </div>
                {p.lastTestOk === true && <span className="badge bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Key OK</span>}
                {p.lastTestOk === false && <span className="badge bg-red-500/15 text-red-500">Key failed</span>}
                {p.lastTestOk === null && <span className="badge bg-slate-500/15">Untested</span>}
              </div>
              <div className="text-xs space-y-1">
                <p className="flex items-center gap-1.5"><KeyRound className="w-3.5 h-3.5 muted" /> {p.hasKey ? <code>{p.keyHint}</code> : <span className="muted">no key</span>}</p>
                {p.effectiveBaseUrl && <p className="muted truncate" title={p.effectiveBaseUrl}>{p.effectiveBaseUrl}</p>}
                <p className="muted">{p.models ?? 0} model(s)</p>
                {p.lastTestMessage && <p className={clsx('line-clamp-2', p.lastTestOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')} title={p.lastTestMessage}>{p.lastTestMessage}</p>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button className="btn btn-secondary !py-1.5 !px-2.5 text-xs" disabled={busy === `tp:${p.id}`} onClick={() => testProvider(p)}>
                  {busy === `tp:${p.id}` ? <Spinner /> : <PlugZap className="w-3.5 h-3.5" />} Test key
                </button>
                <button className="btn btn-secondary !py-1.5 !px-2.5 text-xs" onClick={() => setAddModelFor(p)}><Plus className="w-3.5 h-3.5" /> Model</button>
                {(catalog.providers.find((x) => x.kind === p.kind)?.presets.length ?? 0) > 0 && (
                  <button
                    className="btn btn-secondary !py-1.5 !px-2.5 text-xs"
                    disabled={busy === `pr:${p.id}`}
                    title="Add the recommended chat models, Burmese voices and speech-to-text for this provider"
                    onClick={() => act(`pr:${p.id}`, async () => { const r = await api<{ added: number }>(`/admin/ai/providers/${p.id}/presets`, { method: 'POST', body: {} }); toast('success', r.added ? `${r.added} recommended model(s)/voice(s) added` : 'All recommended models are already added'); })}
                  >
                    {busy === `pr:${p.id}` ? <Spinner /> : <Sparkles className="w-3.5 h-3.5" />} Recommended
                  </button>
                )}
                <button
                  className="btn btn-secondary !py-1.5 !px-2.5 text-xs"
                  onClick={async () => {
                    setDiscover({ p, items: null, q: '' });
                    try {
                      const r = await api<{ items: any[] }>(`/admin/ai/providers/${p.id}/discover`);
                      setDiscover({ p, items: r.items, q: '' });
                    } catch (e: any) {
                      toast('error', e.message);
                      setDiscover(null);
                    }
                  }}
                >
                  <Search className="w-3.5 h-3.5" /> Browse
                </button>
                <button className="btn btn-ghost !py-1.5 !px-2.5 text-xs" onClick={() => setEditProv(p)}>Edit</button>
                <button className="btn btn-ghost !py-1.5 !px-2.5 text-xs" title={p.enabled ? 'Disable' : 'Enable'} onClick={() => act(`ep:${p.id}`, () => api(`/admin/ai/providers/${p.id}`, { method: 'PATCH', body: { enabled: !p.enabled } }))}>
                  <Power className="w-3.5 h-3.5" />
                </button>
                <button
                  className="btn btn-ghost !py-1.5 !px-2.5 text-xs text-red-500"
                  onClick={() => confirm(`Delete ${p.name} and its ${p.models ?? 0} models? The API key is erased.`) && act(`dp:${p.id}`, () => api(`/admin/ai/providers/${p.id}`, { method: 'DELETE' }), 'Provider deleted')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Routing */}
      <RoutingEditor routing={routing} models={enabledModels} envModels={envModels} onSaved={load} />

      {/* Models */}
      {groups.map((g) => {
        const Icon = KIND_ICON[g.kind];
        return (
          <section key={g.kind} className="card overflow-hidden">
            <header className="px-5 py-3 border-b border-[var(--border)] flex items-center gap-2">
              <Icon className="w-4 h-4 text-brand-500" />
              <h3 className="font-semibold">{KIND_LABEL[g.kind]}</h3>
              <span className="text-xs muted">({g.items.length})</span>
            </header>
            {g.items.length === 0 ? (
              <p className="p-5 text-sm muted">No {KIND_LABEL[g.kind].toLowerCase()} models. Add one from a provider card.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs muted text-left">
                    <tr className="border-b border-[var(--border)]">
                      <th className="px-4 py-2">Model</th>
                      <th className="px-4 py-2">Provider</th>
                      <th className="px-4 py-2">{g.kind === 'CHAT' ? 'Price in/out (per 1M tok)' : g.kind === 'STT' ? 'USD / min' : 'USD / 1M chars'}</th>
                      {g.kind === 'CHAT' && <th className="px-4 py-2">Credit ×</th>}
                      {g.kind === 'CHAT' && <th className="px-4 py-2">User can pick</th>}
                      <th className="px-4 py-2">30d usage</th>
                      <th className="px-4 py-2">Enabled</th>
                      <th className="px-4 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((m) => (
                      <tr key={m.id} className="border-b border-[var(--border)] last:border-0 align-top">
                        <td className="px-4 py-2.5">
                          <p className="font-medium flex items-center gap-1.5">{m.displayName}{m.supportsVision && <Eye className="w-3.5 h-3.5 text-accent-500" aria-label="Vision" />}</p>
                          <p className="text-xs muted font-mono">{m.modelId}</p>
                          {testResult[m.id] && (
                            <div className={clsx('mt-1 text-xs max-w-sm break-words', testResult[m.id].ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500')}>
                              {testResult[m.id].text}
                              {testResult[m.id].audio && <audio controls src={testResult[m.id].audio} className="mt-1 h-8 w-full" />}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs">{m.provider.name}{!m.provider.enabled && <span className="text-red-500"> (disabled)</span>}</td>
                        <td className="px-4 py-2.5 text-xs whitespace-nowrap">{g.kind === 'CHAT' ? `$${m.inputUsdPer1M} / $${m.outputUsdPer1M}` : `$${m.unitUsdPer1M}`}</td>
                        {g.kind === 'CHAT' && (
                          <td className="px-4 py-2.5">
                            <input
                              type="number"
                              step="0.1"
                              min="0.1"
                              max="20"
                              defaultValue={m.creditMultiplier}
                              className="input !py-1 !px-2 w-20 text-xs"
                              onBlur={(e) => Number(e.target.value) !== m.creditMultiplier && patchModel(m, { creditMultiplier: Number(e.target.value) })}
                              aria-label="Credit multiplier"
                            />
                          </td>
                        )}
                        {g.kind === 'CHAT' && (
                          <td className="px-4 py-2.5"><Toggle on={m.userSelectable} onChange={(v) => patchModel(m, { userSelectable: v })} label="User selectable" /></td>
                        )}
                        <td className="px-4 py-2.5 text-xs whitespace-nowrap">{m.calls30d} calls · ${m.cost30dUsd}</td>
                        <td className="px-4 py-2.5"><Toggle on={m.enabled} onChange={(v) => patchModel(m, { enabled: v })} label="Enabled" /></td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          <button className="btn btn-secondary !py-1 !px-2 text-xs" disabled={busy === `tm:${m.id}`} onClick={() => testModel(m)}>
                            {busy === `tm:${m.id}` ? <Spinner /> : <Play className="w-3.5 h-3.5" />} Test
                          </button>
                          <button className="btn btn-ghost !py-1 !px-2 text-xs text-red-500" onClick={() => confirm(`Remove ${m.displayName}?`) && act(`dm:${m.id}`, () => api(`/admin/ai/models/${m.id}`, { method: 'DELETE' }), 'Model removed')} aria-label="Delete model">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      {envModels.length > 0 && (
        <section className="card p-5">
          <h3 className="font-semibold mb-1">Environment fallback models</h3>
          <p className="text-xs muted mb-3">From .env (LLM_*, AZURE_SPEECH_*, STT_*, TTS_PROVIDER). Used only for model types that have nothing configured above.</p>
          <ul className="text-sm space-y-1">
            {envModels.map((m) => (
              <li key={m.id} className="flex gap-2"><span className="badge bg-slate-500/15">{KIND_LABEL[m.kind as keyof typeof KIND_LABEL]}</span>{m.displayName} <span className="muted text-xs">{m.provider}</span></li>
            ))}
          </ul>
        </section>
      )}

      <AddProviderModal open={addProv} catalog={catalog} onClose={() => setAddProv(false)} onDone={load} />
      {editProv && <EditProviderModal p={editProv} onClose={() => setEditProv(null)} onDone={load} />}
      {addModelFor && <AddModelModal p={addModelFor} catalog={catalog} onClose={() => setAddModelFor(null)} onDone={load} />}
      {discover && (
        <Modal open onClose={() => setDiscover(null)} title={`Models available on ${discover.p.name}`}>
          {!discover.items ? (
            <div className="py-8 flex justify-center"><Spinner /></div>
          ) : (
            <DiscoverList p={discover.p} items={discover.items} onAdded={load} />
          )}
        </Modal>
      )}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={clsx('w-10 h-6 rounded-full relative transition-colors', on ? 'bg-brand-500' : 'bg-slate-400/40')}>
      <span className={clsx('absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

function RoutingEditor({ routing, models, envModels, onSaved }: { routing: Routing; models: Model[]; envModels: any[]; onSaved: () => void }) {
  const toast = useToast();
  const [r, setR] = useState<Routing>(routing);
  const [saving, setSaving] = useState(false);
  useEffect(() => setR(routing), [routing]);
  const all = useMemo(
    () => [...models.map((m) => ({ id: m.id, kind: m.kind, label: `${m.displayName} — ${m.provider.name}`, vision: m.supportsVision })), ...envModels.map((m) => ({ id: m.id, kind: m.kind, label: m.displayName, vision: m.supportsVision }))],
    [models, envModels],
  );
  const opts = (task: 'vision' | 'script' | 'stt') => all.filter((m) => (task === 'stt' ? m.kind === 'STT' : m.kind === 'CHAT') && (task !== 'vision' || m.vision));
  const voices = all.filter((m) => m.kind === 'TTS_VOICE');
  const TASKS = [
    { k: 'vision' as const, l: 'Vision analysis', d: 'Looks at key frames of every scene and describes what happens' },
    { k: 'script' as const, l: 'Burmese script writer', d: 'Selects the best scenes and writes Myanmar narration (default for users)' },
    { k: 'stt' as const, l: 'Speech-to-text', d: 'Transcribes original dialogue so the story is accurate (optional)' },
  ];
  const save = async () => {
    setSaving(true);
    try {
      await api('/admin/ai/routing', { method: 'PUT', body: r });
      toast('success', 'Routing saved — new jobs use it within 15 seconds');
      onSaved();
    } catch (e: any) {
      toast('error', e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="card p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold flex items-center gap-2"><Route className="w-4 h-4 text-brand-500" /> Task routing</h3>
        <button className="btn btn-primary !py-1.5" onClick={save} disabled={saving}>{saving ? <Spinner /> : <Save className="w-4 h-4" />} Save routing</button>
      </div>
      <div className="grid lg:grid-cols-3 gap-4">
        {TASKS.map((t) => {
          const o = opts(t.k);
          const route = r[t.k];
          return (
            <div key={t.k} className="rounded-xl border border-[var(--border)] p-4 space-y-2">
              <p className="font-medium text-sm">{t.l}</p>
              <p className="text-xs muted">{t.d}</p>
              <label className="label !mt-2">Primary</label>
              <select className="input" value={route.primary ?? ''} onChange={(e) => setR({ ...r, [t.k]: { ...route, primary: e.target.value || null } })}>
                <option value="">Auto (first enabled model)</option>
                {o.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <label className="label">Fallbacks (in order)</label>
              {route.fallbacks.map((f, i) => (
                <div key={i} className="flex gap-1.5">
                  <select className="input" value={f} onChange={(e) => { const fb = [...route.fallbacks]; fb[i] = e.target.value; setR({ ...r, [t.k]: { ...route, fallbacks: fb } }); }}>
                    {o.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  <button className="btn btn-ghost !px-2" aria-label="Remove fallback" onClick={() => setR({ ...r, [t.k]: { ...route, fallbacks: route.fallbacks.filter((_, j) => j !== i) } })}><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
              {o.length > 0 && route.fallbacks.length < 5 && (
                <button className="btn btn-ghost !py-1 text-xs" onClick={() => setR({ ...r, [t.k]: { ...route, fallbacks: [...route.fallbacks, o.find((m) => m.id !== route.primary && !route.fallbacks.includes(m.id))?.id ?? o[0].id] } })}>
                  <Plus className="w-3.5 h-3.5" /> Add fallback
                </button>
              )}
              {o.length === 0 && <p className="text-xs text-amber-500">No suitable model enabled{t.k === 'vision' ? ' (needs vision support)' : ''}.</p>}
            </div>
          );
        })}
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Default voice for new projects</label>
          <select className="input" value={r.defaultVoice ?? ''} onChange={(e) => setR({ ...r, defaultVoice: e.target.value || null })}>
            <option value="">First enabled voice</option>
            {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-3 text-sm sm:mt-6">
          <Toggle on={r.allowUserModelChoice} onChange={(v) => setR({ ...r, allowUserModelChoice: v })} label="Allow users to choose model" />
          Let users pick the script model (only models marked “User can pick”)
        </label>
      </div>
    </section>
  );
}

function AddProviderModal({ open, catalog, onClose, onDone }: { open: boolean; catalog: Catalog; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState('GEMINI');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [region, setRegion] = useState('');
  const [presets, setPresets] = useState(true);
  const [saving, setSaving] = useState(false);
  const def = catalog.providers.find((p) => p.kind === kind)!;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { provider } = await api<{ provider: Provider }>('/admin/ai/providers', { method: 'POST', body: { kind, name: name || def.label, apiKey: apiKey || undefined, baseUrl: baseUrl || null, region: region || null, addPresets: presets } });
      // Validate the key straight away so the admin knows it works.
      if (provider.hasKey || kind === 'ESPEAK' || kind === 'OPENAI_COMPATIBLE') {
        const t = await api<{ ok: boolean; message: string }>(`/admin/ai/providers/${provider.id}/test`, { method: 'POST' }).catch((er) => ({ ok: false, message: er.message }));
        toast(t.ok ? 'success' : 'error', `${provider.name}: ${t.message}`);
      } else toast('success', 'Provider added');
      setApiKey('');
      setName('');
      setBaseUrl('');
      setRegion('');
      onClose();
      onDone();
    } catch (er: any) {
      toast('error', er.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add provider API key">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Provider</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {catalog.providers.map((p) => <option key={p.kind} value={p.kind}>{p.label}</option>)}
          </select>
          <p className="text-xs muted mt-1">
            Supports: {def.capabilities.map((c) => KIND_LABEL[c as keyof typeof KIND_LABEL]).join(', ')}
            {def.docs && <> · <a href={def.docs} target="_blank" rel="noreferrer" className="text-brand-500 inline-flex items-center gap-0.5">Get a key <ExternalLink className="w-3 h-3" /></a></>}
          </p>
        </div>
        <div>
          <label className="label">Display name</label>
          <input className="input" placeholder={def.label} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </div>
        {kind !== 'ESPEAK' && (
          <div>
            <label className="label">API key {def.keyRequired ? '' : '(optional)'}</label>
            <input className="input font-mono" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required={def.keyRequired} placeholder="Paste key — stored encrypted" />
          </div>
        )}
        {(kind === 'OPENAI_COMPATIBLE' || (kind !== 'AZURE_SPEECH' && kind !== 'ESPEAK')) && (
          <div>
            <label className="label">Base URL {kind === 'OPENAI_COMPATIBLE' ? '' : '(optional override)'}</label>
            <input className="input font-mono text-xs" type="url" placeholder={def.baseUrl ?? 'https://host/v1'} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required={kind === 'OPENAI_COMPATIBLE'} />
          </div>
        )}
        {kind === 'AZURE_SPEECH' && (
          <div>
            <label className="label">Region</label>
            <input className="input" placeholder="southeastasia" value={region} onChange={(e) => setRegion(e.target.value)} required />
          </div>
        )}
        {def.presets.length > 0 && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={presets} onChange={(e) => setPresets(e.target.checked)} className="mt-1" />
            <span>Add recommended models: <span className="muted">{def.presets.map((p) => p.displayName).join(', ')}</span></span>
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving}>{saving ? <Spinner /> : <KeyRound className="w-4 h-4" />} Save & test</button>
        </div>
      </form>
    </Modal>
  );
}

function EditProviderModal({ p, onClose, onDone }: { p: Provider; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(p.name);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? '');
  const [region, setRegion] = useState(p.region ?? '');
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api(`/admin/ai/providers/${p.id}`, { method: 'PATCH', body: { name, baseUrl: baseUrl || null, region: region || null, ...(apiKey ? { apiKey } : {}) } });
      toast('success', apiKey ? 'Key rotated' : 'Saved');
      onClose();
      onDone();
    } catch (er: any) {
      toast('error', er.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${p.name}`}>
      <form onSubmit={submit} className="space-y-3">
        <div><label className="label">Display name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></div>
        {p.kind !== 'ESPEAK' && (
          <div>
            <label className="label">Replace API key {p.hasKey && <span className="font-normal">(current: <code>{p.keyHint}</code>)</span>}</label>
            <input className="input font-mono" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Leave empty to keep the current key" />
          </div>
        )}
        {p.kind !== 'AZURE_SPEECH' && p.kind !== 'ESPEAK' && <div><label className="label">Base URL</label><input className="input font-mono text-xs" type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={p.effectiveBaseUrl ?? ''} /></div>}
        {p.kind === 'AZURE_SPEECH' && <div><label className="label">Region</label><input className="input" value={region} onChange={(e) => setRegion(e.target.value)} /></div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving}>{saving ? <Spinner /> : <Save className="w-4 h-4" />} Save</button>
        </div>
      </form>
    </Modal>
  );
}

function AddModelModal({ p, catalog, onClose, onDone, initial }: { p: Provider; catalog: Catalog; onClose: () => void; onDone: () => void; initial?: { kind: string; modelId: string; label?: string } }) {
  const toast = useToast();
  const def = catalog.providers.find((x) => x.kind === p.kind)!;
  const [f, setF] = useState({
    kind: initial?.kind ?? def.capabilities[0],
    modelId: initial?.modelId ?? '',
    displayName: initial?.label ?? initial?.modelId ?? '',
    supportsVision: false,
    inputUsdPer1M: 0,
    outputUsdPer1M: 0,
    unitUsdPer1M: 0,
    creditMultiplier: 1,
    userSelectable: true,
    description: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api('/admin/ai/models', { method: 'POST', body: { ...f, providerId: p.id, userSelectable: f.kind === 'CHAT' && f.userSelectable, description: f.description || null } });
      toast('success', `${f.displayName} added`);
      onClose();
      onDone();
    } catch (er: any) {
      toast('error', er.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Add model to ${p.name}`}>
      <form onSubmit={submit} className="space-y-3">
        {def.presets.length > 0 && (
          <div>
            <label className="label">Quick fill</label>
            <div className="flex flex-wrap gap-1.5">
              {def.presets.map((pr) => (
                <button type="button" key={pr.modelId} className="btn btn-secondary !py-1 !px-2 text-xs" onClick={() => setF((x) => ({ ...x, ...pr, description: pr.description ?? '' }))}>{pr.displayName}</button>
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Type</label>
            <select className="input" value={f.kind} onChange={(e) => set('kind', e.target.value)}>
              {def.capabilities.map((c) => <option key={c} value={c}>{KIND_LABEL[c as keyof typeof KIND_LABEL]}</option>)}
            </select>
          </div>
          <div>
            <label className="label">{f.kind === 'TTS_VOICE' ? (p.kind === 'AZURE_SPEECH' ? 'Voice name' : 'model:voice') : 'Model ID'}</label>
            <input className="input font-mono text-xs" value={f.modelId} onChange={(e) => set('modelId', e.target.value)} required placeholder={f.kind === 'TTS_VOICE' ? (p.kind === 'AZURE_SPEECH' ? 'my-MM-NilarNeural' : 'gpt-4o-mini-tts:nova') : 'gpt-4o-mini'} />
          </div>
        </div>
        <div><label className="label">Display name</label><input className="input" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} required /></div>
        {f.kind === 'CHAT' ? (
          <div className="grid grid-cols-3 gap-3">
            <div><label className="label">$ in / 1M</label><input className="input" type="number" step="0.01" min="0" value={f.inputUsdPer1M} onChange={(e) => set('inputUsdPer1M', Number(e.target.value))} /></div>
            <div><label className="label">$ out / 1M</label><input className="input" type="number" step="0.01" min="0" value={f.outputUsdPer1M} onChange={(e) => set('outputUsdPer1M', Number(e.target.value))} /></div>
            <div><label className="label">Credit ×</label><input className="input" type="number" step="0.1" min="0.1" max="20" value={f.creditMultiplier} onChange={(e) => set('creditMultiplier', Number(e.target.value))} /></div>
          </div>
        ) : (
          <div><label className="label">{f.kind === 'STT' ? 'USD per minute' : 'USD per 1M characters'}</label><input className="input" type="number" step="0.0001" min="0" value={f.unitUsdPer1M} onChange={(e) => set('unitUsdPer1M', Number(e.target.value))} /></div>
        )}
        {f.kind === 'CHAT' && (
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.supportsVision} onChange={(e) => set('supportsVision', e.target.checked)} /> Supports images (vision)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.userSelectable} onChange={(e) => set('userSelectable', e.target.checked)} /> Users can pick it</label>
          </div>
        )}
        <div><label className="label">Description (shown to users)</label><input className="input" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={300} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving}>{saving ? <Spinner /> : <Plus className="w-4 h-4" />} Add model</button>
        </div>
      </form>
    </Modal>
  );
}

function DiscoverList({ p, items, onAdded }: { p: Provider; items: any[]; onAdded: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<Set<string>>(new Set(items.filter((i) => i.added).map((i) => `${i.kind}:${i.id}`)));
  const shown = items.filter((i) => !q || `${i.id} ${i.label ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 100);
  const add = async (i: any) => {
    try {
      await api('/admin/ai/models', { method: 'POST', body: { providerId: p.id, kind: i.kind, modelId: i.id, displayName: i.label ?? i.id, userSelectable: i.kind === 'CHAT', supportsVision: /vision|4o|gemini|claude|vl|pixtral|llava/i.test(i.id) } });
      setAdded((s) => new Set(s).add(`${i.kind}:${i.id}`));
      toast('success', `${i.label ?? i.id} added — set its price in the table`);
      onAdded();
    } catch (e: any) {
      toast('error', e.message);
    }
  };
  return (
    <div className="space-y-3">
      <input className="input" placeholder={`Search ${items.length} models…`} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ul className="max-h-[50vh] overflow-y-auto divide-y divide-[var(--border)]">
        {shown.map((i) => {
          const k = `${i.kind}:${i.id}`;
          return (
            <li key={k} className="py-2 flex items-center gap-2 text-sm">
              <span className="badge bg-slate-500/15 shrink-0">{i.kind === 'TTS_VOICE' ? 'Voice' : i.kind}</span>
              <span className="min-w-0 flex-1 truncate"><span className="font-mono text-xs">{i.id}</span>{i.label && i.label !== i.id && <span className="muted"> · {i.label}</span>}</span>
              {added.has(k) ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> : <button className="btn btn-secondary !py-1 !px-2 text-xs shrink-0" onClick={() => add(i)}><Plus className="w-3.5 h-3.5" /> Add</button>}
            </li>
          );
        })}
        {shown.length === 0 && <li className="py-6 text-center muted text-sm">No models match</li>}
      </ul>
    </div>
  );
}
