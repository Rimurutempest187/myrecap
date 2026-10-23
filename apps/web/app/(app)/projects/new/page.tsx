'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { UploadCloud, Swords, Clapperboard, Smartphone, Star, Wand2, FileVideo, X, ShieldAlert, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { api, uploadWithProgress, fmtBytes } from '@/lib/api';
import { useAuth, useToast } from '@/components/providers';
import { ProgressBar, Spinner } from '@/components/ui';

const TYPES = [
  { id: 'ANIME', label: 'Anime Recap', icon: Swords, d: 'Dramatic episode recaps', ratio: '16:9', dur: 180 },
  { id: 'MOVIE', label: 'Movie Recap', icon: Clapperboard, d: 'Full plot explained', ratio: '16:9', dur: 240 },
  { id: 'SHORTS', label: 'Long-to-Shorts', icon: Smartphone, d: 'Vertical hook-driven short', ratio: '9:16', dur: 50 },
  { id: 'HIGHLIGHTS', label: 'Highlights', icon: Star, d: 'Best moments + commentary', ratio: '16:9', dur: 90 },
  { id: 'CUSTOM', label: 'Custom Recap', icon: Wand2, d: 'Your own instructions', ratio: '16:9', dur: 120 },
] as const;
const ACCEPT = 'video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo,.mkv';

export default function NewProject() {
  const { user } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [type, setType] = useState<(typeof TYPES)[number]['id']>('SHORTS');
  const [title, setTitle] = useState('');
  const [ratio, setRatio] = useState('9:16');
  const [dur, setDur] = useState(50);
  const [prompt, setPrompt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
  const [auto, setAuto] = useState(true);
  const [drag, setDrag] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'creating' | 'uploading' | 'finalizing'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const maxMb = user?.plan?.maxUploadMb ?? 300;

  useEffect(() => {
    const t = TYPES.find((x) => x.id === type)!;
    setRatio(t.ratio);
    setDur(t.dur);
  }, [type]);

  const pick = (f: File | undefined) => {
    setError('');
    if (!f) return;
    const okType = ACCEPT.split(',').includes(f.type) || /\.(mp4|mov|mkv|webm|avi)$/i.test(f.name);
    if (!okType) return setError('Unsupported file type. Use MP4, MOV, MKV, WEBM or AVI.');
    if (f.size > maxMb * 1024 * 1024) return setError(`File is ${fmtBytes(f.size)}. Your plan allows up to ${maxMb} MB.`);
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, 100));
  };

  const mimeOf = (f: File) => f.type || ({ mkv: 'video/x-matroska', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo' } as Record<string, string>)[f.name.split('.').pop()!.toLowerCase()] || 'video/mp4';

  const submit = async () => {
    if (!file || !rights) return;
    setError('');
    setPhase('creating');
    let projectId: string | null = null;
    try {
      const { project } = await api<{ project: { id: string } }>('/projects', {
        body: { title: title.trim() || 'Untitled recap', recapType: type, aspectRatio: ratio, targetDurationSec: dur, customPrompt: type === 'CUSTOM' ? prompt : undefined, copyrightConfirmed: true, autoPilot: auto },
      });
      projectId = project.id;
      const up = await api<{ assetId: string; upload: { url: string; headers: Record<string, string> } }>('/uploads', {
        body: { projectId, filename: file.name, mimeType: mimeOf(file), sizeBytes: file.size },
      });
      setPhase('uploading');
      abortRef.current = new AbortController();
      await uploadWithProgress(up.upload.url, file, up.upload.headers, setProgress, abortRef.current.signal);
      setPhase('finalizing');
      await api(`/uploads/${up.assetId}/complete`, { body: { projectId } });
      toast('success', auto ? 'Upload complete! Auto-Pilot will create your recap automatically.' : 'Upload complete! Validating your video…');
      router.push(`/projects/${projectId}`);
    } catch (e: any) {
      setError(e.message);
      setPhase('idle');
      if (projectId) toast('info', 'Project saved as draft — you can retry the upload from the project page.');
    }
  };

  const busy = phase !== 'idle';
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Create a new recap</h1>
        <p className="muted text-sm">Choose a recap style, upload your video, and AI will do the rest.</p>
      </div>

      <section className="card p-5 space-y-4">
        <h2 className="font-semibold">1. Recap style</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {TYPES.map((t) => (
            <button key={t.id} type="button" disabled={busy} onClick={() => setType(t.id)} className={clsx('card p-3 text-left transition', type === t.id ? 'border-brand-500 ring-2 ring-brand-500/30' : 'hover:border-brand-400')} aria-pressed={type === t.id}>
              <t.icon className={clsx('w-5 h-5 mb-2', type === t.id ? 'text-brand-500' : 'muted')} />
              <p className="text-sm font-semibold">{t.label}</p>
              <p className="text-[11px] muted">{t.d}</p>
            </button>
          ))}
        </div>
        {type === 'CUSTOM' && (
          <div>
            <label className="label" htmlFor="prompt">Your instructions</label>
            <textarea id="prompt" rows={3} maxLength={2000} className="input" placeholder="e.g. Focus on the villain's backstory, funny tone, end with a question to viewers" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </div>
        )}
        <div className="grid sm:grid-cols-3 gap-4">
          <div className="sm:col-span-1">
            <label className="label" htmlFor="title">Project title</label>
            <input id="title" className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="My recap" />
          </div>
          <div>
            <span className="label">Aspect ratio</span>
            <div className="grid grid-cols-3 gap-1">
              {['9:16', '16:9', '1:1'].map((r) => (
                <button key={r} type="button" disabled={busy} onClick={() => setRatio(r)} className={clsx('btn !px-2 text-xs', ratio === r ? 'btn-primary' : 'btn-secondary')}>{r}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="dur">Target length: {dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`}</label>
            <input id="dur" type="range" min={15} max={600} step={5} value={dur} onChange={(e) => setDur(Number(e.target.value))} className="w-full accent-indigo-500" />
          </div>
        </div>
      </section>

      <section className="card p-5 space-y-4">
        <h2 className="font-semibold">2. Upload video</h2>
        {!file ? (
          <label
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
            className={clsx('flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-2xl p-10 cursor-pointer transition text-center', drag ? 'border-brand-500 bg-brand-500/10' : 'border-[var(--border)] hover:border-brand-400')}
          >
            <UploadCloud className="w-10 h-10 text-brand-500" />
            <div>
              <p className="font-semibold">Drop your video here or click to browse</p>
              <p className="text-xs muted mt-1">MP4, MOV, MKV, WEBM, AVI · up to {maxMb} MB · up to {user?.plan?.maxVideoMinutes ?? 20} minutes on your plan</p>
            </div>
            <input type="file" accept={ACCEPT} className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
        ) : (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-black/5 dark:bg-white/5">
            <FileVideo className="w-8 h-8 text-brand-500 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">{file.name}</p>
              <p className="text-xs muted">{fmtBytes(file.size)}</p>
            </div>
            {!busy && <button className="btn btn-ghost !p-2" onClick={() => setFile(null)} aria-label="Remove file"><X className="w-4 h-4" /></button>}
          </div>
        )}
        {phase === 'uploading' && (
          <div className="space-y-1">
            <ProgressBar value={progress * 100} />
            <div className="flex justify-between text-xs muted">
              <span>Uploading… {Math.round(progress * 100)}%</span>
              <button className="text-red-500" onClick={() => abortRef.current?.abort()}>Cancel upload</button>
            </div>
          </div>
        )}
      </section>

      <section className="card p-5">
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="mt-1 accent-indigo-500" checked={auto} onChange={(e) => setAuto(e.target.checked)} disabled={busy} />
          <span>
            <span className="font-semibold text-sm flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-brand-500" /> Auto-Pilot — one-click recap</span>
            <span className="block text-xs muted mt-0.5">Upload ပြီးတာနဲ့ AI ခွဲခြမ်းစိတ်ဖြာ → မြန်မာ script → မြန်မာအသံ → subtitles → MP4 ကို အလိုအလျောက် ဆက်လုပ်ပေးမယ်။ ပြီးရင် script/အသံ/subtitles ကို ပြင်ပြီး ပြန် render လုပ်နိုင်ပါတယ်။ Credits are reserved per step, exactly like manual runs.</span>
          </span>
        </label>
      </section>

      <section className="card p-5 space-y-3 border-amber-500/40">
        <div className="flex gap-3">
          <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={rights} onChange={(e) => setRights(e.target.checked)} disabled={busy} />
            <span>
              I confirm that I own this video or have the necessary rights/permission to use, edit and publish it, and I accept the{' '}
              <Link href="/copyright" target="_blank" className="text-brand-500 underline">Copyright Policy</Link>. Infringing content will be removed.
            </span>
          </label>
        </div>
      </section>

      {error && <p className="text-sm text-red-500 bg-red-500/10 rounded-lg p-3" role="alert">{error}</p>}
      <div className="flex justify-end gap-3">
        <Link href="/dashboard" className="btn btn-secondary">Cancel</Link>
        <button className="btn btn-primary px-6" disabled={!file || !rights || busy || (type === 'CUSTOM' && !prompt.trim())} onClick={submit}>
          {busy && <Spinner />}
          {phase === 'creating' ? 'Creating project…' : phase === 'uploading' ? 'Uploading…' : phase === 'finalizing' ? 'Finalizing…' : auto ? 'Upload & auto-generate' : 'Upload & continue'}
        </button>
      </div>
    </div>
  );
}
