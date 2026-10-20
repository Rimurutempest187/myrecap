'use client';
import { useState } from 'react';
import { SiteHeader, SiteFooter } from '@/components/site-header';
import { api } from '@/lib/api';
import { Spinner } from '@/components/ui';
import { CheckCircle2 } from 'lucide-react';

export default function CopyrightPage() {
  const [f, setF] = useState({ reporterName: '', reporterEmail: '', rightsHolder: '', contentUrl: '', projectId: '', description: '', swornStatement: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ id: string }>('/takedown', { body: f });
      setDone(r.id);
    } catch (err: any) {
      const fe = err.details?.fieldErrors;
      setError(fe ? Object.entries(fe).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`).join('. ') : err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SiteHeader />
      <main className="max-w-3xl mx-auto px-4 py-16">
        <h1 className="text-3xl font-bold">Copyright policy & takedown requests</h1>
        <div className="text-sm leading-7 mt-4 space-y-3">
          <p>RecapAI users must confirm they own or are licensed to use every video they upload. Background music offered in the editor comes only from our licensed library, with license details shown for each track.</p>
          <p>If you believe content processed or distributed through RecapAI infringes your copyright, submit the form below. We review every request, remove infringing content, and terminate accounts of repeat infringers.</p>
        </div>
        {done ? (
          <div className="card p-8 mt-8 text-center">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
            <h2 className="font-semibold text-lg mt-3">Request received</h2>
            <p className="muted text-sm mt-1">Reference: {done}. Our team will review it and contact you by email.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="card p-6 mt-8 space-y-4">
            {error && <p className="text-sm text-red-500 bg-red-500/10 rounded-lg p-3" role="alert">{error}</p>}
            <div className="grid sm:grid-cols-2 gap-4">
              <div><label className="label">Your name</label><input required className="input" value={f.reporterName} onChange={(e) => setF({ ...f, reporterName: e.target.value })} /></div>
              <div><label className="label">Email</label><input required type="email" className="input" value={f.reporterEmail} onChange={(e) => setF({ ...f, reporterEmail: e.target.value })} /></div>
            </div>
            <div><label className="label">Copyright owner</label><input required className="input" value={f.rightsHolder} onChange={(e) => setF({ ...f, rightsHolder: e.target.value })} /></div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div><label className="label">URL of infringing content</label><input type="url" className="input" placeholder="https://" value={f.contentUrl} onChange={(e) => setF({ ...f, contentUrl: e.target.value })} /></div>
              <div><label className="label">or RecapAI project ID</label><input className="input" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })} /></div>
            </div>
            <div><label className="label">Description of the copyrighted work and the infringement</label><textarea required minLength={20} rows={5} className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={f.swornStatement} onChange={(e) => setF({ ...f, swornStatement: e.target.checked })} />
              <span className="muted">I have a good-faith belief that the use is not authorized by the copyright owner, its agent, or the law, and the information in this notice is accurate. I am the owner or authorized to act on the owner's behalf.</span>
            </label>
            <button className="btn btn-primary" disabled={busy || !f.swornStatement}>{busy && <Spinner />} Submit takedown request</button>
          </form>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
