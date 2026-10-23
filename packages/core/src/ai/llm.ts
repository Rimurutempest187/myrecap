import { env } from '../env.js';

export interface ChatImage {
  dataUrl: string;
}
export type ChatContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }>;
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}
export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

export class LlmError extends Error {
  constructor(message: string, public status?: number, public retryable = true) {
    super(message);
    this.name = 'LlmError';
  }
}

/** OpenAI-compatible chat completion (works with OpenAI, Azure OpenAI proxies, OpenRouter, Gemini OpenAI endpoint, etc.) */
export async function chat(
  messages: ChatMessage[],
  opts: { model?: string; json?: boolean; signal?: AbortSignal; maxTokens?: number; temperature?: number } = {},
): Promise<ChatResult> {
  const e = env();
  if (!e.LLM_API_KEY) throw new LlmError('LLM_API_KEY is not configured', undefined, false);
  const model = opts.model || e.LLM_MODEL;
  const body: Record<string, unknown> = { model, messages };
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_completion_tokens = opts.maxTokens;
  if (opts.temperature !== undefined && !/^(gpt-5|o\d)/.test(model)) body.temperature = opts.temperature;

  const timeout = AbortSignal.timeout(e.LLM_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${e.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${e.LLM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err: any) {
    if (opts.signal?.aborted) throw err;
    throw new LlmError(`LLM request failed: ${err?.message ?? err}`);
  }
  const raw = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new LlmError(`LLM HTTP ${res.status}: ${raw.slice(0, 400)}`, res.status, retryable);
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LlmError('LLM returned non-JSON response');
  }
  const text: string = data?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new LlmError('LLM returned an empty response');
  if (/Free-plan credits can't be used/i.test(text)) {
    throw new LlmError('LLM provider rejected the request: account plan does not allow API usage', 402, false);
  }
  const inputTokens = data?.usage?.prompt_tokens ?? 0;
  const outputTokens = data?.usage?.completion_tokens ?? 0;
  const costUsd = (inputTokens / 1e6) * e.LLM_INPUT_USD_PER_1M + (outputTokens / 1e6) * e.LLM_OUTPUT_USD_PER_1M;
  return { text, inputTokens, outputTokens, costUsd, model };
}

/** Extract and parse the first JSON object from a model response. */
export function parseJsonLoose<T = unknown>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t) as T;
  } catch {
    const s = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (s >= 0 && end > s) return JSON.parse(t.slice(s, end + 1)) as T;
    throw new Error('Model response did not contain valid JSON');
  }
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Whisper-compatible transcription (optional). Returns null if STT not configured. */
export async function transcribe(
  filePath: string,
  fileBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ segments: TranscriptSegment[]; language?: string } | null> {
  const e = env();
  const key = e.STT_API_KEY;
  const base = e.STT_BASE_URL;
  if (!key || !base) return null;
  const form = new FormData();
  form.append('file', new Blob([fileBytes as unknown as BlobPart], { type: 'audio/mpeg' }), filePath.split('/').pop() || 'audio.mp3');
  form.append('model', e.STT_MODEL);
  form.append('response_format', 'verbose_json');
  const res = await fetch(`${base.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new LlmError(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
  const data: any = await res.json();
  const segments: TranscriptSegment[] = (data.segments ?? []).map((s: any) => ({
    start: Number(s.start),
    end: Number(s.end),
    text: String(s.text ?? '').trim(),
  }));
  return { segments, language: data.language };
}

/** Whisper-compatible transcription with a registry model. */
export async function transcribeWith(
  m: { modelId: string; provider: { baseUrl: string; apiKey: string | null; name: string; kind?: string } },
  fileName: string,
  fileBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ segments: TranscriptSegment[]; language?: string }> {
  if (m.provider.kind === 'GEMINI') return geminiTranscribe(m, fileBytes, signal);
  const form = new FormData();
  form.append('file', new Blob([fileBytes as unknown as BlobPart], { type: 'audio/mpeg' }), fileName);
  form.append('model', m.modelId);
  form.append('response_format', 'verbose_json');
  const res = await fetch(`${m.provider.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: m.provider.apiKey ? { Authorization: `Bearer ${m.provider.apiKey}` } : {},
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new LlmError(`${m.provider.name} STT HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
  const data: any = await res.json();
  return {
    segments: (data.segments ?? []).map((s: any) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text ?? '').trim() })),
    language: data.language,
  };
}

/** Gemini audio understanding as speech-to-text: returns timestamped segments (JSON). */
async function geminiTranscribe(
  m: { modelId: string; provider: { baseUrl: string; apiKey: string | null; name: string } },
  fileBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<{ segments: TranscriptSegment[]; language?: string }> {
  if (!m.provider.apiKey) throw new LlmError(`${m.provider.name}: API key is not set`, undefined, false);
  if (fileBytes.length > 19 * 1024 * 1024) throw new LlmError('Audio too large for inline Gemini transcription', undefined, false);
  const base = (m.provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '').replace(/\/openai$/, '');
  const res = await fetch(`${base}/models/${encodeURIComponent(m.modelId)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': m.provider.apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'audio/mpeg', data: Buffer.from(fileBytes).toString('base64') } },
            {
              text: 'Transcribe the spoken dialogue in this audio in its original language. Ignore music and sound effects. Return JSON only: {"language":"<ISO code>","segments":[{"start":<seconds>,"end":<seconds>,"text":"..."}]} with one segment per sentence or line of dialogue, in order. If there is no speech return {"segments":[]}.',
            },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new LlmError(`${m.provider.name} STT HTTP ${res.status}: ${raw.slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
  const data = JSON.parse(raw);
  const text: string = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  const parsed = parseJsonLoose<{ language?: string; segments?: Array<{ start: unknown; end: unknown; text: unknown }> }>(text || '{}');
  const num = (v: unknown) => {
    if (typeof v === 'number') return v;
    const s = String(v ?? '0');
    if (s.includes(':')) return s.split(':').reduce((a, x) => a * 60 + Number(x), 0);
    return Number(s) || 0;
  };
  return {
    language: parsed.language,
    segments: (parsed.segments ?? []).map((s) => ({ start: num(s.start), end: num(s.end), text: String(s.text ?? '').trim() })).filter((s) => s.text),
  };
}
