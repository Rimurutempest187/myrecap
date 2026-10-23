/**
 * Text-to-speech, routed per voice model from the AI registry.
 * Supported engines:
 *   AZURE_SPEECH     — Microsoft neural voices (my-MM-NilarNeural / my-MM-ThihaNeural) — recommended for Burmese
 *   OPENAI / OPENAI_COMPATIBLE — /audio/speech (e.g. gpt-4o-mini-tts; Burmese quality varies — test first)
 *   GEMINI           — Gemini TTS (gemini-3.1-flash-tts-preview etc.), natural Burmese with the same Gemini API key
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
  const { voices: all } = await listVoices();
  // Hide the robotic development voice as soon as a natural voice is configured.
  const natural = all.filter((v) => v.provider.kind !== 'ESPEAK');
  const voices = natural.length ? natural : all;
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

/** A voice users may pick (dev voice is hidden once natural voices exist). */
export async function isValidVoice(id: string) {
  const v = await voiceModel(id);
  if (!v) return false;
  return (await availableVoices()).some((x) => x.id === v.id);
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

/** Gemini TTS models tried in order when one is rate-limited / unavailable (each has its own quota). */
export const GEMINI_TTS_MODELS = ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-pro-preview-tts'];

/** Prebuilt Gemini voices that sound good in Burmese (all Gemini voices are multilingual). */
export const GEMINI_MY_VOICES: Array<{ voice: string; label: string; description: string }> = [
  { voice: 'Kore', label: 'Gemini Kore — အမျိုးသမီး (တည်ငြိမ်)', description: 'Firm, clear female narrator — great for movie recaps' },
  { voice: 'Charon', label: 'Gemini Charon — အမျိုးသား (ဇာတ်ကြောင်းပြော)', description: 'Informative male storyteller voice' },
  { voice: 'Puck', label: 'Gemini Puck — အမျိုးသား (တက်ကြွ)', description: 'Upbeat, energetic — great for Shorts and anime' },
  { voice: 'Aoede', label: 'Gemini Aoede — အမျိုးသမီး (ပေါ့ပါး)', description: 'Breezy, friendly female voice' },
  { voice: 'Fenrir', label: 'Gemini Fenrir — အမျိုးသား (စိတ်လှုပ်ရှား)', description: 'Excitable, dramatic — action & thriller recaps' },
  { voice: 'Leda', label: 'Gemini Leda — အမျိုးသမီး (နုပျို)', description: 'Youthful female voice' },
  { voice: 'Orus', label: 'Gemini Orus — အမျိုးသား (ခိုင်မာ)', description: 'Firm, deep male narrator' },
  { voice: 'Sulafat', label: 'Gemini Sulafat — အမျိုးသမီး (နွေးထွေး)', description: 'Warm female voice — drama & romance' },
];

const DEFAULT_GEMINI_STYLE = 'Read aloud in natural, fluent Burmese (Myanmar) as an engaging movie recap narrator, with clear pronunciation and expressive storytelling tone';

export function geminiNativeBase(baseUrl: string) {
  return (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '').replace(/\/openai$/, '');
}

function parseRetryDelayMs(body: string) {
  const m = body.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(Number(m[1]) * 1000) : 0;
}

/** Speed/pitch post-processing (Gemini TTS has no rate/pitch params): pitch via asetrate, speed via atempo. */
function tempoPitchFilter(rate: number, pitch: number, srcRate: number) {
  const f: string[] = [];
  let tempo = rate;
  if (pitch) {
    const k = Math.pow(2, pitch / 100 / 2); // ±50 → about ±3 semitones
    f.push(`asetrate=${Math.round(srcRate * k)}`, `aresample=${srcRate}`);
    tempo = tempo / k;
  }
  // atempo supports 0.5–2.0 per stage
  while (tempo > 2) { f.push('atempo=2'); tempo /= 2; }
  while (tempo < 0.5) { f.push('atempo=0.5'); tempo /= 0.5; }
  if (Math.abs(tempo - 1) > 0.01) f.push(`atempo=${tempo.toFixed(3)}`);
  // trim leading/trailing silence so subtitle timing stays tight
  f.push('silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05', 'areverse', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.15', 'areverse');
  return f.join(',');
}

async function gemini(m: ResolvedModel, text: string, rate: number, pitch: number, outFile: string, signal?: AbortSignal) {
  const p = m.provider;
  if (!p.apiKey) throw new TtsError(`${p.name}: Gemini API key is not set`, false);
  const [cfgModel, voice] = m.modelId.includes(':')
    ? m.modelId.split(':')
    : /tts/i.test(m.modelId)
      ? [m.modelId, String(m.config.voice ?? 'Kore')]
      : [String(m.config.model ?? GEMINI_TTS_MODELS[0]), m.modelId];
  const style = String(m.config.style ?? DEFAULT_GEMINI_STYLE);
  const models = [cfgModel, ...(m.config.noFallback ? [] : GEMINI_TTS_MODELS.filter((x) => x !== cfgModel))];
  const base = geminiNativeBase(p.baseUrl);
  const errors: string[] = [];
  let anyRetryable = false;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `${style}:\n${text}` }] }],
            generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
          }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
        });
      } catch (err: any) {
        if (signal?.aborted) throw err;
        errors.push(`${model}: ${err?.message ?? err}`);
        anyRetryable = true;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const raw = await res.text();
      if (res.status === 404 || res.status === 400) {
        errors.push(`${model}: HTTP ${res.status} ${raw.slice(0, 160)}`);
        if (res.status === 400 && /API key|API_KEY/i.test(raw)) throw new TtsError(`${p.name}: invalid Gemini API key`, false);
        break; // model unavailable for this key → next model
      }
      if (res.status === 429 || res.status >= 500) {
        anyRetryable = true;
        errors.push(`${model}: HTTP ${res.status}`);
        const wait = parseRetryDelayMs(raw);
        // Long quota waits: move to the next model (separate quota) instead of blocking.
        if (res.status === 429 && (wait > 20_000 || /per day|PerDay/i.test(raw))) break;
        await sleep(Math.min(20_000, Math.max(wait, 2000 * (attempt + 1))));
        continue;
      }
      if (!res.ok) {
        errors.push(`${model}: HTTP ${res.status} ${raw.slice(0, 160)}`);
        if (res.status === 401 || res.status === 403) throw new TtsError(`${p.name}: Gemini rejected the API key (HTTP ${res.status})`, false);
        break;
      }
      let data: any;
      try { data = JSON.parse(raw); } catch { errors.push(`${model}: non-JSON`); continue; }
      const part = data?.candidates?.[0]?.content?.parts?.find((x: any) => x.inlineData?.data);
      if (!part) {
        // The model occasionally answers with text instead of audio — retry.
        errors.push(`${model}: no audio (${data?.candidates?.[0]?.finishReason ?? 'unknown'})`);
        anyRetryable = true;
        continue;
      }
      const mime: string = part.inlineData.mimeType ?? 'audio/L16;rate=24000';
      const audio = Buffer.from(part.inlineData.data, 'base64');
      if (audio.length < 2000) { errors.push(`${model}: empty audio`); continue; }
      const srcRate = Number(mime.match(/rate=(\d+)/i)?.[1] ?? 24000);
      const isWav = /wav/i.test(mime) || audio.subarray(0, 4).toString('ascii') === 'RIFF';
      const tmp = `${outFile}.${isWav ? 'wav' : 'pcm'}`;
      await writeFile(tmp, audio);
      const input = isWav ? ['-i', tmp] : ['-f', 's16le', '-ar', String(srcRate), '-ac', '1', '-i', tmp];
      try {
        await run(env().FFMPEG_PATH, ['-y', '-v', 'error', ...input, '-af', tempoPitchFilter(rate, pitch, srcRate), '-ar', '48000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '160k', outFile], signal);
      } finally {
        await rm(tmp, { force: true });
      }
      return;
    }
  }
  throw new TtsError(`Gemini TTS failed: ${errors.slice(-4).join(' | ')}`, anyRetryable);
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
    case 'GEMINI':
      return gemini(m, clean, opts.rate, opts.pitch, opts.outFile, opts.signal);
    case 'OPENAI':
    case 'OPENAI_COMPATIBLE':
      return openaiSpeech(m, clean, opts.rate, opts.outFile, opts.signal);
    default:
      throw new TtsError(`${m.provider.kind} does not support text-to-speech`, false);
  }
}

/** Synthesize a short sample to verify a voice works (admin "Test" button). Returns audio bytes. */
export const VOICE_SAMPLE_TEXT = 'မင်္ဂလာပါ။ ဒီနေ့ ကျွန်တော်တို့ ရုပ်ရှင်ကားလေး တစ်ကားအကြောင်း ပြောပြပေးပါမယ်။ ဇာတ်လမ်းက တကယ့်ကို စိတ်လှုပ်ရှားစရာ ကောင်းပါတယ်။';

export async function testVoice(m: ResolvedModel, outFile: string) {
  await synthesizeWith(m, VOICE_SAMPLE_TEXT, { rate: 1, pitch: 0, outFile });
}
