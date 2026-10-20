'use client';
import Link from 'next/link';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';
import { useAuth } from './providers';

export function SiteHeader() {
  const { user } = useAuth();
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
        <Logo />
        <nav className="flex items-center gap-1 sm:gap-2">
          <Link href="/#features" className="btn btn-ghost hidden sm:inline-flex">Features</Link>
          <Link href="/pricing" className="btn btn-ghost hidden sm:inline-flex">Pricing</Link>
          <ThemeToggle />
          {user ? (
            <Link href="/dashboard" className="btn btn-primary">Dashboard</Link>
          ) : (
            <>
              <Link href="/login" className="btn btn-ghost">Log in</Link>
              <Link href="/register" className="btn btn-primary">Start free</Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--border)] mt-24">
      <div className="max-w-6xl mx-auto px-4 py-10 flex flex-col sm:flex-row gap-6 justify-between text-sm muted">
        <p>© {new Date().getFullYear()} RecapAI. Myanmar AI recap video generator.</p>
        <nav className="flex flex-wrap gap-4">
          <Link href="/terms" className="hover:underline">Terms</Link>
          <Link href="/privacy" className="hover:underline">Privacy</Link>
          <Link href="/copyright" className="hover:underline">Copyright & Takedown</Link>
          <Link href="/pricing" className="hover:underline">Pricing</Link>
        </nav>
      </div>
    </footer>
  );
}
