import Link from 'next/link';
import { Clapperboard } from 'lucide-react';

export function Logo({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-extrabold text-lg tracking-tight" aria-label="RecapAI home">
      <span className="w-8 h-8 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white flex items-center justify-center">
        <Clapperboard className="w-4 h-4" />
      </span>
      Recap<span className="gradient-text">AI</span>
    </Link>
  );
}
