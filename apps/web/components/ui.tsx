'use client';

import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin', className ?? 'w-4 h-4')} aria-hidden />;
}

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 muted" role="status">
      <Spinner className="w-8 h-8 text-brand-500" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card p-8 text-center" role="alert">
      <p className="text-red-500 font-semibold mb-2">Something went wrong</p>
      <p className="muted text-sm mb-4">{message}</p>
      {onRetry && (
        <button className="btn btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="card p-10 text-center flex flex-col items-center gap-3">
      <div className="w-14 h-14 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center">{icon}</div>
      <h3 className="font-semibold text-lg">{title}</h3>
      <p className="muted text-sm max-w-md">{text}</p>
      {action}
    </div>
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={clsx('h-2 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden', className)} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500 transition-all duration-500" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-slate-500/15 text-slate-500',
  UPLOADED: 'bg-sky-500/15 text-sky-500',
  ANALYZING: 'bg-amber-500/15 text-amber-500',
  SCRIPT_READY: 'bg-violet-500/15 text-violet-500',
  VOICING: 'bg-amber-500/15 text-amber-500',
  VOICED: 'bg-indigo-500/15 text-indigo-400',
  RENDERING: 'bg-amber-500/15 text-amber-500',
  COMPLETED: 'bg-emerald-500/15 text-emerald-500',
  FAILED: 'bg-red-500/15 text-red-500',
  QUEUED: 'bg-slate-500/15 text-slate-500',
  ACTIVE: 'bg-amber-500/15 text-amber-500',
  CANCELLED: 'bg-slate-500/15 text-slate-500',
};
const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', UPLOADED: 'Uploaded', ANALYZING: 'Analyzing', SCRIPT_READY: 'Script ready', VOICING: 'Voicing', VOICED: 'Voiced',
  RENDERING: 'Rendering', COMPLETED: 'Completed', FAILED: 'Failed', QUEUED: 'Queued', ACTIVE: 'Running', CANCELLED: 'Cancelled',
};
export function StatusBadge({ status }: { status: string }) {
  return <span className={clsx('badge', STATUS_STYLE[status] ?? 'bg-slate-500/15')}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose} role="dialog" aria-modal aria-label={title}>
      <div className="card w-full sm:max-w-lg max-h-[90vh] overflow-y-auto p-6 rounded-b-none sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">{title}</h3>
        {children}
      </div>
    </div>
  );
}
