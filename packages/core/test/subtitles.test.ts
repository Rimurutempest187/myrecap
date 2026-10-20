import { describe, it, expect } from 'vitest';
import { chunkNarration, myanmarSyllables, visualLength, computeTimeline, buildCues, buildAss, buildSrt, escapeAss } from '../src/subtitles.js';

describe('Myanmar subtitle utilities', () => {
  it('splits Myanmar syllables without breaking stacked/asat clusters', () => {
    const syl = myanmarSyllables('မင်္ဂလာပါ');
    expect(syl.join('')).toBe('မင်္ဂလာပါ');
    expect(syl).toContain('လာ');
    expect(syl.every((s) => !s.startsWith('\u103A') && !s.startsWith('\u1039'))).toBe(true);
  });

  it('computes visual length ignoring combining marks', () => {
    expect(visualLength('ကို')).toBe(1);
    expect(visualLength('abc')).toBe(3);
  });

  it('chunks narration at punctuation and keeps every chunk within limit', () => {
    const text = 'ဒီဗီဒီယိုမှာ အရမ်းစိတ်လှုပ်ရှားစရာကောင်းတဲ့ ဇာတ်လမ်းတစ်ခုကို ပြောပြပေးသွားမှာ ဖြစ်ပါတယ်။ နောက်ဆုံးမှာတော့ သူဟာ အမှန်တရားကို ရှာဖွေတွေ့ရှိသွားပါတော့တယ်။';
    const chunks = chunkNarration(text, 24);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(visualLength(c)).toBeLessThanOrEqual(30);
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('builds a contiguous timeline with padding and minimum slot', () => {
    const tl = computeTimeline([{ idx: 1, audioDurationSec: 4 }, { idx: 0, audioDurationSec: 0.5 }]);
    expect(tl[0].idx).toBe(0);
    expect(tl[0].duration).toBe(2);
    expect(tl[1].start).toBe(2);
    expect(tl[1].duration).toBeCloseTo(4.35);
  });

  it('distributes cues inside each segment audio span', () => {
    const segs = [{ idx: 0, narration: 'ပထမစာကြောင်း။ ဒုတိယစာကြောင်း။' }, { idx: 1, narration: 'တတိယ။' }];
    const tl = computeTimeline([{ idx: 0, audioDurationSec: 3 }, { idx: 1, audioDurationSec: 1 }]);
    const cues = buildCues(segs, tl);
    expect(cues.length).toBe(3);
    for (let i = 1; i < cues.length; i++) expect(cues[i].startSec).toBeGreaterThanOrEqual(cues[i - 1].endSec - 0.001);
    expect(cues[2].startSec).toBeGreaterThanOrEqual(tl[1].start);
  });

  it('generates valid ASS and SRT', () => {
    const cues = [{ startSec: 0.5, endSec: 2.25, text: 'မြန်မာ {test}' }];
    const ass = buildAss(cues, { width: 1080, height: 1920, font: 'Noto Sans Myanmar', watermark: 'RecapAI', durationSec: 3 });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('Dialogue: 0,0:00:00.50,0:00:02.25,Default');
    expect(ass).toContain('\\{test\\}');
    expect(ass).toContain('Watermark');
    expect(buildSrt(cues)).toContain('00:00:00,500 --> 00:00:02,250');
    expect(escapeAss('a\nb')).toBe('a\\Nb');
  });
});
