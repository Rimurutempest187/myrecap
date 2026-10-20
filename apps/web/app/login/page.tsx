'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth, useToast, type User } from '@/components/providers';
import { Logo } from '@/components/logo';
import { Spinner } from '@/components/ui';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { setUser } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const next = useSearchParams().get('next');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user: User }>('/auth/login', { body: { email, password } });
      setUser(r.user);
      toast('success', `Welcome back, ${r.user.name}!`);
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="card p-8 w-full max-w-md space-y-5">
      <div className="space-y-2">
        <Logo />
        <h1 className="text-2xl font-bold pt-4">Log in</h1>
        <p className="muted text-sm">Continue creating Myanmar recap videos.</p>
      </div>
      {error && <p className="text-sm text-red-500 bg-red-500/10 rounded-lg p-3" role="alert">{error}</p>}
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button className="btn btn-primary w-full py-3" disabled={busy}>
        {busy && <Spinner />} Log in
      </button>
      <p className="text-sm muted text-center">
        No account? <Link href="/register" className="text-brand-500 font-semibold">Create one free</Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-4 hero-glow">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
