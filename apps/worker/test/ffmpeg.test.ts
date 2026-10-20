/** Real FFmpeg integration: builds a tiny source, renders clips → xfade → mix with Myanmar ASS subtitles. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATABASE_URL ||= 'postgresql://x';
process.env.SESSION_SECRET ||= 'x'.repeat(40);

const core = await import('@recap/core');
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'recap-test-'));
  await core.ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=4',
    '-f', 'lavfi', '-i', 'smptebars=s=640x360:r=25:d=4',
    '-f', 'lavfi', '-i', 'sine=f=300:d=8',
    '-filter_complex', '[0][1]concat=n=2:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(dir, 'src.mp4'),
  ]);
  await core.ffmpeg(['-f', 'lavfi', '-i', 'sine=f=800:d=1.5', '-c:a', 'libmp3lame', path.join(dir, 'v0.mp3')]);
  await core.ffmpeg(['-f', 'lavfi', '-i', 'sine=f=600:d=1.2', '-c:a', 'libmp3lame', path.join(dir, 'v1.mp3')]);
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('ffmpeg pipeline', () => {
  it('probes and detects the scene cut', async () => {
    const info = await core.probe(path.join(dir, 'src.mp4'));
    expect(info.durationSec).toBeGreaterThan(7.5);
    expect(info.hasAudio).toBe(true);
    const cuts = await core.detectScenesFull(path.join(dir, 'src.mp4'), 0.3, info.durationSec);
    expect(cuts.some((c) => Math.abs(c - 4) < 0.5)).toBe(true);
  });

  it('renders a 9:16 recap with transitions, voice mix and Myanmar subtitles', async () => {
    const src = path.join(dir, 'src.mp4');
    const info = await core.probe(src);
    const v = [path.join(dir, 'v0.mp3'), path.join(dir, 'v1.mp3')];
    const durs = await Promise.all(v.map((f) => core.audioDuration(f)));
    const timeline = core.computeTimeline(durs.map((d, idx) => ({ idx, audioDurationSec: d })));
    const slots = timeline.map((t) => t.duration);
    const lengths = core.clipLengths(slots, 'fade');
    const { width, height } = core.outputSize('R9_16', 480);
    const clips: string[] = [];
    for (const [i, start] of [0.5, 5].entries()) {
      const out = path.join(dir, `c${i}.mp4`);
      await core.ffmpeg(core.clipArgs({ input: src, output: out, start, length: lengths[i], sourceDuration: info.durationSec, width, height, fps: 25, fitMode: 'blur', includeAudio: true, preset: 'ultrafast', threads: 0 }));
      clips.push(out);
    }
    const g = core.xfadeGraph(slots, 'fade');
    const joined = path.join(dir, 'joined.mp4');
    await core.ffmpeg([...clips.flatMap((c) => ['-i', c]), '-filter_complex', g.filter, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', joined]);
    const segs = [{ idx: 0, narration: 'ပထမပိုင်း။' }, { idx: 1, narration: 'ဒုတိယပိုင်း။' }];
    const ass = path.join(dir, 's.ass');
    await writeFile(ass, core.buildAss(core.buildCues(segs, timeline), { width, height, font: 'Noto Sans Myanmar', watermark: 'RecapAI', durationSec: g.total }));
    const out = path.join(dir, 'out.mp4');
    let lastProgress = 0;
    await core.ffmpeg(
      core.finalMixArgs({ videoTrack: joined, voiceFiles: v.map((file, i) => ({ file, startSec: timeline[i].start })), music: null, originalVolume: 0.1, totalDuration: g.total, assFile: ass, fontsDir: '/usr/share/fonts', output: out, preset: 'ultrafast', threads: 0 }),
      { totalDurationSec: g.total, onProgress: (f) => (lastProgress = f) },
    );
    const o = await core.probe(out);
    expect(o.width).toBe(width);
    expect(o.height).toBe(height);
    expect(o.hasAudio).toBe(true);
    expect(Math.abs(o.durationSec - g.total)).toBeLessThan(0.6);
    expect(lastProgress).toBeGreaterThan(0.5);
  });
});
