/**
 * Provider adapters. Every chat-capable provider is exposed through one `chatWith()` call.
 * - OpenAI, Gemini (OpenAI-compatible endpoint), OpenRouter, DeepSeek, Groq, any OpenAI-compatible server → /chat/completions
 * - Anthropic → native Messages API
 */
import type { AiProviderKind } from '@prisma/client';
import type { ChatMessage, ChatResult } from './llm.js';
import { LlmError } from './llm.js';

export const PROVIDER_DEFAULTS: Record<AiProviderKind, { label: string; baseUrl?: string; capabilities: Array<'CHAT' | 'TTS_VOICE' | 'STT'>; keyRequired: boolean; docs: string }> = {
  OPENAI: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', capabilities: ['CHAT', 'STT', 'TTS_VOICE'], keyRequired: true, docs: 'https://platform.openai.com/api-keys' },
  GEMINI: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', capabilities: ['CHAT', 'TTS_VOICE', 'STT'], keyRequired: true, docs: 'https://aistudio.google.com/apikey' },
  ANTHROPIC: { label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', capabilities: ['CHAT'], keyRequired: true, docs: 'https://console.anthropic.com/settings/keys' },
  OPENROUTER: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', capabilities: ['CHAT'], keyRequired: true, docs: 'https://openrouter.ai/keys' },
  DEEPSEEK: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', capabilities: ['CHAT'], keyRequired: true, docs: 'https://platform.deepseek.com/api_keys' },
  GROQ: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', capabilities: ['CHAT', 'STT'], keyRequired: true, docs: 'https://console.groq.com/keys' },
  OPENAI_COMPATIBLE: { label: 'OpenAI-compatible (custom)', capabilities: ['CHAT', 'STT', 'TTS_VOICE'], keyRequired: false, docs: '' },
  AZURE_SPEECH: { label: 'Microsoft Azure AI Speech', capabilities: ['TTS_VOICE'], keyRequired: true, docs: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices' },
  ESPEAK: { label: 'eSpeak NG (local, development)', capabilities: ['TTS_VOICE'], keyRequired: false, docs: '' },
};

export interface ResolvedProvider {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  apiKey: string | null;
  region: string | null;
  config: Record<string, unknown>;
}

export interface ResolvedModel {
  id: string; // AiModel.id
  kind: 'CHAT' | 'TTS_VOICE' | 'STT';
  modelId: string; // vendor model / voice name
  displayName: string;
  supportsVision: boolean;
  jsonMode: boolean;
  maxOutputTokens: number | null;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  unitUsdPer1M: number;
  creditMultiplier: number;
  userSelectable: boolean;
  description: string | null;
  config: Record<string, unknown>;
  provider: ResolvedProvider;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** Google blocks the Gemini API in some countries (e.g. Myanmar). Turn that into an actionable message. */
export const GEMINI_LOCATION_HINT =
  'Gemini API is not available from this server\'s country (Google blocks e.g. Myanmar). Fix: run .\\windows\\run-tunnel.ps1 again - it creates a Cloudflare Worker relay in the US (Cloudflare token needs "Account | Workers Scripts | Edit"). On a VPS, use a server in a supported country.';
export function isGeminiLocationError(raw: string) {
  return /location is not supported|User location|FAILED_PRECONDITION.*location/i.test(raw);
}

function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function openAiCompatChat(m: ResolvedModel, messages: ChatMessage[], opts: ChatOpts): Promise<ChatResult> {
  const p = m.provider;
  const body: Record<string, unknown> = { model: m.modelId, messages };
  if (opts.json && m.jsonMode) body.response_format = { type: 'json_object' };
  const maxTok = opts.maxTokens ?? m.maxOutputTokens ?? undefined;
  if (maxTok) body[p.kind === 'OPENAI' || p.kind === 'OPENROUTER' ? 'max_completion_tokens' : 'max_tokens'] = maxTok;
  if (opts.temperature !== undefined && !/^(gpt-5|o\d)/.test(m.modelId)) body.temperature = opts.temperature;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
  if (p.kind === 'OPENROUTER') {
    headers['HTTP-Referer'] = String(p.config.referer ?? 'https://recapai.app');
    headers['X-Title'] = 'RecapAI';
  }
  let res: Response;
  try {
    res = await fetch(`${trimSlash(p.baseUrl)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: withTimeout(opts.signal, opts.timeoutMs) });
  } catch (err: any) {
    if (opts.signal?.aborted) throw err;
    throw new LlmError(`${p.name}: request failed (${err?.message ?? err})`);
  }
  const raw = await res.text();
  if (!res.ok) {
    if (isGeminiLocationError(raw)) throw new LlmError(`${p.name}: ${GEMINI_LOCATION_HINT}`, res.status, false);
    const retryable = res.status === 429 || res.status >= 500;
    throw new LlmError(`${p.name} HTTP ${res.status}: ${raw.slice(0, 300)}`, res.status, retryable);
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LlmError(`${p.name}: non-JSON response`);
  }
  const text: string = data?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new LlmError(`${p.name}: empty response (finish_reason=${data?.choices?.[0]?.finish_reason ?? 'unknown'})`);
  if (/Free-plan credits can't be used/i.test(text)) throw new LlmError(`${p.name}: account plan does not allow API usage`, 402, false);
  const inputTokens = data?.usage?.prompt_tokens ?? 0;
  const outputTokens = data?.usage?.completion_tokens ?? 0;
  return { text, inputTokens, outputTokens, costUsd: cost(m, inputTokens, outputTokens), model: m.modelId };
}

async function anthropicChat(m: ResolvedModel, messages: ChatMessage[], opts: ChatOpts): Promise<ChatResult> {
  const p = m.provider;
  const system = messages.filter((x) => x.role === 'system').map((x) => (typeof x.content === 'string' ? x.content : x.content.map((c) => ('text' in c ? c.text : '')).join('\n'))).join('\n\n');
  const conv = messages
    .filter((x) => x.role !== 'system')
    .map((x) => ({
      role: x.role,
      content:
        typeof x.content === 'string'
          ? [{ type: 'text', text: x.content }]
          : x.content.map((c) => {
              if (c.type === 'text') return { type: 'text', text: c.text };
              const mm = c.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
              if (!mm) return { type: 'image', source: { type: 'url', url: c.image_url.url } };
              return { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } };
            }),
    }));
  const sys = opts.json ? `${system}\n\nRespond with a single valid JSON object only, no prose, no code fences.` : system;
  let res: Response;
  try {
    res = await fetch(`${trimSlash(p.baseUrl)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': p.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: m.modelId, system: sys, messages: conv, max_tokens: opts.maxTokens ?? m.maxOutputTokens ?? 8000 }),
      signal: withTimeout(opts.signal, opts.timeoutMs),
    });
  } catch (err: any) {
    if (opts.signal?.aborted) throw err;
    throw new LlmError(`${p.name}: request failed (${err?.message ?? err})`);
  }
  const raw = await res.text();
  if (!res.ok) throw new LlmError(`${p.name} HTTP ${res.status}: ${raw.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500 || res.status === 529);
  const data = JSON.parse(raw);
  const text = (data.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  if (!text) throw new LlmError(`${p.name}: empty response`);
  const inputTokens = data?.usage?.input_tokens ?? 0;
  const outputTokens = data?.usage?.output_tokens ?? 0;
  return { text, inputTokens, outputTokens, costUsd: cost(m, inputTokens, outputTokens), model: m.modelId };
}

function cost(m: ResolvedModel, inTok: number, outTok: number) {
  return (inTok / 1e6) * m.inputUsdPer1M + (outTok / 1e6) * m.outputUsdPer1M;
}

export interface ChatOpts {
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

export async function chatWith(m: ResolvedModel, messages: ChatMessage[], opts: ChatOpts): Promise<ChatResult> {
  if (m.kind !== 'CHAT') throw new LlmError(`${m.displayName} is not a chat model`, undefined, false);
  if (PROVIDER_DEFAULTS[m.provider.kind].keyRequired && !m.provider.apiKey) throw new LlmError(`${m.provider.name}: API key is not set`, undefined, false);
  if (m.provider.kind === 'ANTHROPIC') return anthropicChat(m, messages, opts);
  return openAiCompatChat(m, messages, opts);
}

/** List model IDs available on a provider (used by the admin "Discover" button). */
export async function discoverModels(p: ResolvedProvider): Promise<Array<{ id: string; kind: 'CHAT' | 'TTS_VOICE' | 'STT'; label?: string }>> {
  if (p.kind === 'ESPEAK') return [{ id: 'my', kind: 'TTS_VOICE', label: 'eSpeak NG Burmese' }];
  if (p.kind === 'AZURE_SPEECH') {
    const res = await fetch(`https://${p.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
      headers: { 'Ocp-Apim-Subscription-Key': p.apiKey ?? '' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Azure HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const list = (await res.json()) as Array<{ ShortName: string; LocalName?: string; Gender?: string; Locale: string }>;
    return list.filter((v) => v.Locale === 'my-MM').map((v) => ({ id: v.ShortName, kind: 'TTS_VOICE' as const, label: `${v.LocalName ?? v.ShortName} (${v.Gender ?? ''})` }));
  }
  const headers: Record<string, string> = {};
  if (p.kind === 'ANTHROPIC') {
    headers['x-api-key'] = p.apiKey ?? '';
    headers['anthropic-version'] = '2023-06-01';
  } else if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
  const res = await fetch(`${trimSlash(p.baseUrl)}/models`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const raw = await res.text();
    if (isGeminiLocationError(raw)) throw new Error(GEMINI_LOCATION_HINT);
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }
  const data: any = await res.json();
  const ids: string[] = (data.data ?? data.models ?? []).map((x: any) => String(x.id ?? x.name ?? '').replace(/^models\//, '')).filter(Boolean);
  const NOT_CHAT = /embed|moderation|dall-e|image|davinci|babbage|realtime|search|banana|lyria|veo|imagen|robotics|computer-use|live|native-audio|aqa|antigravity|deep-research|omni|gemma-3n|learnlm/i;
  const out: Array<{ id: string; kind: 'CHAT' | 'TTS_VOICE' | 'STT'; label?: string }> = [];
  for (const id of ids) {
    if (/whisper|transcribe/i.test(id)) out.push({ id, kind: 'STT' });
    else if (/tts/i.test(id)) {
      if (p.kind === 'GEMINI') {
        // Gemini TTS: one entry per recommended Burmese-capable voice, as "model:voice".
        for (const v of ['Kore', 'Charon', 'Puck', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Sulafat']) out.push({ id: `${id}:${v}`, kind: 'TTS_VOICE', label: `${v} (${id})` });
      } else out.push({ id, kind: 'TTS_VOICE' });
    } else if (!NOT_CHAT.test(id)) out.push({ id, kind: 'CHAT' });
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}
