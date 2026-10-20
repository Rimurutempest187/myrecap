/**
 * Myanmar subtitle utilities: sentence/phrase chunking, syllable-safe line breaking,
 * timeline computation and ASS/SRT generation.
 */

export interface TimelineSegment {
  idx: number;
  start: number; // output timeline start (sec)
  duration: number; // slot duration (sec)
  audioDuration: number;
}

export const SEGMENT_PAD_SEC = 0.35;
export const SEGMENT_MIN_SEC = 2.0;

export function computeTimeline(segs: Array<{ idx: number; audioDurationSec: number | null }>): TimelineSegment[] {
  let t = 0;
  return segs
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((s) => {
      const audio = s.audioDurationSec ?? 0;
      const duration = Math.round(Math.max(audio + SEGMENT_PAD_SEC, SEGMENT_MIN_SEC) * 1000) / 1000;
      const out = { idx: s.idx, start: Math.round(t * 1000) / 1000, duration, audioDuration: audio };
      t += duration;
      return out;
    });
}

const MY_CONSONANT = /[\u1000-\u102A\u103F\u104C-\u104F]/;

/**
 * Split Myanmar text into syllables. A new syllable begins at a consonant/independent vowel,
 * unless it is followed by asat (U+103A) or stacked (preceded by virama U+1039).
 */
export function myanmarSyllables(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    const prev = chars[i - 1];
    const startsNew =
      cur.length > 0 &&
      (MY_CONSONANT.test(c) || /[\s,.!?။၊\u0021-\u002F]/.test(c) || /[A-Za-z0-9]/.test(c) !== /[A-Za-z0-9]/.test(prev ?? '')) &&
      next !== '\u103A' &&
      next !== '\u1039' &&
      prev !== '\u1039';
    if (startsNew) {
      out.push(cur);
      cur = c;
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Visible length approximation (combining marks don't take width). */
export function visualLength(s: string): number {
  return Array.from(s).filter((c) => !/[\u102B-\u103E\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F\u109A-\u109D]/.test(c)).length;
}

/** Break a narration into subtitle-sized chunks (≤ maxLen visual chars), preferring punctuation then spaces then syllables. */
export function chunkNarration(text: string, maxLen = 32): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  // 1) sentences / phrases
  const phrases = clean
    .split(/(?<=[။၊!?.,])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  for (const ph of phrases) {
    if (visualLength(ph) <= maxLen) {
      chunks.push(ph);
      continue;
    }
    // 2) split on spaces, 3) on syllables — keep track of whether a space precedes each unit
    const units: Array<{ text: string; space: boolean }> = [];
    ph.split(' ').forEach((w, wi) => {
      if (visualLength(w) <= maxLen) units.push({ text: w, space: wi > 0 });
      else myanmarSyllables(w).forEach((syl, si) => units.push({ text: syl, space: wi > 0 && si === 0 }));
    });
    let cur = '';
    for (const u of units) {
      const cand = cur ? cur + (u.space ? ' ' : '') + u.text : u.text;
      if (visualLength(cand) > maxLen && cur) {
        chunks.push(cur.trim());
        cur = u.text;
      } else cur = cand;
    }
    if (cur.trim()) chunks.push(cur.trim());
  }
  // merge tiny trailing fragments
  const merged: string[] = [];
  for (const c of chunks) {
    const last = merged[merged.length - 1];
    if (last && visualLength(c) <= 4 && visualLength(last) + visualLength(c) <= maxLen + 6) merged[merged.length - 1] = `${last} ${c}`;
    else merged.push(c);
  }
  return merged;
}

export interface SubtitleCue {
  idx: number;
  segmentIdx: number;
  startSec: number;
  endSec: number;
  text: string;
}

/** Distribute chunks across the voice audio duration proportionally to their visual length. */
export function buildCues(
  segments: Array<{ idx: number; narration: string }>,
  timeline: TimelineSegment[],
  maxLen = 32,
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const tl = new Map(timeline.map((t) => [t.idx, t]));
  for (const seg of segments.slice().sort((a, b) => a.idx - b.idx)) {
    const t = tl.get(seg.idx);
    if (!t) continue;
    const chunks = chunkNarration(seg.narration, maxLen);
    const total = chunks.reduce((a, c) => a + Math.max(1, visualLength(c)), 0);
    const span = t.audioDuration > 0 ? t.audioDuration : t.duration;
    let cursor = t.start + 0.05;
    for (const c of chunks) {
      const d = (Math.max(1, visualLength(c)) / total) * span;
      cues.push({
        idx: cues.length,
        segmentIdx: seg.idx,
        startSec: round3(cursor),
        endSec: round3(Math.min(cursor + d, t.start + t.duration - 0.02)),
        text: c,
      });
      cursor += d;
    }
  }
  return cues;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function assTime(sec: number) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const ss = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(Math.min(cs, 99)).padStart(2, '0')}`;
}

function srtTime(sec: number) {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export interface SubtitleStyle {
  fontSize?: number; // relative to 1080 short side
  primaryColor?: string; // #RRGGBB
  outlineColor?: string;
  boxed?: boolean;
  position?: 'bottom' | 'middle' | 'top';
}

function assColor(hex: string, alpha = 0) {
  const h = hex.replace('#', '');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}

export function escapeAss(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

export function buildAss(
  cues: Array<{ startSec: number; endSec: number; text: string }>,
  opts: { width: number; height: number; font: string; style?: SubtitleStyle; watermark?: string; durationSec?: number },
) {
  const st = opts.style ?? {};
  const short = Math.min(opts.width, opts.height);
  const fontSize = Math.round(((st.fontSize ?? 58) * short) / 1080);
  const align = st.position === 'top' ? 8 : st.position === 'middle' ? 5 : 2;
  const marginV = Math.round((st.position === 'middle' ? 0 : opts.height > opts.width ? 0.16 : 0.07) * opts.height);
  const primary = assColor(st.primaryColor ?? '#FFFFFF');
  const outline = assColor(st.outlineColor ?? '#000000');
  const boxed = st.boxed ?? false;
  const borderStyle = boxed ? 3 : 1;
  const back = boxed ? assColor('#000000', 0x60) : assColor('#000000', 0x80);
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${opts.font},${fontSize},${primary},${primary},${outline},${back},1,0,0,0,100,100,0,0,${borderStyle},${Math.max(
      2,
      Math.round(fontSize / 14),
    )},${boxed ? 0 : 1},${align},${Math.round(opts.width * 0.06)},${Math.round(opts.width * 0.06)},${marginV},1`,
    `Style: Watermark,${opts.font},${Math.round(fontSize * 0.55)},&H60FFFFFF,&H60FFFFFF,&H80000000,&H00000000,1,0,0,0,100,100,0,0,1,1,0,9,${Math.round(
      opts.width * 0.03,
    )},${Math.round(opts.width * 0.03)},${Math.round(opts.height * 0.03)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of cues) {
    if (c.endSec <= c.startSec || !c.text.trim()) continue;
    lines.push(`Dialogue: 0,${assTime(c.startSec)},${assTime(c.endSec)},Default,,0,0,0,,${escapeAss(c.text.trim())}`);
  }
  if (opts.watermark && opts.durationSec) {
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(opts.durationSec + 1)},Watermark,,0,0,0,,${escapeAss(opts.watermark)}`);
  }
  return lines.join('\n') + '\n';
}

export function buildSrt(cues: Array<{ startSec: number; endSec: number; text: string }>) {
  return cues
    .filter((c) => c.endSec > c.startSec && c.text.trim())
    .map((c, i) => `${i + 1}\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\n${c.text.trim()}\n`)
    .join('\n');
}
