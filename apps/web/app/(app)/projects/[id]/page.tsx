'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  ArrowLeft, Upload, ScanSearch, PenLine, Mic, Captions, Film, Download, Trash2, Plus, ArrowUp, ArrowDown, Play, Pause,
  RotateCcw, XCircle, Save, Sparkles, AlertTriangle, Coins, Copy, FileText, CheckCircle2, Volume2, Square,
} from 'lucide-react';
import { api, newRequestId, mediaUrl, fmtTime, fmtBytes, uploadWithProgress } from '@/lib/api';
import { useAuth, useJobEvents, useToast } from '@/components/providers';
import { ErrorState, Modal, PageLoader, ProgressBar, Spinner, StatusBadge } from '@/components/ui';

// ---------- types ----------
interface Segment { id?: string; idx?: number; sourceStart: number; sourceEnd: number; narration: string; sceneNote?: string | null; audioDurationSec?: number | null; audioUrl?: string | null; voiceStale?: boolean }
interface Sub { idx?: number; segmentIdx?: number | null; startSec: number; endSec: number; text: string }
interface Job { id: string; type: string; status: string; progress: number; stage: string | null; error: string | null; creditsReserved: number; creditsCharged: number; createdAt: string }
interface Project {
  id: string; title: string; recapType: string; aspectRatio: string; fitMode: string; customPrompt: string | null; targetDurationSec: number; status: string;
  voiceName: string; voiceRate: number; voicePitch: number; originalAudioVolume: number; musicTrackId: string | null; musicVolume: number; transition: string;
  subtitleStyle: { fontSize?: number; primaryColor?: string; outlineColor?: string; boxed?: boolean; position?: string } | null; subtitlesEnabled: boolean;
  analysis: { aiTitle?: string; summary?: string; sceneCount?: number; framesAnalyzed?: number; models?: { task: string; model: string; provider: string }[] } | null; lastError: string | null;
  analysisModelId: string | null;
  autoPilot: boolean;
}
interface Estimate { credits: number; usd: number; [k: string]: any }
interface Detail {
  project: Project; source: { durationSec: number | null; width: number | null; height: number | null; sizeBytes: number; filename: string | null; status: string } | null;
  sourceUrl: string | null; output: { durationSec: number | null; width: number | null; height: number | null; sizeBytes: number } | null; outputUrl: string | null;
  thumbnailUrl: string | null; segments: Segment[]; subtitles: Sub[]; jobs: Job[];
  estimates: { analyze: Estimate | null; voiceover: Estimate | null; render: Estimate | null };
}
interface AiModelOpt { id: string; label: string; provider: string; vision: boolean; description: string | null; creditMultiplier: number }
interface Config { voices: { id: string; label: string; description: string; provider?: string; engine?: string }[]; transitions: string[]; ttsProvider: string; aiModels: AiModelOpt[]; aiReady: boolean; defaultVoice: string | null }
interface Track { id: string; title: string; artist: string; license: string; licenseUrl: string | null; durationSec: number; mood: string | null; previewUrl: string }

const STEPS = [
  { key: 'upload', label: 'Upload', icon: Upload },
  { key: 'analyze', label: 'AI Analysis', icon: ScanSearch },
  { key: 'script', label: 'Script', icon: PenLine },
  { key: 'voice', label: 'Voiceover', icon: Mic },
  { key: 'subs', label: 'Subtitles', icon: Captions },
  { key: 'render', label: 'Render', icon: Film },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

const STATUS_STEP: Record<string, number> = { DRAFT: 0, UPLOADED: 1, ANALYZING: 1, SCRIPT_READY: 2, VOICING: 3, VOICED: 4, RENDERING: 5, COMPLETED: 5, FAILED: 0 };
const JOB_LABEL: Record<string, string> = { PROBE: 'Validating video', ANALYZE: 'AI analysis & script', VOICEOVER: 'Myanmar voiceover', RENDER: 'Video rendering' };
const charLen = (s: string) => Array.from(s).length;

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { refresh: refreshUser, user } = useAuth();
  const { subscribe, connected } = useJobEvents();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [cfg, setCfg] = useState<Config | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [step, setStep] = useState<StepKey>('upload');
  const [segs, setSegs] = useState<Segment[]>([]);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [dirtyScript, setDirtyScript] = useState(false);
  const [dirtySubs, setDirtySubs] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [liveJob, setLiveJob] = useState<Job | null>(null);
  const autoStepped = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await api<Detail>(`/projects/${id}`);
      setD(r);
      setError('');
      const active = r.jobs.find((j) => ['QUEUED', 'ACTIVE'].includes(j.status)) ?? null;
      setLiveJob(active);
      return r;
    } catch (e: any) {
      setError(e.message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    load().then((r) => {
      if (r && !autoStepped.current) {
        autoStepped.current = true;
        setStep(STEPS[STATUS_STEP[r.project.status] ?? 0].key);
      }
    });
    api<Config>('/config').then(setCfg).catch(() => undefined);
    api<{ items: Track[] }>('/music').then((r) => setTracks(r.items)).catch(() => undefined);
  }, [load]);

  // sync editable copies when server data changes (unless user has unsaved edits)
  useEffect(() => {
    if (d && !dirtyScript) setSegs(d.segments.map((s) => ({ ...s })));
    if (d && !dirtySubs) setSubs(d.subtitles.map((s) => ({ ...s })));
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  // live progress
  useEffect(
    () =>
      subscribe((ev) => {
        if (ev.projectId !== id) return;
        setLiveJob((cur) => ({ ...(cur ?? ({} as Job)), id: ev.jobId, type: ev.type, status: ev.status, progress: ev.progress, stage: ev.stage ?? null, error: ev.error ?? null }) as Job);
        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(ev.status)) {
          setDirtyScript(false);
          setDirtySubs(false);
          load().then((r) => {
            if (!r) return;
            if (ev.status === 'COMPLETED') {
              const next: Record<string, StepKey> = { PROBE: 'analyze', ANALYZE: 'script', VOICEOVER: 'subs', RENDER: 'render' };
              if (r.project.autoPilot && ev.type !== 'RENDER') setStep(next[ev.type] === 'subs' ? 'voice' : next[ev.type]);
              else if (next[ev.type]) setStep(next[ev.type]);
              toast('success', `${JOB_LABEL[ev.type]} finished`);
            } else if (ev.status === 'FAILED') toast('error', `${JOB_LABEL[ev.type]} failed: ${ev.error ?? 'unknown error'}`);
          });
          refreshUser();
        }
      }),
    [subscribe, id, load, refreshUser, toast],
  );

  // polling fallback when SSE is down
  useEffect(() => {
    if (connected || !liveJob || !['QUEUED', 'ACTIVE'].includes(liveJob.status)) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [connected, liveJob, load]);

  const p = d?.project;
  const running = !!liveJob && ['QUEUED', 'ACTIVE'].includes(liveJob.status);
  const reached = p ? STATUS_STEP[p.status] ?? 0 : 0;

  const patch = useCallback(
    async (data: Partial<Project> & Record<string, unknown>, quiet = false) => {
      try {
        const r = await api<{ project: Project }>(`/projects/${id}`, { method: 'PATCH', body: data });
        setD((cur) => (cur ? { ...cur, project: r.project } : cur));
        if (!quiet) toast('success', 'Settings saved');
        return true;
      } catch (e: any) {
        toast('error', e.message);
        return false;
      }
    },
    [id, toast],
  );

  const autoPilot = async (enabled: boolean) => {
    if (enabled && dirtyScript && !(await saveScript())) return;
    if (enabled && dirtySubs && !(await saveSubs())) return;
    setBusy('auto');
    try {
      const r = await api<{ started: string | null }>(`/projects/${id}/autopilot`, { body: { requestId: newRequestId(), enabled } });
      toast(enabled ? 'success' : 'info', enabled ? (r.started ? 'Auto-Pilot started — sit back, we will finish the whole recap for you.' : 'Auto-Pilot is on — it starts as soon as the video is validated.') : 'Auto-Pilot stopped. The current step will finish.');
      await load();
      refreshUser();
    } catch (e: any) {
      toast('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const startJob = async (kind: 'analyze' | 'voiceover' | 'render') => {
    if (kind !== 'analyze' && dirtyScript && !(await saveScript())) return;
    if (kind === 'render' && dirtySubs && !(await saveSubs())) return;
    setBusy(kind);
    try {
      const r = await api<{ job: Job }>(`/projects/${id}/${kind}`, { body: { requestId: newRequestId() } });
      setLiveJob(r.job);
      setD((cur) => (cur ? { ...cur, project: { ...cur.project, status: kind === 'analyze' ? 'ANALYZING' : kind === 'voiceover' ? 'VOICING' : 'RENDERING' } } : cur));
      refreshUser();
      toast('info', `${JOB_LABEL[r.job.type]} started`);
    } catch (e: any) {
      toast('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const cancelJob = async () => {
    if (!liveJob) return;
    try {
      await api(`/jobs/${liveJob.id}/cancel`, { method: 'POST' });
      toast('info', 'Cancelling…');
    } catch (e: any) {
      toast('error', e.message);
    }
  };
  const retryJob = async (jobId: string) => {
    try {
      const r = await api<{ job: Job }>(`/jobs/${jobId}/retry`, { method: 'POST' });
      setLiveJob(r.job);
      refreshUser();
      load();
    } catch (e: any) {
      toast('error', e.message);
    }
  };

  const saveScript = async () => {
    for (const [i, s] of segs.entries()) {
      if (!s.narration.trim()) return toast('error', `Segment ${i + 1} has empty narration`), false;
      if (s.sourceEnd <= s.sourceStart) return toast('error', `Segment ${i + 1}: end time must be after start time`), false;
    }
    setBusy('script');
    try {
      await api(`/projects/${id}/segments`, { method: 'PUT', body: { segments: segs.map((s) => ({ sourceStart: +s.sourceStart, sourceEnd: +s.sourceEnd, narration: s.narration, sceneNote: s.sceneNote ?? null })) } });
      setDirtyScript(false);
      await load();
      toast('success', 'Script saved');
      return true;
    } catch (e: any) {
      toast('error', e.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveSubs = async () => {
    setBusy('subs');
    try {
      await api(`/projects/${id}/subtitles`, { method: 'PUT', body: { subtitles: subs.map((s) => ({ startSec: +s.startSec, endSec: +s.endSec, text: s.text, segmentIdx: s.segmentIdx ?? null })) } });
      setDirtySubs(false);
      await load();
      toast('success', 'Subtitles saved');
      return true;
    } catch (e: any) {
      toast('error', e.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const regenSubs = async () => {
    setBusy('regen');
    try {
      await api(`/projects/${id}/subtitles/regenerate`, { method: 'POST' });
      setDirtySubs(false);
      await load();
      toast('success', 'Subtitles regenerated from narration');
    } catch (e: any) {
      toast('error', e.message);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    try {
      const r = await api<{ url: string }>(`/projects/${id}/download`);
      const a = document.createElement('a');
      a.href = mediaUrl(r.url)!;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e: any) {
      toast('error', e.message);
    }
  };

  const del = async () => {
    try {
      await api(`/projects/${id}`, { method: 'DELETE' });
      toast('success', 'Project and its files were deleted');
      router.replace('/dashboard');
    } catch (e: any) {
      toast('error', e.message);
    }
  };

  const duplicate = async () => {
    try {
      const r = await api<{ project: { id: string }; note: string }>(`/projects/${id}/duplicate`, { method: 'POST' });
      toast('info', r.note);
      router.push(`/projects/${r.project.id}`);
    } catch (e: any) {
      toast('error', e.message);
    }
  };

  if (error && !d) return <ErrorState message={error} onRetry={load} />;
  if (!d || !p) return <PageLoader label="Loading project…" />;

  const failedJob = d.jobs.find((j) => j.status === 'FAILED' && (!liveJob || j.id === liveJob.id || !running));
  const lastJob = d.jobs[0];

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/dashboard" className="btn btn-ghost !p-2" aria-label="Back to projects"><ArrowLeft className="w-5 h-5" /></Link>
          <div className="min-w-0">
            <TitleEditor title={p.title} onSave={(t) => patch({ title: t })} />
            <div className="flex items-center gap-2 text-xs muted mt-1 flex-wrap">
              <StatusBadge status={p.status} />
              <span>{p.recapType}</span>·<span>{p.aspectRatio}</span>
              {d.source?.durationSec ? <><span>·</span><span>Source {fmtTime(d.source.durationSec)}</span></> : null}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary text-xs" onClick={duplicate}><Copy className="w-4 h-4" /> Duplicate</button>
          <button className="btn btn-secondary text-xs text-red-500" onClick={() => setConfirmDelete(true)}><Trash2 className="w-4 h-4" /> Delete</button>
        </div>
      </div>

      {/* stepper */}
      <nav className="card p-2 flex overflow-x-auto gap-1" aria-label="Workflow steps">
        {STEPS.map((s, i) => {
          const enabled = i <= Math.max(reached, p.status === 'FAILED' && d.segments.length ? 2 : 0) || (i <= 2 && d.segments.length > 0);
          const done = i < reached || (p.status === 'COMPLETED' && i === 5);
          return (
            <button
              key={s.key}
              disabled={!enabled}
              onClick={() => setStep(s.key)}
              className={clsx('flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition flex-1 justify-center', step === s.key ? 'bg-brand-500 text-white' : enabled ? 'hover:bg-black/5 dark:hover:bg-white/5' : 'opacity-40')}
              aria-current={step === s.key ? 'step' : undefined}
            >
              {done && step !== s.key ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <s.icon className="w-4 h-4" />}
              <span className="hidden sm:inline">{s.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Auto-Pilot */}
      <AutoPilotBar d={d} running={running} busy={busy === 'auto'} onToggle={autoPilot} liveType={running ? liveJob?.type ?? null : null} />

      {/* live job panel */}
      {running && liveJob && (
        <section className="card p-4 border-brand-500/50" aria-live="polite">
          <div className="flex items-center gap-3">
            <Spinner className="w-5 h-5 text-brand-500" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">{JOB_LABEL[liveJob.type] ?? liveJob.type}</p>
              <p className="text-xs muted truncate">{liveJob.status === 'QUEUED' ? 'Waiting in queue…' : liveJob.stage}</p>
            </div>
            <span className="text-sm font-bold tabular-nums">{liveJob.progress}%</span>
            {liveJob.type !== 'PROBE' && <button className="btn btn-secondary text-xs" onClick={cancelJob}><XCircle className="w-4 h-4" /> Cancel</button>}
          </div>
          <ProgressBar value={liveJob.progress} className="mt-3" />
        </section>
      )}
      {!running && lastJob?.status === 'FAILED' && failedJob && (
        <section className="card p-4 border-red-500/50 flex flex-col sm:flex-row sm:items-center gap-3" role="alert">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-sm">{JOB_LABEL[failedJob.type]} failed</p>
            <p className="text-xs muted">{failedJob.error}. Reserved credits were refunded.</p>
          </div>
          {failedJob.type !== 'PROBE' && <button className="btn btn-secondary text-xs" onClick={() => retryJob(failedJob.id)}><RotateCcw className="w-4 h-4" /> Retry</button>}
        </section>
      )}

      {!running && !p.autoPilot && p.lastError?.startsWith('Auto-Pilot paused') && (
        <section className="card p-4 border-amber-500/50 flex items-start gap-3 text-sm" role="status">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
          <p>{p.lastError}</p>
        </section>
      )}

      {step === 'upload' && <UploadStep d={d} id={id} reload={load} running={running} goNext={() => setStep('analyze')} maxMb={user?.plan?.maxUploadMb ?? 300} />}
      {step === 'analyze' && <AnalyzeStep d={d} cfg={cfg} running={running} busy={busy === 'analyze'} start={() => startJob('analyze')} patch={patch} goNext={() => setStep('script')} />}
      {step === 'script' && (
        <ScriptStep
          d={d} segs={segs} setSegs={(s) => { setSegs(s); setDirtyScript(true); }} dirty={dirtyScript} running={running}
          save={saveScript} saving={busy === 'script'} goNext={() => setStep('voice')} reanalyze={() => setStep('analyze')}
        />
      )}
      {step === 'voice' && <VoiceStep d={d} cfg={cfg} running={running} busy={busy === 'voiceover'} start={() => startJob('voiceover')} patch={patch} dirtyScript={dirtyScript} goNext={() => setStep('subs')} />}
      {step === 'subs' && (
        <SubsStep
          d={d} subs={subs} setSubs={(s) => { setSubs(s); setDirtySubs(true); }} dirty={dirtySubs} running={running}
          save={saveSubs} saving={busy === 'subs'} regen={regenSubs} regenerating={busy === 'regen'} patch={patch} goNext={() => setStep('render')}
        />
      )}
      {step === 'render' && <RenderStep d={d} cfg={cfg} tracks={tracks} running={running} busy={busy === 'render'} start={() => startJob('render')} patch={patch} download={download} />}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this project?">
        <p className="text-sm muted">The source video, voiceover, subtitles and rendered MP4 will be permanently deleted from storage. This cannot be undone.</p>
        <div className="flex justify-end gap-2 mt-6">
          <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="btn btn-danger" onClick={del}><Trash2 className="w-4 h-4" /> Delete permanently</button>
        </div>
      </Modal>
    </div>
  );
}

// ======================= sub components =======================

function TitleEditor({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const [v, setV] = useState(title);
  useEffect(() => setV(title), [title]);
  return (
    <input
      className="bg-transparent text-xl font-bold my-text outline-none border-b border-transparent focus:border-brand-500 w-full max-w-xl truncate"
      value={v}
      maxLength={120}
      aria-label="Project title"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v !== title && onSave(v.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

function CostLine({ est, balance, label }: { est: Estimate | null | undefined; balance: number; label: string }) {
  if (!est) return null;
  const enough = balance >= est.credits;
  return (
    <div className={clsx('flex items-center gap-2 text-sm rounded-xl px-3 py-2', enough ? 'bg-amber-500/10' : 'bg-red-500/10')}>
      <Coins className="w-4 h-4 text-amber-500" />
      <span>
        {label}: <b>{est.credits} credits</b> <span className="muted">(≈ ${est.usd.toFixed(3)} provider cost)</span>
      </span>
      {!enough && <Link href="/billing" className="ml-auto text-red-500 font-semibold text-xs">Not enough credits — top up</Link>}
    </div>
  );
}

function UploadStep({ d, id, reload, running, goNext, maxMb }: { d: Detail; id: string; reload: () => Promise<unknown>; running: boolean; goNext: () => void; maxMb: number }) {
  const toast = useToast();
  const [prog, setProg] = useState<number | null>(null);
  const canReplace = ['DRAFT', 'UPLOADED', 'FAILED'].includes(d.project.status) && !running;
  const replace = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > maxMb * 1024 * 1024) return toast('error', `File too large (max ${maxMb} MB)`);
    try {
      const mime = f.type || 'video/mp4';
      const up = await api<{ assetId: string; upload: { url: string; headers: Record<string, string> } }>('/uploads', { body: { projectId: id, filename: f.name, mimeType: mime, sizeBytes: f.size } });
      setProg(0);
      await uploadWithProgress(up.upload.url, f, up.upload.headers, setProg);
      await api(`/uploads/${up.assetId}/complete`, { body: { projectId: id } });
      toast('success', 'Uploaded — validating video…');
      await reload();
    } catch (e: any) {
      toast('error', e.message);
    } finally {
      setProg(null);
    }
  };
  return (
    <section className="card p-5 space-y-4">
      <h2 className="font-semibold text-lg">Source video</h2>
      {d.sourceUrl ? (
        <div className="grid md:grid-cols-2 gap-5">
          <video src={mediaUrl(d.sourceUrl)} controls preload="metadata" className="w-full rounded-xl bg-black aspect-video" />
          <dl className="text-sm space-y-2">
            <div className="flex justify-between"><dt className="muted">File</dt><dd className="truncate ml-4">{d.source?.filename}</dd></div>
            <div className="flex justify-between"><dt className="muted">Duration</dt><dd>{fmtTime(d.source?.durationSec ?? 0)}</dd></div>
            <div className="flex justify-between"><dt className="muted">Resolution</dt><dd>{d.source?.width}×{d.source?.height}</dd></div>
            <div className="flex justify-between"><dt className="muted">Size</dt><dd>{fmtBytes(d.source?.sizeBytes ?? 0)}</dd></div>
            <div className="pt-3 flex gap-2">
              <button className="btn btn-primary" onClick={goNext}><Sparkles className="w-4 h-4" /> Continue to AI analysis</button>
            </div>
          </dl>
        </div>
      ) : d.source && d.source.status !== 'REJECTED' ? (
        <div className="flex items-center gap-3 muted text-sm"><Spinner /> Validating your video (format, duration, thumbnail)…</div>
      ) : (
        <p className="text-sm muted">No valid source video yet. Upload one to begin.</p>
      )}
      {canReplace && (
        <div>
          <label className="btn btn-secondary cursor-pointer">
            <Upload className="w-4 h-4" /> {d.sourceUrl ? 'Replace video' : 'Upload video'}
            <input type="file" accept="video/*,.mkv" className="sr-only" onChange={(e) => replace(e.target.files?.[0])} />
          </label>
          {prog !== null && <ProgressBar value={prog * 100} className="mt-3" />}
        </div>
      )}
    </section>
  );
}

function AnalyzeStep({ d, cfg, running, busy, start, patch, goNext }: { d: Detail; cfg: Config | null; running: boolean; busy: boolean; start: () => void; patch: (x: any, q?: boolean) => Promise<boolean>; goNext: () => void }) {
  const { user } = useAuth();
  const p = d.project;
  const [prompt, setPrompt] = useState(p.customPrompt ?? '');
  const [dur, setDur] = useState(p.targetDurationSec);
  const hasScript = d.segments.length > 0;
  const ready = d.source?.status === 'READY';
  return (
    <section className="card p-5 space-y-5">
      <div>
        <h2 className="font-semibold text-lg">AI video analysis & Myanmar script</h2>
        <p className="text-sm muted mt-1">FFmpeg detects every scene change, a vision model describes key frames, then an LLM writes a natural Burmese recap script and picks the timestamps to show.</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="tdur">Target recap length: {dur}s</label>
          <input id="tdur" type="range" min={15} max={Math.max(60, Math.min(1200, Math.round((d.source?.durationSec ?? 600) * 0.9)))} step={5} value={dur} onChange={(e) => setDur(+e.target.value)} onMouseUp={() => patch({ targetDurationSec: dur }, true)} onTouchEnd={() => patch({ targetDurationSec: dur }, true)} className="w-full accent-indigo-500" disabled={running} />
        </div>
        <div>
          <label className="label" htmlFor="ctype">Recap style</label>
          <select id="ctype" className="input" value={p.recapType} disabled={running} onChange={(e) => patch({ recapType: e.target.value, ...(e.target.value === 'CUSTOM' && !prompt ? { customPrompt: 'Summarize the story clearly' } : {}) })}>
            <option value="ANIME">Anime Recap</option>
            <option value="MOVIE">Movie Recap</option>
            <option value="SHORTS">Long-to-Shorts</option>
            <option value="HIGHLIGHTS">Highlights</option>
            <option value="CUSTOM">Custom Recap</option>
          </select>
        </div>
      </div>
      {cfg && cfg.aiModels.length > 0 && (
        <div>
          <label className="label" htmlFor="aimodel">AI model</label>
          <select id="aimodel" className="input" value={p.analysisModelId ?? ''} disabled={running} onChange={(e) => patch({ analysisModelId: e.target.value || null }, true)}>
            <option value="">Recommended (automatic, with failover)</option>
            {cfg.aiModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.provider}{m.creditMultiplier !== 1 ? ` · ${m.creditMultiplier}× credits` : ''}
              </option>
            ))}
          </select>
          <p className="text-xs muted mt-1">
            {cfg.aiModels.find((m) => m.id === p.analysisModelId)?.description ?? 'The admin-recommended model writes your script. If it is busy, a backup model takes over automatically.'}
          </p>
        </div>
      )}
      {cfg && !cfg.aiReady && <p className="text-sm text-red-500 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> AI analysis is temporarily unavailable. Please try again later or write the script manually.</p>}
      <div>
        <label className="label" htmlFor="cp">{p.recapType === 'CUSTOM' ? 'Custom instructions (required)' : 'Extra instructions (optional)'}</label>
        <textarea id="cp" rows={3} maxLength={2000} className="input" placeholder="e.g. Mention the main character is named Kaito. Keep a suspenseful tone." value={prompt} onChange={(e) => setPrompt(e.target.value)} onBlur={() => prompt !== (p.customPrompt ?? '') && patch({ customPrompt: prompt || null }, true)} disabled={running} />
      </div>
      <CostLine est={d.estimates.analyze} balance={user?.creditBalance ?? 0} label="Estimated cost" />
      {hasScript && <p className="text-sm text-amber-500 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Re-analyzing replaces your current script and voiceover.</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={!ready || running || busy || (p.recapType === 'CUSTOM' && !prompt.trim())} onClick={start}>
          {busy ? <Spinner /> : <ScanSearch className="w-4 h-4" />} {hasScript ? 'Re-analyze video' : 'Analyze video with AI'}
        </button>
        {hasScript && <button className="btn btn-secondary" onClick={goNext}>Go to script</button>}
      </div>
      {p.analysis?.summary && (
        <div className="rounded-xl bg-brand-500/5 border border-brand-500/20 p-4 text-sm">
          <p className="font-semibold mb-1 my-text">{p.analysis.aiTitle}</p>
          <p className="muted">{p.analysis.summary}</p>
          <p className="text-xs muted mt-2">{p.analysis.sceneCount} scenes detected · {p.analysis.framesAnalyzed} frames analyzed</p>
          {!!p.analysis.models?.length && (
            <p className="text-xs muted mt-1 flex flex-wrap gap-1.5">
              {p.analysis.models.map((m) => (
                <span key={m.task} className="badge bg-brand-500/10">{m.task === 'vision' ? 'Vision' : m.task === 'script' ? 'Script' : 'Speech'}: {m.model}</span>
              ))}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ScriptStep({ d, segs, setSegs, dirty, running, save, saving, goNext, reanalyze }: {
  d: Detail; segs: Segment[]; setSegs: (s: Segment[]) => void; dirty: boolean; running: boolean; save: () => Promise<boolean>; saving: boolean; goNext: () => void; reanalyze: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);
  const dur = d.source?.durationSec ?? 0;
  const total = segs.reduce((a, s) => a + charLen(s.narration), 0);
  const estSec = total / (11 * d.project.voiceRate);
  const upd = (i: number, patch: Partial<Segment>) => setSegs(segs.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= segs.length) return;
    const c = segs.slice();
    [c[i], c[j]] = [c[j], c[i]];
    setSegs(c);
  };
  const preview = (s: Segment) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = s.sourceStart;
    stopAt.current = s.sourceEnd;
    v.play().catch(() => undefined);
  };
  const add = () => {
    const last = segs[segs.length - 1];
    const start = last ? Math.min(last.sourceEnd, Math.max(0, dur - 5)) : 0;
    setSegs([...segs, { sourceStart: +start.toFixed(2), sourceEnd: +Math.min(dur || start + 6, start + 6).toFixed(2), narration: '' }]);
  };
  if (!d.segments.length && !segs.length) {
    return (
      <section className="card p-8 text-center space-y-3">
        <PenLine className="w-10 h-10 mx-auto text-brand-500" />
        <p className="font-semibold">No script yet</p>
        <p className="text-sm muted">Run AI analysis to generate a Myanmar script, or write one manually.</p>
        <div className="flex justify-center gap-2">
          <button className="btn btn-primary" onClick={reanalyze}><Sparkles className="w-4 h-4" /> AI analysis</button>
          <button className="btn btn-secondary" onClick={add} disabled={!dur}><Plus className="w-4 h-4" /> Write manually</button>
        </div>
      </section>
    );
  }
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_380px] gap-5">
      <section className="space-y-3 order-2 lg:order-1">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="font-semibold text-lg">Recap script (Myanmar)</h2>
            <p className="text-xs muted">{segs.length} segments · {total} characters · ≈ {Math.round(estSec)}s narration</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary text-xs" onClick={add} disabled={running}><Plus className="w-4 h-4" /> Add segment</button>
            <button className="btn btn-primary text-xs" onClick={save} disabled={!dirty || saving || running}>{saving ? <Spinner /> : <Save className="w-4 h-4" />} Save script</button>
          </div>
        </div>
        {segs.map((s, i) => {
          const fit = (s.sourceEnd - s.sourceStart) * 11 * d.project.voiceRate;
          const len = charLen(s.narration);
          return (
            <article key={i} className="card p-4 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="badge bg-brand-500/15 text-brand-500">#{i + 1}</span>
                <label className="text-xs muted flex items-center gap-1">
                  Start
                  <input type="number" step="0.1" min={0} max={dur} className="input !py-1 !px-2 w-20 text-xs" value={s.sourceStart} onChange={(e) => upd(i, { sourceStart: +e.target.value })} disabled={running} aria-label={`Segment ${i + 1} start seconds`} />
                </label>
                <label className="text-xs muted flex items-center gap-1">
                  End
                  <input type="number" step="0.1" min={0} max={dur} className="input !py-1 !px-2 w-20 text-xs" value={s.sourceEnd} onChange={(e) => upd(i, { sourceEnd: +e.target.value })} disabled={running} aria-label={`Segment ${i + 1} end seconds`} />
                </label>
                <span className="text-xs muted">{fmtTime(s.sourceStart)}–{fmtTime(s.sourceEnd)}</span>
                <div className="ml-auto flex gap-1">
                  <button className="btn btn-ghost !p-1.5" onClick={() => preview(s)} title="Preview clip" aria-label="Preview clip"><Play className="w-4 h-4" /></button>
                  <button className="btn btn-ghost !p-1.5" onClick={() => move(i, -1)} disabled={i === 0 || running} aria-label="Move up"><ArrowUp className="w-4 h-4" /></button>
                  <button className="btn btn-ghost !p-1.5" onClick={() => move(i, 1)} disabled={i === segs.length - 1 || running} aria-label="Move down"><ArrowDown className="w-4 h-4" /></button>
                  <button className="btn btn-ghost !p-1.5 text-red-500" onClick={() => setSegs(segs.filter((_, k) => k !== i))} disabled={running || segs.length <= 1} aria-label="Delete segment"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
              <textarea className="input my-text text-base" rows={3} lang="my" value={s.narration} onChange={(e) => upd(i, { narration: e.target.value })} disabled={running} placeholder="မြန်မာလို ဇာတ်ကြောင်းပြော စာသား…" aria-label={`Segment ${i + 1} narration`} />
              <div className="flex justify-between text-xs">
                <span className="muted truncate">{s.sceneNote}</span>
                <span className={clsx(len > fit * 1.6 ? 'text-amber-500' : 'muted')}>{len} chars{len > fit * 1.6 ? ' · longer than clip — scene will hold' : ''}</span>
              </div>
            </article>
          );
        })}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn btn-primary" onClick={async () => { if (!dirty || (await save())) goNext(); }} disabled={running || saving}>
            Continue to voiceover <Mic className="w-4 h-4" />
          </button>
        </div>
      </section>
      <aside className="order-1 lg:order-2 lg:sticky lg:top-4 self-start space-y-2">
        {d.sourceUrl && (
          <video
            ref={videoRef}
            src={mediaUrl(d.sourceUrl)}
            controls
            preload="metadata"
            className="w-full rounded-xl bg-black aspect-video"
            onTimeUpdate={(e) => {
              if (stopAt.current !== null && e.currentTarget.currentTime >= stopAt.current) {
                e.currentTarget.pause();
                stopAt.current = null;
              }
            }}
          />
        )}
        <p className="text-xs muted">Click ▶ on a segment to preview its source clip. Edit timestamps to choose exactly which scene plays under each line.</p>
      </aside>
    </div>
  );
}

function VoiceStep({ d, cfg, running, busy, start, patch, dirtyScript, goNext }: {
  d: Detail; cfg: Config | null; running: boolean; busy: boolean; start: () => void; patch: (x: any, q?: boolean) => Promise<boolean>; dirtyScript: boolean; goNext: () => void;
}) {
  const { user } = useAuth();
  const p = d.project;
  const [rate, setRate] = useState(p.voiceRate);
  const [pitch, setPitch] = useState(p.voicePitch);
  useEffect(() => { setRate(p.voiceRate); setPitch(p.voicePitch); }, [p.voiceRate, p.voicePitch]);
  const voiced = d.segments.filter((s) => s.audioUrl && !s.voiceStale).length;
  const allVoiced = d.segments.length > 0 && voiced === d.segments.length;
  const est = d.estimates.voiceover;
  return (
    <div className="grid lg:grid-cols-[360px_minmax(0,1fr)] gap-5">
      <section className="card p-5 space-y-5 self-start">
        <h2 className="font-semibold text-lg">Myanmar AI voice</h2>
        {cfg?.ttsProvider === 'espeak' && <p className="text-xs text-amber-500 bg-amber-500/10 rounded-lg p-2">Development voice (eSpeak NG) is active. An admin can add natural Myanmar voices with a Gemini API key in Admin → AI Models (Azure Speech is optional).</p>}
        {cfg && cfg.voices.length > 0 && !cfg.voices.some((v) => v.id === p.voiceName) && (
          <p className="text-xs text-amber-500 bg-amber-500/10 rounded-lg p-2">Your previous voice is no longer available — choose one of the voices below.</p>
        )}
        <div className="space-y-2" role="radiogroup" aria-label="Voice">
          {cfg?.voices.map((v) => (
            <div key={v.id} className={clsx('card w-full p-3 flex items-center gap-3 transition', p.voiceName === v.id ? 'border-brand-500 ring-2 ring-brand-500/30' : 'hover:border-brand-400')}>
              <button role="radio" aria-checked={p.voiceName === v.id} disabled={running} onClick={() => patch({ voiceName: v.id }, true)} className="flex-1 min-w-0 text-left flex items-center gap-3">
                <Volume2 className={clsx('w-5 h-5 shrink-0', p.voiceName === v.id ? 'text-brand-500' : 'muted')} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold my-text">{v.label}</p>
                  <p className="text-xs muted">{v.description}</p>
                </div>
              </button>
              <VoicePreview id={v.id} />
            </div>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="rate">Speed: {rate.toFixed(2)}×</label>
          <input id="rate" type="range" min={0.5} max={2} step={0.05} value={rate} disabled={running} onChange={(e) => setRate(+e.target.value)} onMouseUp={() => patch({ voiceRate: rate }, true)} onTouchEnd={() => patch({ voiceRate: rate }, true)} onKeyUp={() => patch({ voiceRate: rate }, true)} className="w-full accent-indigo-500" />
        </div>
        <div>
          <label className="label" htmlFor="pitch">Pitch: {pitch > 0 ? '+' : ''}{pitch}%</label>
          <input id="pitch" type="range" min={-30} max={30} step={1} value={pitch} disabled={running} onChange={(e) => setPitch(+e.target.value)} onMouseUp={() => patch({ voicePitch: pitch }, true)} onTouchEnd={() => patch({ voicePitch: pitch }, true)} onKeyUp={() => patch({ voicePitch: pitch }, true)} className="w-full accent-indigo-500" />
        </div>
        {est && est.credits > 0 && <CostLine est={est} balance={user?.creditBalance ?? 0} label={`Voice ${est.pendingSegments} segment(s)`} />}
        {dirtyScript && <p className="text-xs text-amber-500">You have unsaved script edits — they will be saved first.</p>}
        <button className="btn btn-primary w-full" disabled={running || busy || !d.segments.length || (allVoiced && !dirtyScript)} onClick={start}>
          {busy ? <Spinner /> : <Mic className="w-4 h-4" />} {allVoiced ? 'Voiceover up to date' : voiced ? 'Update changed segments' : 'Generate Myanmar voiceover'}
        </button>
        {allVoiced && <button className="btn btn-secondary w-full" onClick={goNext}>Continue to subtitles</button>}
      </section>
      <section className="card p-5 space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="font-semibold">Segment audio</h3>
          <span className="text-xs muted">{voiced}/{d.segments.length} ready</span>
        </div>
        {d.segments.map((s, i) => (
          <div key={s.id ?? i} className="flex items-start gap-3 p-3 rounded-xl bg-black/5 dark:bg-white/5">
            <span className="badge bg-brand-500/15 text-brand-500 shrink-0">#{i + 1}</span>
            <div className="flex-1 min-w-0 space-y-2">
              <p className="my-text text-sm">{s.narration}</p>
              {s.audioUrl ? <AudioChip url={s.audioUrl} dur={s.audioDurationSec} stale={!!s.voiceStale} /> : <p className="text-xs muted">Not generated yet</p>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function AudioChip({ url, dur, stale }: { url: string; dur?: number | null; stale: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <div className="flex items-center gap-2 text-xs">
      <button className="btn btn-secondary !py-1 !px-2 text-xs" onClick={() => (playing ? ref.current?.pause() : ref.current?.play())} aria-label={playing ? 'Pause' : 'Play voice'}>
        {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />} {dur ? `${dur.toFixed(1)}s` : 'Play'}
      </button>
      {stale && <span className="text-amber-500">outdated — regenerate</span>}
      <audio ref={ref} src={mediaUrl(url)} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    </div>
  );
}

function SubsStep({ d, subs, setSubs, dirty, running, save, saving, regen, regenerating, patch, goNext }: {
  d: Detail; subs: Sub[]; setSubs: (s: Sub[]) => void; dirty: boolean; running: boolean; save: () => Promise<boolean>; saving: boolean; regen: () => void; regenerating: boolean; patch: (x: any, q?: boolean) => Promise<boolean>; goNext: () => void;
}) {
  const p = d.project;
  const st = p.subtitleStyle ?? {};
  const setStyle = (x: Record<string, unknown>) => patch({ subtitleStyle: { ...st, ...x } }, true);
  const upd = (i: number, x: Partial<Sub>) => setSubs(subs.map((s, k) => (k === i ? { ...s, ...x } : s)));
  const allVoiced = d.segments.length > 0 && d.segments.every((s) => s.audioUrl && !s.voiceStale);
  if (!allVoiced) {
    return (
      <section className="card p-8 text-center space-y-2">
        <Captions className="w-10 h-10 mx-auto text-brand-500" />
        <p className="font-semibold">Generate the voiceover first</p>
        <p className="text-sm muted">Subtitles are timed automatically to the Myanmar voice audio.</p>
      </section>
    );
  }
  return (
    <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] gap-5">
      <section className="card p-5 space-y-4 self-start">
        <h2 className="font-semibold text-lg">Subtitle style</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.subtitlesEnabled} onChange={(e) => patch({ subtitlesEnabled: e.target.checked }, true)} /> Burn subtitles into video
        </label>
        <div>
          <label className="label">Size: {st.fontSize ?? 58}</label>
          <input type="range" min={32} max={96} defaultValue={st.fontSize ?? 58} onMouseUp={(e) => setStyle({ fontSize: +(e.target as HTMLInputElement).value })} onTouchEnd={(e) => setStyle({ fontSize: +(e.target as HTMLInputElement).value })} className="w-full accent-indigo-500" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Text color</label><input type="color" className="w-full h-10 rounded-lg" defaultValue={st.primaryColor ?? '#FFFFFF'} onBlur={(e) => setStyle({ primaryColor: e.target.value.toUpperCase() })} /></div>
          <div><label className="label">Outline</label><input type="color" className="w-full h-10 rounded-lg" defaultValue={st.outlineColor ?? '#000000'} onBlur={(e) => setStyle({ outlineColor: e.target.value.toUpperCase() })} /></div>
        </div>
        <div>
          <span className="label">Position</span>
          <div className="grid grid-cols-3 gap-1">
            {['top', 'middle', 'bottom'].map((pos) => (
              <button key={pos} className={clsx('btn !px-2 text-xs capitalize', (st.position ?? 'bottom') === pos ? 'btn-primary' : 'btn-secondary')} onClick={() => setStyle({ position: pos })}>{pos}</button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!st.boxed} onChange={(e) => setStyle({ boxed: e.target.checked })} /> Background box</label>
        <div className="rounded-xl p-4 flex items-end justify-center h-28 bg-gradient-to-br from-slate-700 to-slate-900">
          <span className="my-text font-bold px-2 rounded" style={{ color: st.primaryColor ?? '#fff', fontSize: Math.round((st.fontSize ?? 58) / 3.2), textShadow: st.boxed ? 'none' : `0 0 3px ${st.outlineColor ?? '#000'}, 0 0 3px ${st.outlineColor ?? '#000'}`, background: st.boxed ? 'rgba(0,0,0,.6)' : 'transparent' }}>
            မြန်မာစာတန်းထိုး နမူနာ
          </span>
        </div>
        <a href={`/api/projects/${p.id}/subtitles.srt`} className="btn btn-secondary w-full text-xs"><FileText className="w-4 h-4" /> Download .srt</a>
      </section>
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="font-semibold text-lg">Myanmar subtitles</h2>
            <p className="text-xs muted">{subs.length} lines · edit text and timing (seconds on the final video timeline)</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary text-xs" onClick={regen} disabled={regenerating || running}>{regenerating ? <Spinner /> : <RotateCcw className="w-4 h-4" />} Auto-time again</button>
            <button className="btn btn-primary text-xs" onClick={save} disabled={!dirty || saving || running}>{saving ? <Spinner /> : <Save className="w-4 h-4" />} Save</button>
          </div>
        </div>
        <div className="card divide-y divide-[var(--border)] max-h-[65vh] overflow-y-auto">
          {subs.map((s, i) => (
            <div key={i} className="p-3 flex flex-col sm:flex-row gap-2 sm:items-center">
              <div className="flex gap-1 items-center shrink-0">
                <span className="text-xs muted w-6">{i + 1}</span>
                <input type="number" step="0.05" min={0} className="input !py-1 !px-2 w-20 text-xs" value={s.startSec} onChange={(e) => upd(i, { startSec: +e.target.value })} aria-label={`Subtitle ${i + 1} start`} />
                <span className="muted text-xs">→</span>
                <input type="number" step="0.05" min={0} className="input !py-1 !px-2 w-20 text-xs" value={s.endSec} onChange={(e) => upd(i, { endSec: +e.target.value })} aria-label={`Subtitle ${i + 1} end`} />
              </div>
              <input className={clsx('input my-text flex-1', s.endSec <= s.startSec && 'border-red-500')} lang="my" value={s.text} onChange={(e) => upd(i, { text: e.target.value })} aria-label={`Subtitle ${i + 1} text`} />
              <button className="btn btn-ghost !p-1.5 text-red-500 self-end sm:self-auto" onClick={() => setSubs(subs.filter((_, k) => k !== i))} aria-label="Delete subtitle line"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button className="btn btn-primary" onClick={async () => { if (!dirty || (await save())) goNext(); }}>Continue to render <Film className="w-4 h-4" /></button>
        </div>
      </section>
    </div>
  );
}

function RenderStep({ d, cfg, tracks, running, busy, start, patch, download }: {
  d: Detail; cfg: Config | null; tracks: Track[]; running: boolean; busy: boolean; start: () => void; patch: (x: any, q?: boolean) => Promise<boolean>; download: () => void;
}) {
  const { user } = useAuth();
  const p = d.project;
  const allVoiced = d.segments.length > 0 && d.segments.every((s) => s.audioUrl && !s.voiceStale);
  const [orig, setOrig] = useState(p.originalAudioVolume);
  const [mus, setMus] = useState(p.musicVolume);
  const portrait = p.aspectRatio === '9:16';
  return (
    <div className="grid lg:grid-cols-[360px_minmax(0,1fr)] gap-5">
      <section className="card p-5 space-y-5 self-start">
        <h2 className="font-semibold text-lg">Edit & render settings</h2>
        <div>
          <span className="label">Aspect ratio</span>
          <div className="grid grid-cols-3 gap-1">
            {['9:16', '16:9', '1:1'].map((r) => (
              <button key={r} disabled={running} className={clsx('btn !px-2 text-xs', p.aspectRatio === r ? 'btn-primary' : 'btn-secondary')} onClick={() => patch({ aspectRatio: r }, true)}>{r}</button>
            ))}
          </div>
        </div>
        <div>
          <span className="label">Frame fit</span>
          <div className="grid grid-cols-2 gap-1">
            {[['blur', 'Blurred background'], ['crop', 'Crop to fill']].map(([v, l]) => (
              <button key={v} disabled={running} className={clsx('btn !px-2 text-xs', p.fitMode === v ? 'btn-primary' : 'btn-secondary')} onClick={() => patch({ fitMode: v }, true)}>{l}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="tr">Scene transition</label>
          <select id="tr" className="input" value={p.transition} disabled={running} onChange={(e) => patch({ transition: e.target.value }, true)}>
            {cfg?.transitions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ov">Original audio volume: {Math.round(orig * 100)}%</label>
          <input id="ov" type="range" min={0} max={1} step={0.01} value={orig} disabled={running} onChange={(e) => setOrig(+e.target.value)} onMouseUp={() => patch({ originalAudioVolume: orig }, true)} onTouchEnd={() => patch({ originalAudioVolume: orig }, true)} className="w-full accent-indigo-500" />
        </div>
        <div>
          <label className="label" htmlFor="mt">Background music (licensed library)</label>
          <select id="mt" className="input" value={p.musicTrackId ?? ''} disabled={running} onChange={(e) => patch({ musicTrackId: e.target.value || null }, true)}>
            <option value="">No music</option>
            {tracks.map((t) => <option key={t.id} value={t.id}>{t.title} — {t.artist} ({t.license})</option>)}
          </select>
          {tracks.length === 0 && <p className="text-xs muted mt-1">No licensed tracks uploaded yet (admins can add them).</p>}
          {p.musicTrackId && (
            <div className="mt-2">
              <label className="label" htmlFor="mv">Music volume: {Math.round(mus * 100)}%</label>
              <input id="mv" type="range" min={0} max={0.6} step={0.01} value={mus} onChange={(e) => setMus(+e.target.value)} onMouseUp={() => patch({ musicVolume: mus }, true)} onTouchEnd={() => patch({ musicVolume: mus }, true)} className="w-full accent-indigo-500" />
            </div>
          )}
        </div>
        <CostLine est={d.estimates.render} balance={user?.creditBalance ?? 0} label={`Render ≈ ${d.estimates.render?.outputDurationSec ?? 0}s video`} />
        {user?.plan?.watermark && <p className="text-xs muted">Free plan exports at {user.plan.maxOutputHeight}p with a small watermark. <Link href="/billing" className="text-brand-500">Upgrade</Link> for 1080p without watermark.</p>}
        <button className="btn btn-primary w-full py-3" disabled={!allVoiced || running || busy} onClick={start}>
          {busy ? <Spinner /> : <Film className="w-4 h-4" />} {d.outputUrl ? 'Re-render video' : 'Render MP4'}
        </button>
        {!allVoiced && <p className="text-xs text-amber-500">Voiceover is missing or outdated — generate it first.</p>}
      </section>
      <section className="card p-5 space-y-4">
        <h2 className="font-semibold text-lg">Preview</h2>
        {d.outputUrl ? (
          <>
            <div className={clsx('mx-auto bg-black rounded-xl overflow-hidden', portrait ? 'max-w-sm' : 'w-full')}>
              <video key={d.outputUrl} src={mediaUrl(d.outputUrl)} controls playsInline preload="metadata" poster={mediaUrl(d.thumbnailUrl)} className="w-full" />
            </div>
            <div className="flex flex-wrap items-center gap-3 justify-between">
              <p className="text-sm muted">{d.output?.width}×{d.output?.height} · {fmtTime(d.output?.durationSec ?? 0)} · {fmtBytes(d.output?.sizeBytes ?? 0)} · MP4 (H.264/AAC)</p>
              <button className="btn btn-primary" onClick={download}><Download className="w-4 h-4" /> Download MP4</button>
            </div>
          </>
        ) : running ? (
          <div className="aspect-video rounded-xl bg-black/20 flex flex-col items-center justify-center gap-3 muted"><Spinner className="w-8 h-8 text-brand-500" /> Rendering your recap…</div>
        ) : (
          <div className="aspect-video rounded-xl bg-black/20 flex flex-col items-center justify-center gap-2 muted"><Film className="w-10 h-10" /><p className="text-sm">Your rendered video will appear here</p></div>
        )}
      </section>
    </div>
  );
}

let currentPreview: HTMLAudioElement | null = null;
function VoicePreview({ id }: { id: string }) {
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const play = async () => {
    if (state === 'playing') {
      audio.current?.pause();
      setState('idle');
      return;
    }
    setState('loading');
    try {
      if (!audio.current) {
        const r = await api<{ url: string }>(`/voices/${encodeURIComponent(id)}/sample`);
        audio.current = new Audio(mediaUrl(r.url));
        audio.current.onended = () => setState('idle');
        audio.current.onpause = () => setState('idle');
      }
      if (currentPreview && currentPreview !== audio.current) currentPreview.pause();
      currentPreview = audio.current;
      audio.current.currentTime = 0;
      await audio.current.play();
      setState('playing');
    } catch (e: any) {
      toast('error', e.message || 'Could not play sample');
      setState('idle');
    }
  };
  return (
    <button type="button" onClick={play} className="btn btn-secondary !p-2 shrink-0" aria-label={state === 'playing' ? 'Stop sample' : 'Play voice sample'} title="နမူနာ နားထောင်ရန်">
      {state === 'loading' ? <Spinner /> : state === 'playing' ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
    </button>
  );
}

const PIPE = [
  { t: 'PROBE', l: 'စစ်ဆေး' , e: 'Validate' },
  { t: 'ANALYZE', l: 'AI ခွဲခြမ်း', e: 'AI analysis' },
  { t: 'VOICEOVER', l: 'မြန်မာအသံ', e: 'Voice' },
  { t: 'RENDER', l: 'ဗီဒီယိုထုတ်', e: 'Render' },
] as const;

function AutoPilotBar({ d, running, busy, onToggle, liveType }: { d: Detail; running: boolean; busy: boolean; onToggle: (on: boolean) => void; liveType: string | null }) {
  const p = d.project;
  const done = p.status === 'COMPLETED';
  const hasSource = !!d.source;
  if (!hasSource) return null;
  const doneIdx = { DRAFT: -1, UPLOADED: 0, ANALYZING: 0, SCRIPT_READY: 1, VOICING: 1, VOICED: 2, RENDERING: 2, COMPLETED: 3, FAILED: -1 }[p.status] ?? -1;
  if (!p.autoPilot) {
    if (done || running) return null;
    return (
      <section className="card p-4 flex flex-col sm:flex-row sm:items-center gap-3 bg-gradient-to-r from-brand-500/10 to-accent-500/10 border-brand-500/30">
        <Sparkles className="w-6 h-6 text-brand-500 shrink-0" />
        <div className="flex-1">
          <p className="font-semibold text-sm">One-click Auto-Pilot</p>
          <p className="text-xs muted">AI analysis → မြန်မာ script → မြန်မာအသံ → subtitles → MP4 ကို အလိုအလျောက် ဆက်တိုက်လုပ်ပေးမယ်။ ပြီးမှ လိုသလို ပြင်ပြီး ပြန် render လုပ်နိုင်ပါတယ်။</p>
        </div>
        <button className="btn btn-primary" disabled={busy || d.source?.status === 'REJECTED'} onClick={() => onToggle(true)}>
          {busy ? <Spinner /> : <Sparkles className="w-4 h-4" />} Auto-generate recap
        </button>
      </section>
    );
  }
  return (
    <section className="card p-4 border-brand-500/40" aria-live="polite">
      <div className="flex items-center gap-3 flex-wrap">
        <Sparkles className="w-5 h-5 text-brand-500" />
        <p className="font-semibold text-sm flex-1">{done ? 'Auto-Pilot finished — your recap is ready!' : 'Auto-Pilot is creating your recap…'}</p>
        {!done && <button className="btn btn-ghost text-xs" disabled={busy} onClick={() => onToggle(false)}>Stop Auto-Pilot</button>}
      </div>
      <ol className="mt-3 grid grid-cols-4 gap-2">
        {PIPE.map((s, i) => {
          const isDone = i <= doneIdx || done;
          const isNow = liveType === s.t;
          return (
            <li key={s.t} className={clsx('rounded-xl px-2 py-2 text-center text-xs border', isDone ? 'border-emerald-500/40 bg-emerald-500/10' : isNow ? 'border-brand-500 bg-brand-500/10' : 'border-[var(--border)] opacity-60')}>
              <div className="flex items-center justify-center gap-1 font-medium">
                {isDone ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> : isNow ? <Spinner className="w-3.5 h-3.5" /> : null}
                <span className="my-text">{s.l}</span>
              </div>
              <span className="muted hidden sm:block">{s.e}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
