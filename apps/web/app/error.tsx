'use client';
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-2xl font-bold">Something went wrong</p>
      <p className="muted text-sm max-w-md">{error.digest ? `Reference: ${error.digest}` : error.message}</p>
      <button className="btn btn-primary" onClick={reset}>Try again</button>
    </main>
  );
}
