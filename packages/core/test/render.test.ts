import { describe, it, expect } from 'vitest';
import { outputSize, clampWindow, clipLengths, xfadeGraph, finalMixArgs, escapeFilterPath, clipArgs } from '../src/media/render.js';

describe('render graph builder', () => {
  it('produces even output sizes per aspect ratio and plan cap', () => {
    expect(outputSize('R9_16', 1080)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize('R16_9', 1080)).toEqual({ width: 1920, height: 1080 });
    expect(outputSize('R1_1', 1080)).toEqual({ width: 1080, height: 1080 });
    expect(outputSize('R9_16', 720)).toEqual({ width: 720, height: 1280 });
    const s = outputSize('R16_9', 480);
    expect(s.width % 2).toBe(0);
  });

  it('clamps clip windows inside the source', () => {
    expect(clampWindow(95, 10, 100).start).toBeCloseTo(89.95);
    expect(clampWindow(-5, 10, 100).start).toBe(0);
    expect(clampWindow(0, 20, 8).needsPad).toBe(true);
  });

  it('builds xfade offsets equal to cumulative slot durations', () => {
    const slots = [3, 4, 5];
    expect(clipLengths(slots, 'fade', 0.5)).toEqual([3.5, 4.5, 5]);
    expect(clipLengths(slots, 'none', 0.5)).toEqual([3, 4, 5]);
    const g = xfadeGraph(slots, 'fade', 0.5);
    expect(g.total).toBe(12);
    expect(g.filter).toContain('offset=3.000');
    expect(g.filter).toContain('offset=7.000');
    expect(g.filter).toContain('[vout]');
    expect(g.filter).toContain('[aout]');
  });

  it('mixes voice segments with delays, music, subtitles and faststart', () => {
    const args = finalMixArgs({
      videoTrack: '/t/joined.mp4',
      voiceFiles: [{ file: '/t/v0.mp3', startSec: 0.05 }, { file: '/t/v1.mp3', startSec: 4.2 }],
      music: { file: '/t/m.mp3', volume: 0.15 },
      originalVolume: 0.1,
      totalDuration: 9,
      assFile: '/t/subs.ass',
      fontsDir: '/usr/share/fonts',
      output: '/t/out.mp4',
      preset: 'veryfast',
      threads: 0,
    });
    const fc = args[args.indexOf('-filter_complex') + 1];
    expect(fc).toContain('adelay=4200|4200');
    expect(fc).toContain('amix=inputs=3');
    expect(fc).toContain('subtitles=filename=/t/subs.ass');
    expect(args).toContain('+faststart');
    expect(args).toContain('-stream_loop');
  });

  it('escapes filter paths', () => {
    expect(escapeFilterPath("/a:b/c'd,e")).toBe("/a\\:b/c\\'d\\,e");
  });

  it('clip args use blur fill and silent audio when the source has no audio', () => {
    const a = clipArgs({ input: 'in', output: 'out', start: 1, length: 4, sourceDuration: 60, width: 720, height: 1280, fps: 30, fitMode: 'blur', includeAudio: false, preset: 'veryfast', threads: 0 });
    const fc = a[a.indexOf('-filter_complex') + 1];
    expect(fc).toContain('boxblur');
    expect(fc).toContain('anullsrc');
  });
});
