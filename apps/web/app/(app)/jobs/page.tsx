'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ListChecks, RotateCcw, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useJobEvents, useToast } from '@/components/providers';
import { EmptyState, ErrorState, PageLoader, ProgressBar, StatusBadge } from '@/components/ui';

interface JobItem { id: string; projectId: string | null; projectTitle: string | null; type: string; status: string; progress: number; stage: string | null; error: string | null; creditsReserved: number; creditsCharged: number; createdAt: string; finishedAt: string | null }

export default function JobsPage() {
  const [items, setItems] = useState<JobItem[] | null>(null);
  const [error, setError] = useState('');
  const { subscribe } = useJobEvents();
  const toast = useToast();
  const load = useCallback(() => api<{ items: JobItem[] }>('/jobs?limit=100').then((r) => setItems(r.items)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => subscribe((ev) => {
    setItems((cur) => {
      if (!cur) return cur;
      if (!cur.some((j) => j.id === ev.jobId)) { load(); return cur; }
      return cur.map((j) => (j.id === ev.jobId ? { ...j, status: ev.status, progress: ev.progress, stage: ev.stage ?? j.stage, error: ev.error ?? j.error } : j));
    });
  }), [subscribe, load]);

  const act = async (id: string, action: 'cancel' | 'retry') => {
    try {
      await api(`/jobs/${id}/${action}`, { method: 'POST' });
      toast('success', action === 'cancel' ? 'Cancellation requested' : 'Job queued again');
      load();
    } catch (e: any) { toast('error', e.message); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <PageLoader />;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Job history</h1>
      {items.length === 0 ? (
        <EmptyState icon={<ListChecks className="w-7 h-7" />} title="No jobs yet" text="Processing jobs (analysis, voiceover, rendering) will appear here." />
      ) : (
        <div className="card divide-y divide-[var(--border)]">
          {items.map((j) => (
            <div key={j.id} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm">{j.type}</span>
                  <StatusBadge status={j.status} />
                  {j.projectId && <Link href={`/projects/${j.projectId}`} className="text-sm text-brand-500 truncate my-text">{j.projectTitle}</Link>}
                </div>
                <p className="text-xs muted mt-1">
                  {new Date(j.createdAt).toLocaleString()} · {j.status === 'COMPLETED' ? `${j.creditsCharged} credits` : `${j.creditsReserved} credits reserved`}
                  {j.stage && ['ACTIVE', 'QUEUED'].includes(j.status) && ` · ${j.stage}`}
                </p>
                {['ACTIVE', 'QUEUED'].includes(j.status) && <ProgressBar value={j.progress} className="mt-2" />}
                {j.error && j.status === 'FAILED' && <p className="text-xs text-red-500 mt-1">{j.error}</p>}
              </div>
              <div className="flex gap-2">
                {['ACTIVE', 'QUEUED'].includes(j.status) && <button className="btn btn-secondary text-xs" onClick={() => act(j.id, 'cancel')}><XCircle className="w-4 h-4" /> Cancel</button>}
                {['FAILED', 'CANCELLED'].includes(j.status) && j.type !== 'PROBE' && <button className="btn btn-secondary text-xs" onClick={() => act(j.id, 'retry')}><RotateCcw className="w-4 h-4" /> Retry</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
