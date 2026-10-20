/** Pure helpers for turning scene cuts into analysis windows and sampling frames. */
export interface Scene {
  start: number;
  end: number;
}

/** Build scenes from cut times; merge too-short scenes and split too-long ones. */
export function buildScenes(cuts: number[], duration: number, minLen = 2.5, maxLen = 20): Scene[] {
  const pts = [0, ...cuts.filter((t) => t > 0.5 && t < duration - 0.5).sort((a, b) => a - b), duration];
  let scenes: Scene[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    if (pts[i + 1] - pts[i] > 0.05) scenes.push({ start: pts[i], end: pts[i + 1] });
  }
  // merge short
  const merged: Scene[] = [];
  for (const s of scenes) {
    const last = merged[merged.length - 1];
    if (last && (s.end - s.start < minLen || last.end - last.start < minLen)) last.end = s.end;
    else merged.push({ ...s });
  }
  // split long
  scenes = [];
  for (const s of merged) {
    const len = s.end - s.start;
    if (len <= maxLen) scenes.push(s);
    else {
      const n = Math.ceil(len / maxLen);
      for (let k = 0; k < n; k++) scenes.push({ start: s.start + (len * k) / n, end: s.start + (len * (k + 1)) / n });
    }
  }
  return scenes.map((s) => ({ start: round2(s.start), end: round2(s.end) }));
}

/** Choose up to maxFrames scenes spread evenly over the timeline (keeps temporal coverage). */
export function pickScenesForFrames(scenes: Scene[], maxFrames: number): Array<Scene & { t: number; i: number }> {
  const withIdx = scenes.map((s, i) => ({ ...s, i, t: round2(s.start + (s.end - s.start) / 2) }));
  if (withIdx.length <= maxFrames) return withIdx;
  const out: Array<Scene & { t: number; i: number }> = [];
  for (let k = 0; k < maxFrames; k++) out.push(withIdx[Math.floor((k * withIdx.length) / maxFrames)]);
  return out;
}

export interface PlannedSegment {
  sourceStart: number;
  sourceEnd: number;
  narration: string;
  sceneNote?: string;
}

/** Sanitize LLM output: clamp to duration, sort, remove overlaps/empties, enforce lengths. */
export function sanitizeSegments(raw: unknown, duration: number): PlannedSegment[] {
  if (!Array.isArray(raw)) return [];
  const segs: PlannedSegment[] = [];
  for (const r of raw as any[]) {
    const narration = typeof r?.narration === 'string' ? r.narration.replace(/\s+/g, ' ').trim() : '';
    let a = Number(r?.sourceStart);
    let b = Number(r?.sourceEnd);
    if (!narration || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (b < a) [a, b] = [b, a];
    a = Math.max(0, Math.min(a, duration - 1));
    b = Math.max(a + 1, Math.min(b, duration));
    if (b - a > 30) b = a + 30;
    segs.push({ sourceStart: round2(a), sourceEnd: round2(b), narration: narration.slice(0, 2000), sceneNote: typeof r?.sceneNote === 'string' ? r.sceneNote.slice(0, 300) : undefined });
  }
  return segs.slice(0, 120);
}

/** Reject scripts that are not actually Myanmar. Returns ratio of Myanmar letters among letters. */
export function myanmarRatio(text: string) {
  const letters = Array.from(text).filter((c) => /\p{L}|\p{M}/u.test(c));
  if (!letters.length) return 0;
  const my = letters.filter((c) => /[\u1000-\u109F\uAA60-\uAA7F\uA9E0-\uA9FF]/.test(c)).length;
  return my / letters.length;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
