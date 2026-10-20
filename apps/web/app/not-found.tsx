import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-6xl font-extrabold gradient-text">404</p>
      <p className="muted">This page could not be found.</p>
      <Link href="/" className="btn btn-primary">Go home</Link>
    </main>
  );
}
