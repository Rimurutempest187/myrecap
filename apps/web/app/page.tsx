import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/site-header';
import { Upload, ScanSearch, PenLine, Mic, Captions, Film, Sparkles, Smartphone, Monitor, Square, ShieldCheck, Zap, Download } from 'lucide-react';

const FEATURES = [
  { icon: ScanSearch, title: 'AI video analysis', text: 'FFmpeg scene detection plus a vision model describes every scene and scores the most important moments.' },
  { icon: PenLine, title: 'Myanmar recap script', text: 'An LLM writes natural spoken Burmese narration and picks the exact timestamps to show for each line.' },
  { icon: Mic, title: 'Burmese AI voiceover', text: 'Microsoft Azure neural voices Nilar & Thiha (my-MM) with speed and pitch control.' },
  { icon: Captions, title: 'Myanmar Unicode subtitles', text: 'Auto-timed, syllable-safe line breaks, fully editable text & timing, burned in with Noto Sans Myanmar.' },
  { icon: Film, title: 'Automatic editing', text: 'Clip cutting, transitions, ducked original audio, background music and loudness normalization.' },
  { icon: Download, title: 'MP4 export', text: 'H.264/AAC MP4 in 9:16, 16:9 or 1:1 — ready for TikTok, YouTube, Facebook and Reels.' },
];
const TYPES = [
  ['Anime Recap', 'Dramatic episode & season recaps'],
  ['Movie Recap', 'Full plot explained, start to finish'],
  ['Long-to-Shorts', 'Hook-driven 30–60s vertical clips'],
  ['Highlights', 'Best moments with commentary'],
  ['Custom Recap', 'Your own instructions & tone'],
];
const STEPS = [
  { icon: Upload, t: 'Upload', d: 'Drop your video (MP4, MOV, MKV, WEBM).' },
  { icon: Sparkles, t: 'AI analyzes', d: 'Scenes, key moments and a Myanmar script.' },
  { icon: PenLine, t: 'Edit', d: 'Tweak narration, timestamps and subtitles.' },
  { icon: Mic, t: 'Voice', d: 'Generate the Burmese voiceover.' },
  { icon: Film, t: 'Render & download', d: 'Get your finished MP4.' },
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 hero-glow pointer-events-none" />
          <div className="relative max-w-6xl mx-auto px-4 pt-20 pb-16 text-center">
            <span className="badge bg-brand-500/15 text-brand-400 mb-6">
              <Sparkles className="w-3 h-3" /> All-in-one AI recap studio for Myanmar creators
            </span>
            <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-tight">
              Long videos into <span className="gradient-text">Myanmar recap videos</span>, automatically
            </h1>
            <p className="my-text text-lg muted mt-6 max-w-2xl mx-auto">
              ဗီဒီယိုကို upload လုပ်လိုက်ရုံနဲ့ AI က ဇာတ်လမ်းကိုခွဲခြမ်းစိတ်ဖြာ၊ မြန်မာလို ဇာတ်ညွှန်းရေး၊ အသံသွင်း၊ စာတန်းထိုးပြီး Recap ဗီဒီယို အပြီးထုတ်ပေးပါတယ်။
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/register" className="btn btn-primary text-base px-6 py-3">
                <Zap className="w-4 h-4" /> Create your first recap — free
              </Link>
              <Link href="/pricing" className="btn btn-secondary text-base px-6 py-3">See pricing</Link>
            </div>
            <div className="mt-10 flex justify-center gap-6 text-sm muted">
              <span className="flex items-center gap-2"><Smartphone className="w-4 h-4" /> 9:16</span>
              <span className="flex items-center gap-2"><Monitor className="w-4 h-4" /> 16:9</span>
              <span className="flex items-center gap-2"><Square className="w-4 h-4" /> 1:1</span>
            </div>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {TYPES.map(([t, d]) => (
              <div key={t} className="card p-4">
                <p className="font-semibold">{t}</p>
                <p className="text-xs muted mt-1">{d}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="max-w-6xl mx-auto px-4 mt-24">
          <h2 className="text-3xl font-bold text-center">Everything in one pipeline</h2>
          <p className="muted text-center mt-2">Real AI and real FFmpeg rendering — no templates, no manual editing required.</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-10">
            {FEATURES.map((f) => (
              <article key={f.title} className="card p-6">
                <div className="w-10 h-10 rounded-xl bg-brand-500/15 text-brand-500 flex items-center justify-center mb-4">
                  <f.icon className="w-5 h-5" />
                </div>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="text-sm muted mt-2">{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-4 mt-24">
          <h2 className="text-3xl font-bold text-center">How it works</h2>
          <ol className="grid sm:grid-cols-5 gap-4 mt-10">
            {STEPS.map((s, i) => (
              <li key={s.t} className="card p-5 text-center">
                <div className="w-10 h-10 mx-auto rounded-full bg-gradient-to-br from-brand-500 to-accent-500 text-white flex items-center justify-center font-bold">{i + 1}</div>
                <p className="font-semibold mt-3">{s.t}</p>
                <p className="text-xs muted mt-1">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="max-w-4xl mx-auto px-4 mt-24">
          <div className="card p-8 flex flex-col sm:flex-row items-center gap-6">
            <ShieldCheck className="w-12 h-12 text-emerald-500 shrink-0" />
            <div>
              <h3 className="font-semibold text-lg">Private by default, respectful of copyright</h3>
              <p className="text-sm muted mt-1">
                Your uploads are stored privately and served only through short-lived signed links. You must confirm you have the rights to every video you upload, and rights holders can file a{' '}
                <Link href="/copyright" className="text-brand-500 underline">takedown request</Link>. Delete any project — and its files — at any time.
              </p>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
