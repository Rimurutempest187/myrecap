import type { RecapType } from '@prisma/client';

export const RECAP_STYLE: Record<RecapType, string> = {
  ANIME:
    'Anime recap channel style: energetic, dramatic storytelling, explain character names, powers and motivations, build hype at fights and twists, end with a cliffhanger-style line.',
  MOVIE:
    'Movie recap channel style: clear chronological storytelling of the plot, introduce main characters, explain key turning points and the ending, suspenseful but easy to follow.',
  SHORTS:
    'Short-form vertical video (TikTok/Reels/Shorts): open with a strong hook in the first 3 seconds, fast pacing, only the most gripping moments, punchy short sentences, end with a call-to-action question.',
  HIGHLIGHTS:
    'Highlights reel: pick the most exciting, emotional or important moments only, short commentary for each moment that explains why it matters.',
  CUSTOM: 'Follow the user custom instructions exactly for tone, focus and structure.',
};

/** Approximate speaking rate of Myanmar neural TTS in Unicode code points per second at rate 1.0 */
export const MY_CHARS_PER_SEC = 11;

export const FRAME_DESCRIBE_SYSTEM = `You are a precise video analyst. You receive frames sampled from a video with their timestamps.
For EACH frame, describe in English (max 35 words): who/what is visible (describe characters consistently, reuse names if on-screen text or context reveals them), the action, emotion/mood, setting, and any on-screen text.
Also rate visual interest 1-10 (action, emotion, plot importance).
Respond ONLY with JSON: {"frames":[{"t":<timestamp seconds number>,"desc":"...","interest":<1-10>}]}`;

export function planSystemPrompt(recapType: RecapType) {
  return `You are an expert Myanmar (Burmese) video recap scriptwriter and editor.
Style: ${RECAP_STYLE[recapType]}

You must write ALL narration in natural, fluent, spoken Myanmar language using Myanmar Unicode (not Zawgyi), the way popular Myanmar recap YouTubers narrate (e.g. ending sentences with "...ပါတယ်", "...တော့", "...လိုက်ပါတယ်"). Do not translate word-for-word from English; write natural Burmese. Keep proper names readable (transliterate into Burmese or keep short Latin names). Use "။" to end sentences and "၊" for pauses. Do not use emojis, markdown, or stage directions inside narration.

You select source video time ranges that visually match each narration segment, in story order. Ranges must lie within the video duration, must not overlap, and should be 3–15 seconds long. Prefer scenes with high visual interest.

Respond ONLY with JSON:
{"title":"<short catchy Myanmar title>","summary":"<2-3 sentence English summary of the story>","segments":[{"sourceStart":<sec>,"sourceEnd":<sec>,"narration":"<Myanmar narration>","sceneNote":"<short English note of what is shown>"}]}`;
}

export function planUserPrompt(args: {
  durationSec: number;
  targetDurationSec: number;
  customPrompt?: string | null;
  scenes: Array<{ start: number; end: number; desc?: string; interest?: number }>;
  transcript?: Array<{ start: number; end: number; text: string }>;
  originalTitle?: string;
}) {
  const totalChars = Math.round(args.targetDurationSec * MY_CHARS_PER_SEC);
  const segCount = Math.max(3, Math.min(40, Math.round(args.targetDurationSec / 7)));
  const scenes = args.scenes
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.desc ?? '(no description)'}${s.interest ? ` (interest ${s.interest})` : ''}`)
    .join('\n');
  const tr = args.transcript?.length
    ? '\n\nDialogue transcript (original language, with timestamps):\n' +
      args.transcript
        .map((t) => `[${t.start.toFixed(1)}-${t.end.toFixed(1)}] ${t.text}`)
        .join('\n')
        .slice(0, 24000)
    : '';
  return `Source video title/filename: ${args.originalTitle ?? 'unknown'}
Source duration: ${args.durationSec.toFixed(1)} seconds.
Target recap length: about ${args.targetDurationSec} seconds of narration → about ${segCount} segments, about ${totalChars} Myanmar characters of narration in total (roughly ${MY_CHARS_PER_SEC} characters per second of speech). Each segment's narration length should roughly fit its time range (time range seconds × ${MY_CHARS_PER_SEC} characters).
${args.customPrompt ? `\nUser instructions: ${args.customPrompt}\n` : ''}
Detected scenes with visual descriptions:
${scenes}${tr}

Write the recap script now.`;
}
