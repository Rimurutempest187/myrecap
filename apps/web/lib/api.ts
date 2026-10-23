'use client';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'include',
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  let data: any = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export function newRequestId() {
  return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, '');
}

const CHUNK_BYTES = 32 * 1024 * 1024; // < Cloudflare's 100 MB request limit, small enough to retry quickly on mobile

function putChunk(url: string, blob: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void, signal?: AbortSignal) {
  return new Promise<{ received: number; complete: boolean; expected?: number; status: number }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      let j: any = {};
      try { j = JSON.parse(xhr.responseText || '{}'); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ ...j, status: xhr.status });
      else if (xhr.status === 409) resolve({ received: j.expected ?? 0, complete: false, expected: j.expected ?? 0, status: 409 });
      else reject(Object.assign(new Error(j?.error?.message || `Upload failed (HTTP ${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

async function uploadChunked(target: string, file: File, headers: Record<string, string>, onProgress: (f: number) => void, signal?: AbortSignal) {
  let offset = 0;
  let failures = 0;
  while (offset < file.size) {
    if (signal?.aborted) throw new Error('Upload cancelled');
    const end = Math.min(file.size, offset + CHUNK_BYTES);
    try {
      const r = await putChunk(`${target}&offset=${offset}`, file.slice(offset, end), headers, (l) => onProgress((offset + l) / file.size), signal);
      if (r.status === 409) { offset = r.expected ?? 0; continue; } // resync with server
      offset = r.received;
      failures = 0;
      onProgress(offset / file.size);
    } catch (e: any) {
      if (signal?.aborted || (e?.status && e.status < 500 && e.status !== 408 && e.status !== 429)) throw e;
      if (++failures > 4) throw e;
      await new Promise((res) => setTimeout(res, 1500 * failures)); // retry this chunk
    }
  }
}

/** Upload a file with progress to a presigned URL (R2/S3 or local signed endpoint). */
export function uploadWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Local driver URLs are absolute to API_PUBLIC_URL; rewrite to same-origin path so the proxy handles it.
    let target = url;
    try {
      const u = new URL(url, window.location.origin);
      if (u.pathname.startsWith('/api/storage/local')) target = u.pathname + u.search;
    } catch {
      /* keep */
    }
    // Behind Cloudflare a single request may not exceed 100 MB, so local-driver uploads go in chunks.
    if (target.startsWith('/api/storage/local') && file.size > CHUNK_BYTES) {
      uploadChunked(target, file, headers, onProgress, signal).then(resolve, reject);
      return;
    }
    xhr.open('PUT', target);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (HTTP ${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

/** Make storage URLs same-origin when using the local driver behind the proxy. */
export function mediaUrl(url: string | null | undefined) {
  if (!url) return undefined;
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    if (u.pathname.startsWith('/api/storage/local')) return u.pathname + u.search;
  } catch {
    /* ignore */
  }
  return url;
}

export const fmtTime = (s: number) => {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

export const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
