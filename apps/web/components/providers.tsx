'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

// ---------------- Theme ----------------
type Theme = 'light' | 'dark';
const ThemeCtx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'dark', toggle: () => {} });
export const useTheme = () => useContext(ThemeCtx);

function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    const saved = (localStorage.getItem('theme') as Theme | null) ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    setTheme(saved);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);
  return <ThemeCtx.Provider value={{ theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }}>{children}</ThemeCtx.Provider>;
}

// ---------------- Toasts ----------------
type Toast = { id: number; kind: 'success' | 'error' | 'info'; message: string };
const ToastCtx = createContext<(kind: Toast['kind'], message: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[100] flex flex-col gap-2 sm:w-96" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="card shadow-xl px-4 py-3 flex items-start gap-3 text-sm">
            {t.kind === 'success' ? <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" /> : t.kind === 'error' ? <AlertCircle className="w-5 h-5 text-red-500 shrink-0" /> : <Info className="w-5 h-5 text-brand-500 shrink-0" />}
            <p className="flex-1">{t.message}</p>
            <button aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="muted hover:opacity-80">
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------- Auth ----------------
export interface Plan {
  id: string; code: string; name: string; priceCents: number; currency: string; monthlyCredits: number; maxUploadMb: number;
  maxVideoMinutes: number; maxConcurrentJobs: number; maxOutputHeight: number; watermark: boolean; features: string[]; purchasable: boolean;
}
export interface User {
  id: string; email: string; name: string; role: 'USER' | 'ADMIN'; creditBalance: number; monthlyCreditLimit: number | null; plan: Plan | null;
}
const AuthCtx = createContext<{ user: User | null; loading: boolean; refresh: () => Promise<void>; setUser: (u: User | null) => void }>({
  user: null, loading: true, refresh: async () => {}, setUser: () => {},
});
export const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: User | null }>('/auth/me');
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return <AuthCtx.Provider value={{ user, loading, refresh, setUser }}>{children}</AuthCtx.Provider>;
}

// ---------------- Live job events (SSE with polling fallback) ----------------
export interface JobEvent {
  jobId: string; projectId: string | null; type: string; status: string; progress: number; stage?: string | null; error?: string | null; projectStatus?: string;
}
type Listener = (e: JobEvent) => void;
const EventsCtx = createContext<{ subscribe: (l: Listener) => () => void; connected: boolean }>({ subscribe: () => () => {}, connected: false });
export const useJobEvents = () => useContext(EventsCtx);

function EventsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!user) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let stopped = false;
    let readyTimer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const connect = () => {
      es = new EventSource('/api/jobs/events', { withCredentials: true });
      // Some proxies (e.g. Cloudflare quick tunnels) buffer SSE. If "ready" never arrives,
      // report disconnected so pages fall back to polling, and retry the stream with backoff.
      clearTimeout(readyTimer);
      readyTimer = setTimeout(() => {
        setConnected(false);
        es?.close();
        failures++;
        if (!stopped) retry = setTimeout(connect, Math.min(60_000, 5000 * failures));
      }, 8000);
      es.addEventListener('ready', () => {
        clearTimeout(readyTimer);
        failures = 0;
        setConnected(true);
      });
      es.addEventListener('job', (m) => {
        try {
          const ev = JSON.parse((m as MessageEvent).data) as JobEvent;
          listeners.current.forEach((l) => l(ev));
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        clearTimeout(readyTimer);
        setConnected(false);
        es?.close();
        failures++;
        if (!stopped) retry = setTimeout(connect, Math.min(60_000, 4000 * failures));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(readyTimer);
      es?.close();
    };
  }, [user]);
  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => listeners.current.delete(l);
  }, []);
  return <EventsCtx.Provider value={{ subscribe, connected }}>{children}</EventsCtx.Provider>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <EventsProvider>{children}</EventsProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
