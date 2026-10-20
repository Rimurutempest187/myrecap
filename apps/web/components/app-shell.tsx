'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { LayoutDashboard, PlusCircle, CreditCard, User, Shield, LogOut, Menu, X, Coins, ListChecks } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from './providers';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';
import { PageLoader } from './ui';
import { api } from '@/lib/api';

const NAV = [
  { href: '/dashboard', label: 'Projects', icon: LayoutDashboard },
  { href: '/projects/new', label: 'New Recap', icon: PlusCircle },
  { href: '/jobs', label: 'Job History', icon: ListChecks },
  { href: '/billing', label: 'Credits & Plans', icon: CreditCard },
  { href: '/account', label: 'Account', icon: User },
];

export function AppShell({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading, setUser } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(path)}`);
    if (!loading && user && admin && user.role !== 'ADMIN') router.replace('/dashboard');
  }, [loading, user, router, path, admin]);
  useEffect(() => setOpen(false), [path]);

  if (loading || !user || (admin && user.role !== 'ADMIN')) return <PageLoader />;

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
    router.replace('/login');
  };

  const nav = (
    <nav className="flex flex-col gap-1" aria-label="Main">
      {NAV.map((n) => {
        const active = path === n.href || (n.href !== '/dashboard' && path.startsWith(n.href)) || (n.href === '/dashboard' && path.startsWith('/projects/') && path !== '/projects/new');
        return (
          <Link key={n.href} href={n.href} className={clsx('flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition', active ? 'bg-brand-500/15 text-brand-500' : 'muted hover:bg-black/5 dark:hover:bg-white/5')}>
            <n.icon className="w-4 h-4" />
            {n.label}
          </Link>
        );
      })}
      {user.role === 'ADMIN' && (
        <Link href="/admin" className={clsx('flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition', path.startsWith('/admin') ? 'bg-brand-500/15 text-brand-500' : 'muted hover:bg-black/5 dark:hover:bg-white/5')}>
          <Shield className="w-4 h-4" />
          Admin
        </Link>
      )}
    </nav>
  );

  return (
    <div className="min-h-screen flex">
      <aside className="hidden lg:flex w-64 shrink-0 flex-col gap-6 p-5 border-r border-[var(--border)] sticky top-0 h-screen">
        <Logo href="/dashboard" />
        {nav}
        <div className="mt-auto space-y-3">
          <Link href="/billing" className="card p-3 flex items-center gap-3 hover:border-brand-500 transition">
            <Coins className="w-5 h-5 text-amber-500" />
            <div>
              <p className="text-xs muted">Credits</p>
              <p className="font-bold">{user.creditBalance.toLocaleString()}</p>
            </div>
            <span className="ml-auto badge bg-brand-500/15 text-brand-500">{user.plan?.name ?? 'Free'}</span>
          </Link>
          <div className="flex items-center justify-between">
            <ThemeToggle />
            <button onClick={logout} className="btn btn-ghost text-sm">
              <LogOut className="w-4 h-4" /> Log out
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        <header className="lg:hidden sticky top-0 z-40 flex items-center justify-between px-4 h-14 border-b border-[var(--border)] bg-[var(--bg)]/90 backdrop-blur">
          <Logo href="/dashboard" />
          <div className="flex items-center gap-1">
            <Link href="/billing" className="badge bg-amber-500/15 text-amber-500">
              <Coins className="w-3 h-3" /> {user.creditBalance}
            </Link>
            <ThemeToggle />
            <button className="btn btn-ghost !p-2" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open}>
              {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </header>
        {open && (
          <div className="lg:hidden border-b border-[var(--border)] p-4 space-y-3 bg-[var(--card)]">
            {nav}
            <button onClick={logout} className="btn btn-secondary w-full">
              <LogOut className="w-4 h-4" /> Log out
            </button>
          </div>
        )}
        <main className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">{children}</main>
      </div>
    </div>
  );
}
