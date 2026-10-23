/**
 * Builds FFmpeg commands for the recap renderer.
 * Pipeline:
 *  1. For each script segment, cut a clip from the source (sourceStart..sourceStart+slot) and normalize
 *     it to target WxH/fps (blur-pad or crop), silent or with lowered original audio.
 *  2. Concatenate all clips with xfade transitions (or concat demuxer when transition = none).
 *  3. Mix voiceover track (each segment delayed to its timeline start), original audio (ducked), and optional music.
 *  4. Burn Myanmar subtitles (libass) and encode H.264/AAC MP4 with faststart.
 */
import type { AspectRatio } from '@prisma/client';

export const TRANSITIONS = ['none', 'fade', 'dissolve', 'slideleft', 'wipeleft', 'circleopen', 'smoothleft', 'fadeblack'] as const;
export type Transition = (typeof TRANSITIONS)[number];
export const TRANSITION_SEC = 0.5;

export function outputSize(ratio: AspectRatio, maxHeight = 1080): { width: number; height: number } {
  const even = (n: number) => Math.round(n / 2) * 2;
  switch (ratio) {
    case 'R9_16': {
      const h = Math.min(1920, Math.round((maxHeight * 16) / 9));
      return { width: even((h * 9) / 16), height: even(h) };
    }
    case 'R1_1': {
      const s = Math.min(1080, maxHeight);
      return { width: even(s), height: even(s) };
    }
    default: {
      const h = Math.min(1080, maxHeight);
      return { width: even((h * 16) / 9), height: even(h) };
    }
  }
}

export function fitFilter(width: number, height: number, fps: number, mode: 'blur' | 'crop') {
  if (mode === 'crop') {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p`;
  }
  // Blurred background fill + centered foreground
  return (
    `split=2[bg][fg];` +
    `[bg]scale=${Math.round(width / 4)}:${Math.round(height / 4)}:force_original_aspect_ratio=increase,crop=${Math.round(width / 4)}:${Math.round(
      height / 4,
    )},boxblur=10:2,scale=${width}:${height},setsar=1[bgb];` +
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease,setsar=1[fgs];` +
    `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,fps=${fps},format=yuv420p`
  );
}

export interface ClipSpec {
  index: number;
  sourceStart: number;
  /** clip length including transition overlap */
  length: number;
}

/**
 * Make sure each clip fits in the source: if the requested window runs past the end of the source, slide it back;
 * if the source is shorter than the window, loop is avoided by slowing via setpts (handled by caller with tpad).
 */
export function clampWindow(sourceStart: number, length: number, sourceDuration: number) {
  const maxStart = Math.max(0, sourceDuration - length - 0.05);
  const start = Math.max(0, Math.min(sourceStart, maxStart));
  const available = Math.max(0.1, sourceDuration - start);
  return { start, available, needsPad: available < length };
}

export function clipArgs(args: {
  input: string;
  output: string;
  start: number;
  length: number;
  sourceDuration: number;
  width: number;
  height: number;
  fps: number;
  fitMode: 'blur' | 'crop';
  includeAudio: boolean;
  preset: string;
  threads: number;
}): string[] {
  const w = clampWindow(args.start, args.length, args.sourceDuration);
  const pad = w.needsPad ? `,tpad=stop_mode=clone:stop_duration=${(args.length - w.available + 0.1).toFixed(3)}` : '';
  const vf = `[0:v]${fitFilter(args.width, args.height, args.fps, args.fitMode)}${pad},trim=duration=${args.length.toFixed(3)},setpts=PTS-STARTPTS[v]`;
  const af = args.includeAudio
    ? `;[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${args.length.toFixed(3)},asetpts=PTS-STARTPTS[a]`
    : `;anullsrc=r=48000:cl=stereo,atrim=duration=${args.length.toFixed(3)}[a]`;
  return [
    '-ss', w.start.toFixed(3),
    '-t', Math.min(w.available, args.length + 0.5).toFixed(3),
    '-i', args.input,
    '-filter_complex', vf + af,
    '-map', '[v]', '-map', '[a]',
    // Intermediate clip: fast near-lossless encode (only the final pass uses the quality preset).
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p',
    '-r', String(args.fps),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    ...(args.threads ? ['-threads', String(args.threads)] : []),
    '-video_track_timescale', '90000',
    args.output,
  ];
}

/**
 * Builds the xfade chain. Clip i has length L_i = slot_i + T (except the last, which is slot_i).
 * xfade offset for transition k (between merged stream and clip k) = sum(slot_0..slot_{k-1}) .
 * The result: clip k visually starts at timeline position sum(slot_0..slot_{k-1}) - T/2 approx; voice for segment k
 * starts at sum(slots before k), so the transition happens just before narration begins.
 */
export function xfadeGraph(slots: number[], transition: Transition, T = TRANSITION_SEC) {
  const n = slots.length;
  if (n === 1) return { filter: '[0:v]null[vout];[0:a]anull[aout]', total: slots[0] };
  const parts: string[] = [];
  let prevV = '[0:v]';
  let prevA = '[0:a]';
  let offset = 0;
  for (let k = 1; k < n; k++) {
    offset += slots[k - 1];
    const vo = k === n - 1 ? '[vout]' : `[v${k}]`;
    const ao = k === n - 1 ? '[aout]' : `[a${k}]`;
    parts.push(`${prevV}[${k}:v]xfade=transition=${transition}:duration=${T}:offset=${offset.toFixed(3)}${vo}`);
    parts.push(`${prevA}[${k}:a]acrossfade=d=${T}:c1=tri:c2=tri${ao}`);
    prevV = vo;
    prevA = ao;
  }
  const total = slots.reduce((a, b) => a + b, 0);
  return { filter: parts.join(';'), total };
}

export function clipLengths(slots: number[], transition: Transition, T = TRANSITION_SEC) {
  return slots.map((s, i) => (transition === 'none' || i === slots.length - 1 ? s : s + T));
}

export function escapeFilterPath(p: string) {
  // escape for use inside filter option values (subtitles=filename=...)
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

/**
 * Final mix command: inputs = [video track (with ducked original audio), voice segments..., music?]
 */
export function finalMixArgs(args: {
  videoTrack: string;
  voiceFiles: Array<{ file: string; startSec: number }>;
  music?: { file: string; volume: number } | null;
  originalVolume: number;
  totalDuration: number;
  assFile?: string | null;
  fontsDir: string;
  output: string;
  preset: string;
  threads: number;
  crf?: number;
}): string[] {
  const inputs: string[] = ['-i', args.videoTrack];
  args.voiceFiles.forEach((v) => inputs.push('-i', v.file));
  const musicIdx = args.music ? args.voiceFiles.length + 1 : -1;
  if (args.music) inputs.push('-stream_loop', '-1', '-i', args.music.file);

  const f: string[] = [];
  const voiceLabels: string[] = [];
  args.voiceFiles.forEach((v, i) => {
    const ms = Math.round(v.startSec * 1000);
    f.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[vo${i}]`);
    voiceLabels.push(`[vo${i}]`);
  });
  const D = args.totalDuration.toFixed(3);
  if (voiceLabels.length) {
    f.push(`${voiceLabels.join('')}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0,apad,atrim=duration=${D},volume=1.0[voice]`);
  } else {
    f.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${D}[voice]`);
  }
  f.push(`[0:a]aresample=48000,volume=${args.originalVolume.toFixed(3)},apad,atrim=duration=${D}[orig]`);
  const mixIns = ['[voice]', '[orig]'];
  if (args.music) {
    f.push(
      `[${musicIdx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${args.music.volume.toFixed(3)},atrim=duration=${D},afade=t=in:d=1,afade=t=out:st=${Math.max(
        0,
        args.totalDuration - 2,
      ).toFixed(3)}:d=2[mus]`,
    );
    mixIns.push('[mus]');
  }
  f.push(`${mixIns.join('')}amix=inputs=${mixIns.length}:duration=first:normalize=0,alimiter=limit=0.95,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
  const vf = args.assFile
    ? `[0:v]subtitles=filename=${escapeFilterPath(args.assFile)}:fontsdir=${escapeFilterPath(args.fontsDir)}[vout]`
    : `[0:v]null[vout]`;
  f.push(vf);

  return [
    ...inputs,
    '-filter_complex', f.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-t', D,
    '-c:v', 'libx264', '-preset', args.preset, '-crf', String(args.crf ?? 21), '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    ...(args.threads ? ['-threads', String(args.threads)] : []),
    '-movflags', '+faststart',
    args.output,
  ];
}
