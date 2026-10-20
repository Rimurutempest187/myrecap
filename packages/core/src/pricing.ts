import { env } from './env.js';

/**
 * Credit pricing. 1 credit ≈ fixed internal unit. Costs are estimated up-front, reserved,
 * and unused credits are released when the job finishes. Failed/cancelled jobs release everything.
 */
export const CREDIT_RULES = {
  analyzePerSourceMinute: 1,
  analyzeMin: 2,
  analyzeMax: 40,
  voicePerChars: 400, // 1 credit per 400 chars of narration
  voiceMin: 1,
  renderPerOutputMinute: 3,
  renderMin: 2,
} as const;

export function estimateAnalyzeCredits(sourceDurationSec: number) {
  const mins = Math.ceil(sourceDurationSec / 60);
  return Math.min(CREDIT_RULES.analyzeMax, Math.max(CREDIT_RULES.analyzeMin, mins * CREDIT_RULES.analyzePerSourceMinute));
}

export function estimateVoiceCredits(totalChars: number) {
  return Math.max(CREDIT_RULES.voiceMin, Math.ceil(totalChars / CREDIT_RULES.voicePerChars));
}

export function estimateRenderCredits(outputDurationSec: number) {
  return Math.max(CREDIT_RULES.renderMin, Math.ceil((outputDurationSec / 60) * CREDIT_RULES.renderPerOutputMinute));
}

/** Rough provider cost (USD) estimates for admin margin tracking & user transparency. */
export function estimateAnalyzeUsd(sourceDurationSec: number) {
  const e = env();
  const frames = Math.min(e.ANALYSIS_MAX_FRAMES, Math.max(8, Math.ceil(sourceDurationSec / 20)));
  const calls = Math.ceil(frames / e.ANALYSIS_FRAMES_PER_CALL) + 1;
  const inTok = frames * 900 + calls * 1500;
  const outTok = calls * 1500 + 3000;
  const stt = e.STT_API_KEY || e.STT_BASE_URL ? (Math.min(sourceDurationSec, 3600) / 60) * e.STT_USD_PER_MIN : 0;
  return (inTok / 1e6) * e.LLM_INPUT_USD_PER_1M + (outTok / 1e6) * e.LLM_OUTPUT_USD_PER_1M + stt;
}

export function estimateVoiceUsd(totalChars: number) {
  return (totalChars / 1e6) * env().TTS_USD_PER_1M_CHARS * 1.15; // SSML overhead
}

export function estimateRenderUsd(outputDurationSec: number) {
  return (outputDurationSec / 60) * env().RENDER_USD_PER_MIN;
}
