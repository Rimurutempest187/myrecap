'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Film, PlusCircle, Search, Clock, Smartphone, Monitor, Square } from 'lucide-react';
import { api, mediaUrl } from '@/lib/api';
import { useAuth, useJobEvents } from '@/components/providers';
import { EmptyState, ErrorState, PageLoader, StatusBadge } from '@/components/ui';

interface ProjectItem {
  id: string; title: string; recapType: string; aspectRatio: string; status: string; thumbnailUrl: string | null; createdAt: string; updatedAt: string;
}
const TYPE_LABEL: Record<string, string> = { ANIME: 'Anime', MOVIE: 'Movie', SHORTS: 'Shorts', HIGHLIGHTS: 'Highlights', CUSTOM: 'Custom' };
const RATIO_ICON: Record<string, typeof Smartphone> = { '9:16': Smartphone, '16:9': Monitor, '1:1': Square };

export default function Dashboard() {
  const { user } = useAuth();
  const { subscribe } = useJobEvents();
  const [items, setItems] = useState<ProjectItem[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      const r = await api<{ items: ProjectItem[] }>(`/projects?${params}`);
      setItems(r.items);
    } catch (e: any) {
      setError(e.message);
    }
  }, [q, status]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => subscribe((ev) => ev.projectStatus && setItems((cur) => cur?.map((p) => (p.id === ev.projectId ? { ...p, status: ev.projectStatus! } : p)) ?? cur)), [subscribe]);

  const counts = {
    total: items?.length ?? 0,
    done: items?.filter((p) => p.status === 'COMPLETED').length ?? 0,
    active: items?.filter((p) => ['ANALYZING', 'VOICING', 'RENDERING'].includes(p.status)).length ?? 0,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Hi {user?.name?.split(' ')[0]} 👋</h1>
          <p className="muted text-sm">Your recap projects</p>
        </div>
        <Link href="/projects/new" className="btn btn-primary">
          <PlusCircle className="w-4 h-4" /> New recap
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          ['Projects', counts.total],
          ['Completed', counts.done],
          ['Processing', counts.active],
        ].map(([l, v]) => (
          <div key={l} className="card p-4">
            <p className="text-xs muted">{l}</p>
            <p className="text-2xl font-bold">{v}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 muted" />
          <input className="input pl-9" placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search projects" />
        </div>
        <select className="input sm:w-48" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {['DRAFT', 'UPLOADED', 'SCRIPT_READY', 'VOICED', 'COMPLETED', 'FAILED'].map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>
          ))}
        </select>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !items ? (
        <PageLoader />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Film className="w-7 h-7" />}
          title={q || status ? 'No matching projects' : 'No projects yet'}
          text="Upload a video and let AI create a Myanmar-narrated recap with subtitles in minutes."
          action={<Link href="/projects/new" className="btn btn-primary mt-2"><PlusCircle className="w-4 h-4" /> Create your first recap</Link>}
        />
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {items.map((p) => {
            const RI = RATIO_ICON[p.aspectRatio] ?? Monitor;
            return (
              <Link key={p.id} href={`/projects/${p.id}`} className="card overflow-hidden hover:border-brand-500 transition group">
                <div className="aspect-video bg-black/30 relative overflow-hidden">
                  {p.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={mediaUrl(p.thumbnailUrl)} alt="" className="w-full h-full object-cover group-hover:scale-105 transition duration-500" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center muted"><Film className="w-10 h-10" /></div>
                  )}
                  <div className="absolute top-2 left-2"><StatusBadge status={p.status} /></div>
                </div>
                <div className="p-4">
                  <p className="font-semibold truncate my-text">{p.title}</p>
                  <div className="flex items-center gap-3 text-xs muted mt-1">
                    <span>{TYPE_LABEL[p.recapType]}</span>
                    <span className="flex items-center gap-1"><RI className="w-3 h-3" /> {p.aspectRatio}</span>
                    <span className="flex items-center gap-1 ml-auto"><Clock className="w-3 h-3" /> {new Date(p.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
