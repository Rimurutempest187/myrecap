'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth, useToast } from '@/components/providers';
import { Modal, Spinner } from '@/components/ui';
import { Trash2 } from 'lucide-react';

export default function AccountPage() {
  const { user, refresh, setUser } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState(user?.name ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [busy, setBusy] = useState('');
  const [del, setDel] = useState(false);
  const [delPw, setDelPw] = useState('');

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast('success', ok); } catch (e: any) { toast('error', e.details?.fieldErrors ? Object.values(e.details.fieldErrors).flat().join('. ') : e.message); } finally { setBusy(''); }
  };
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Account</h1>
      <section className="card p-5 space-y-4">
        <h2 className="font-semibold">Profile</h2>
        <div><label className="label">Email</label><input className="input" value={user?.email ?? ''} disabled /></div>
        <div><label className="label" htmlFor="nm">Name</label><input id="nm" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <button className="btn btn-primary" disabled={busy === 'p' || !name.trim()} onClick={() => run('p', async () => { await api('/auth/me', { method: 'PATCH', body: { name } }); await refresh(); }, 'Profile updated')}>{busy === 'p' && <Spinner />} Save profile</button>
      </section>
      <section className="card p-5 space-y-4">
        <h2 className="font-semibold">Change password</h2>
        <div><label className="label" htmlFor="cp">Current password</label><input id="cp" type="password" autoComplete="current-password" className="input" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></div>
        <div><label className="label" htmlFor="np">New password</label><input id="np" type="password" autoComplete="new-password" className="input" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></div>
        <button className="btn btn-secondary" disabled={busy === 'pw' || !pw.currentPassword || pw.newPassword.length < 8} onClick={() => run('pw', async () => { await api('/auth/change-password', { body: pw }); setPw({ currentPassword: '', newPassword: '' }); }, 'Password changed. Other sessions were signed out.')}>{busy === 'pw' && <Spinner />} Update password</button>
      </section>
      <section className="card p-5 space-y-3 border-red-500/40">
        <h2 className="font-semibold text-red-500">Delete account</h2>
        <p className="text-sm muted">Permanently deletes your account, all projects, uploaded videos and rendered files. Remaining credits are forfeited.</p>
        <button className="btn btn-danger" onClick={() => setDel(true)}><Trash2 className="w-4 h-4" /> Delete my account</button>
      </section>
      <Modal open={del} onClose={() => setDel(false)} title="Delete your account permanently?">
        <p className="text-sm muted mb-4">Enter your password to confirm. This cannot be undone.</p>
        <input type="password" className="input" value={delPw} onChange={(e) => setDelPw(e.target.value)} placeholder="Password" />
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-secondary" onClick={() => setDel(false)}>Cancel</button>
          <button className="btn btn-danger" disabled={!delPw || busy === 'd'} onClick={() => run('d', async () => { await api('/auth/me', { method: 'DELETE', body: { password: delPw } }); setUser(null); router.replace('/'); }, 'Account deleted')}>{busy === 'd' && <Spinner />} Delete everything</button>
        </div>
      </Modal>
    </div>
  );
}
