import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { env } from '../env.js';

export interface VoiceOption {
  id: string;
  label: string;
  gender: 'female' | 'male';
  provider: 'azure' | 'espeak';
  description: string;
}

/** Microsoft Azure Neural voices for Burmese (my-MM). Verified locale: my-MM. */
export const AZURE_MY_VOICES: VoiceOption[] = [
  { id: 'my-MM-NilarNeural', label: 'Nilar (နီလာ) — Female', gender: 'female', provider: 'azure', description: 'Warm, clear female narrator' },
  { id: 'my-MM-ThihaNeural', label: 'Thiha (သီဟ) — Male', gender: 'male', provider: 'azure', description: 'Confident male narrator' },
];

export const ESPEAK_VOICES: VoiceOption[] = [
  { id: 'espeak-my', label: 'eSpeak NG Burmese (development only)', gender: 'male', provider: 'espeak', description: 'Robotic open-source voice for local testing' },
];

export function availableVoices(): VoiceOption[] {
  return env().TTS_PROVIDER === 'azure' ? AZURE_MY_VOICES : ESPEAK_VOICES;
}

export function defaultVoice(): string {
  return availableVoices()[0].id;
}

export function isValidVoice(id: string) {
  return availableVoices().some((v) => v.id === id);
}

export class TtsError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
    this.name = 'TtsError';
  }
}

export function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** rate: 0.5–2.0 multiplier; pitch: -50..50 (%) */
export function buildSsml(text: string, voice: string, rate: number, pitch: number) {
  const ratePct = Math.round((rate - 1) * 100);
  const r = `${ratePct >= 0 ? '+' : ''}${ratePct}%`;
  const p = `${pitch >= 0 ? '+' : ''}${Math.round(pitch)}%`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="my-MM"><voice name="${escapeXml(
    voice,
  )}"><prosody rate="${r}" pitch="${p}">${escapeXml(text)}</prosody></voice></speak>`;
}

async function azureSynthesize(text: string, voice: string, rate: number, pitch: number, outFile: string, signal?: AbortSignal) {
  const e = env();
  if (!e.AZURE_SPEECH_KEY || !e.AZURE_SPEECH_REGION) throw new TtsError('Azure Speech is not configured', false);
  const ssml = buildSsml(text, voice, rate, pitch);
  const url = `https://${e.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': e.AZURE_SPEECH_KEY,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
          'User-Agent': 'recapai-worker',
        },
        body: ssml,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const body = await res.text();
        const retryable = res.status === 429 || res.status >= 500;
        const err = new TtsError(`Azure TTS HTTP ${res.status}: ${body.slice(0, 200)}`, retryable);
        if (!retryable) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new TtsError('Azure TTS returned empty audio');
      await writeFile(outFile, buf);
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof TtsError && !err.retryable) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new TtsError(String(lastErr));
}

function run(cmd: string, args: string[], signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new TtsError(`${cmd} exited ${code}: ${err}`))));
  });
}

async function espeakSynthesize(text: string, rate: number, pitch: number, outFile: string, signal?: AbortSignal) {
  const wav = `${outFile}.wav`;
  const wpm = Math.round(150 * rate);
  await run('espeak-ng', ['-v', 'my', '-s', String(wpm), '-p', String(50 + Math.round(pitch / 2)), '-w', wav, text], signal);
  await run(env().FFMPEG_PATH, ['-y', '-v', 'error', '-i', wav, '-ar', '48000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', outFile], signal);
  await rm(wav, { force: true });
}

export async function synthesize(
  text: string,
  opts: { voice: string; rate: number; pitch: number; outFile: string; signal?: AbortSignal },
) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new TtsError('Empty narration text', false);
  if (env().TTS_PROVIDER === 'azure') return azureSynthesize(clean, opts.voice, opts.rate, opts.pitch, opts.outFile, opts.signal);
  return espeakSynthesize(clean, opts.rate, opts.pitch, opts.outFile, opts.signal);
}

/** Verify that the configured TTS works (used by admin health check). */
export async function ttsHealth(): Promise<{ ok: boolean; provider: string; detail?: string }> {
  const e = env();
  if (e.TTS_PROVIDER === 'azure') {
    if (!e.AZURE_SPEECH_KEY || !e.AZURE_SPEECH_REGION) return { ok: false, provider: 'azure', detail: 'Not configured' };
    try {
      const res = await fetch(`https://${e.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
        headers: { 'Ocp-Apim-Subscription-Key': e.AZURE_SPEECH_KEY },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, provider: 'azure', detail: `HTTP ${res.status}` };
      const list = (await res.json()) as Array<{ ShortName: string }>;
      const my = list.filter((v) => v.ShortName.startsWith('my-MM')).map((v) => v.ShortName);
      return { ok: my.length > 0, provider: 'azure', detail: my.join(', ') || 'No my-MM voices in region' };
    } catch (err: any) {
      return { ok: false, provider: 'azure', detail: err?.message };
    }
  }
  return { ok: true, provider: 'espeak', detail: 'Development voice' };
}
