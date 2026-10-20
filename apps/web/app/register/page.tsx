'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth, useToast, type User } from '@/components/providers';
import { Logo } from '@/components/logo';
import { Spinner } from '@/components/ui';

export default function RegisterPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '', acceptTerms: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { setUser } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const pwOk = form.password.length >= 8 && /[A-Za-z]/.test(form.password) && /\d/.test(form.password);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user: User }>('/auth/register', { body: form });
      setUser(r.user);
      toast('success', `Account created — you received ${r.user.creditBalance} free credits!`);
      router.replace('/projects/new');
    } catch (err: any) {
      const fe = err.details?.fieldErrors;
      setError(fe ? Object.values(fe).flat().join('. ') : err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="min-h-screen flex items-center justify-center p-4 hero-glow">
      <form onSubmit={submit} className="card p-8 w-full max-w-md space-y-5">
        <div className="space-y-2">
          <Logo />
          <h1 className="text-2xl font-bold pt-4">Create your account</h1>
          <p className="muted text-sm">Free credits included. No card required.</p>
        </div>
        {error && <p className="text-sm text-red-500 bg-red-500/10 rounded-lg p-3" role="alert">{error}</p>}
        <div>
          <label className="label" htmlFor="name">Name</label>
          <input id="name" required maxLength={80} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="new-password" required className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <p className={`text-xs mt-1 ${form.password && !pwOk ? 'text-amber-500' : 'muted'}`}>At least 8 characters with letters and numbers.</p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.acceptTerms} onChange={(e) => setForm({ ...form, acceptTerms: e.target.checked })} />
          <span className="muted">
            I agree to the <Link href="/terms" className="text-brand-500 underline" target="_blank">Terms of Service</Link> and{' '}
            <Link href="/copyright" className="text-brand-500 underline" target="_blank">Copyright Policy</Link>.
          </span>
        </label>
        <button className="btn btn-primary w-full py-3" disabled={busy || !form.acceptTerms || !pwOk}>
          {busy && <Spinner />} Create account
        </button>
        <p className="text-sm muted text-center">
          Already have an account? <Link href="/login" className="text-brand-500 font-semibold">Log in</Link>
        </p>
      </form>
    </main>
  );
}
