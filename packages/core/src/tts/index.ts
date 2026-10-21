/**
 * Text-to-speech, routed per voice model from the AI registry.
 * Supported engines:
 *   AZURE_SPEECH     — Microsoft neural voices (my-MM-NilarNeural / my-MM-ThihaNeural) — recommended for Burmese
 *   OPENAI / OPENAI_COMPATIBLE — /audio/speech (e.g. gpt-4o-mini-tts; Burmese quality varies — test first)
 *   ESPEAK           — local eSpeak NG (development only)
 */
import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { env } from '../env.js';
import { listVoices } from '../ai/registry.js';
import type { ResolvedModel } from '../ai/providers.js';

export interface VoiceOption {
  id: string; // AiModel.id (or env:… / espeak-my)
  label: string;
  provider: string;
  engine: string;
  description: string;
}

export class TtsError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
    this.name = 'TtsError';
  }
}

export async function availableVoices(): Promise<VoiceOption[]> {
  const { voices } = await listVoices();
  return voices.map((v) => ({
    id: v.id,
    label: v.displayName,
    provider: v.provider.name,
    engine: v.provider.kind,
    description: String(v.description ?? (v.provider.kind === 'ESPEAK' ? 'Robotic open-source voice for local testing' : `${v.provider.name} · ${v.modelId}`)),
  }));
}

export async function defaultVoice(): Promise<string | null> {
  return (await listVoices()).defaultVoiceId;
}

/** Find a voice by registry id; also accepts legacy ids (vendor voice name, "env:<voice>", "espeak-my"). */
export async function voiceModel(id: string): Promise<ResolvedModel | null> {
  const { voices } = await listVoices();
  const bare = id.replace(/^env:/, '');
  return (
    voices.find((v) => v.id === id) ??
    voices.find((v) => v.modelId === bare) ??
    (id === 'espeak-my' ? voices.find((v) => v.provider.kind === 'ESPEAK') : undefined) ??
    null
  );
}

export async function isValidVoice(id: string) {
  return !!(await voiceModel(id));
}

export function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** rate: 0.5–2.0 multiplier; pitch: -50..50 (%) */
export function buildSsml(text: string, voice: string, rate: number, pitch: number, lang = 'my-MM') {
  const ratePct = Math.round((rate - 1) * 100);
  const r = `${ratePct >= 0 ? '+' : ''}${ratePct}%`;
  const p = `${pitch >= 0 ? '+' : ''}${Math.round(pitch)}%`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${escapeXml(
    voice,
  )}"><prosody rate="${r}" pitch="${p}">${escapeXml(text)}</prosody></voice></speak>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetries(fn: () => Promise<void>, signal?: AbortSignal) {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof TtsError && !err.retryable) throw err;
      last = err;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new TtsError(String(last));
}

async function azure(m: ResolvedModel, text: string, rate: number, pitch: number, outFile: string, signal?: AbortSignal) {
  const { apiKey, region } = m.provider;
  if (!apiKey || !region) throw new TtsError(`${m.provider.name}: Azure key/region not set`, false);
  const ssml = buildSsml(text, m.modelId, rate, pitch, String(m.config.locale ?? 'my-MM'));
  await withRetries(async () => {
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
        'User-Agent': 'recapai-worker',
      },
      body: ssml,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new TtsError(`Azure TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status === 429 || res.status >= 500);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) throw new TtsError('Azure TTS returned empty audio');
    await writeFile(outFile, buf);
  }, signal);
}

async function openaiSpeech(m: ResolvedModel, text: string, rate: number, outFile: string, signal?: AbortSignal) {
  const p = m.provider;
  const [model, voice] = m.modelId.includes(':') ? m.modelId.split(':') : [String(m.config.model ?? 'gpt-4o-mini-tts'), m.modelId];
  await withRetries(async () => {
    const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        speed: Math.max(0.25, Math.min(4, rate)),
        response_format: 'mp3',
        ...(m.config.instructions ? { instructions: m.config.instructions } : { instructions: 'Speak in natural Burmese (Myanmar) as a recap narrator.' }),
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new TtsError(`${p.name} TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status === 429 || res.status >= 500);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) throw new TtsError(`${p.name} TTS returned empty audio`);
    await writeFile(outFile, buf);
  }, signal);
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

async function espeak(text: string, rate: number, pitch: number, outFile: string, signal?: AbortSignal) {
  const wav = `${outFile}.wav`;
  await run('espeak-ng', ['-v', 'my', '-s', String(Math.round(150 * rate)), '-p', String(50 + Math.round(pitch / 2)), '-w', wav, text], signal);
  await run(env().FFMPEG_PATH, ['-y', '-v', 'error', '-i', wav, '-ar', '48000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', outFile], signal);
  await rm(wav, { force: true });
}

export async function synthesizeWith(
  m: ResolvedModel,
  text: string,
  opts: { rate: number; pitch: number; outFile: string; signal?: AbortSignal },
) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new TtsError('Empty narration text', false);
  switch (m.provider.kind) {
    case 'AZURE_SPEECH':
      return azure(m, clean, opts.rate, opts.pitch, opts.outFile, opts.signal);
    case 'ESPEAK':
      return espeak(clean, opts.rate, opts.pitch, opts.outFile, opts.signal);
    case 'OPENAI':
    case 'OPENAI_COMPATIBLE':
      return openaiSpeech(m, clean, opts.rate, opts.outFile, opts.signal);
    default:
      throw new TtsError(`${m.provider.kind} does not support text-to-speech`, false);
  }
}

/** Synthesize a short sample to verify a voice works (admin "Test" button). Returns audio bytes. */
export async function testVoice(m: ResolvedModel, outFile: string) {
  await synthesizeWith(m, 'မင်္ဂလာပါ။ ဒါက RecapAI ရဲ့ မြန်မာ အသံ စမ်းသပ်ချက် ဖြစ်ပါတယ်။', { rate: 1, pitch: 0, outFile });
}
