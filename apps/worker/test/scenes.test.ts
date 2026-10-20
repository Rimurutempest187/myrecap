import { describe, it, expect } from 'vitest';
import { buildScenes, pickScenesForFrames, sanitizeSegments, myanmarRatio } from '../src/processors/scenes.js';

describe('scene helpers', () => {
  it('merges short scenes and splits long ones', () => {
    const s = buildScenes([1, 1.5, 10, 50], 60, 2.5, 20);
    expect(s[0].start).toBe(0);
    expect(s[s.length - 1].end).toBe(60);
    for (const x of s) {
      expect(x.end - x.start).toBeLessThanOrEqual(20.01);
    }
    for (let i = 1; i < s.length; i++) expect(s[i].start).toBeCloseTo(s[i - 1].end);
  });
  it('samples frames evenly across the timeline', () => {
    const scenes = Array.from({ length: 100 }, (_, i) => ({ start: i, end: i + 1 }));
    const p = pickScenesForFrames(scenes, 10);
    expect(p).toHaveLength(10);
    expect(p[0].i).toBe(0);
    expect(p[9].i).toBe(90);
  });
  it('sanitizes LLM segments (clamps, swaps, drops invalid)', () => {
    const out = sanitizeSegments(
      [
        { sourceStart: 50, sourceEnd: 40, narration: ' မင်္ဂလာပါ ' },
        { sourceStart: 'x', sourceEnd: 3, narration: 'bad' },
        { sourceStart: 95, sourceEnd: 500, narration: 'နောက်ဆုံး' },
        { sourceStart: 1, sourceEnd: 2, narration: '' },
      ],
      100,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ sourceStart: 40, sourceEnd: 50, narration: 'မင်္ဂလာပါ' });
    expect(out[1].sourceEnd).toBeLessThanOrEqual(100);
  });
  it('detects Myanmar script ratio', () => {
    expect(myanmarRatio('မြန်မာစာ')).toBeGreaterThan(0.95);
    expect(myanmarRatio('English only')).toBe(0);
  });
});
