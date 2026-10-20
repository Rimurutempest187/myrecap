import { spawn } from 'node:child_process';
import { env } from '../env.js';

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  formatName?: string;
  rotation: number;
}

export class FfmpegError extends Error {
  constructor(message: string, public stderr = '') {
    super(message);
    this.name = 'FfmpegError';
  }
}

export interface RunOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** total expected output duration, used to compute progress from `-progress pipe:1` */
  totalDurationSec?: number;
  onProgress?: (fraction: number) => void;
  captureStdout?: boolean;
}

export function runProcess(cmd: string, args: string[], opts: RunOpts = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const kill = (why: string) => {
      if (killed) return;
      killed = true;
      p.kill('SIGKILL');
      reject(new FfmpegError(why, stderr.slice(-4000)));
    };
    const timer = opts.timeoutMs ? setTimeout(() => kill(`${cmd} timed out after ${opts.timeoutMs}ms`), opts.timeoutMs) : null;
    const onAbort = () => kill('aborted');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    p.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      if (opts.captureStdout) stdout += s;
      if (opts.onProgress && opts.totalDurationSec) {
        const m = s.match(/out_time_(?:us|ms)=(\d+)/g);
        if (m) {
          const last = m[m.length - 1].split('=')[1];
          const sec = Number(last) / 1e6;
          opts.onProgress(Math.max(0, Math.min(1, sec / opts.totalDurationSec)));
        }
      }
    });
    p.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-20000);
    });
    p.on('error', (e) => {
      if (timer) clearTimeout(timer);
      if (!killed) reject(new FfmpegError(`${cmd} failed to start: ${e.message}`));
    });
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (killed) return;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError(`${cmd} exited with code ${code}: ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`, stderr.slice(-4000)));
    });
  });
}

export function ffmpeg(args: string[], opts: RunOpts = {}) {
  const e = env();
  const base = ['-hide_banner', '-nostdin', '-y'];
  const progress = opts.onProgress ? ['-progress', 'pipe:1', '-nostats'] : [];
  return runProcess(e.FFMPEG_PATH, [...base, ...progress, ...args], opts);
}

export async function probe(file: string, signal?: AbortSignal): Promise<ProbeResult> {
  const { stdout } = await runProcess(
    env().FFPROBE_PATH,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { signal, timeoutMs: 60_000, captureStdout: true },
  );
  const data = JSON.parse(stdout);
  const streams: any[] = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new FfmpegError('No video stream found in file');
  const [fn, fd] = String(v.avg_frame_rate || v.r_frame_rate || '25/1').split('/').map(Number);
  const fps = fd ? fn / fd : fn || 25;
  let rotation = 0;
  const sideRot = v.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation;
  if (sideRot !== undefined) rotation = Number(sideRot);
  else if (v.tags?.rotate) rotation = Number(v.tags.rotate);
  let width = Number(v.width);
  let height = Number(v.height);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const durationSec = Number(data.format?.duration ?? v.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new FfmpegError('Could not determine video duration');
  return {
    durationSec,
    width,
    height,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 25,
    hasAudio: !!a,
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name,
    formatName: data.format?.format_name,
    rotation,
  };
}

export async function audioDuration(file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await runProcess(
    env().FFPROBE_PATH,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { signal, timeoutMs: 30_000, captureStdout: true },
  );
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new FfmpegError(`Invalid audio duration for ${file}`);
  return d;
}

/** Scene-change detection (FFmpeg select+showinfo on a downscaled stream). Returns cut timestamps in seconds. */
export async function detectScenesFull(file: string, threshold: number, durationSec: number, opts: RunOpts = {}): Promise<number[]> {
  const e = env();
  return new Promise((resolve, reject) => {
    const p = spawn(e.FFMPEG_PATH, [
      '-hide_banner', '-nostdin', '-i', file, '-an', '-sn',
      '-vf', `fps=6,scale=160:-2,select='gt(scene,${threshold})',showinfo`,
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const cuts: number[] = [];
    let buf = '';
    let tail = '';
    const timer = opts.timeoutMs ? setTimeout(() => { p.kill('SIGKILL'); reject(new FfmpegError('scene detection timed out')); }, opts.timeoutMs) : null;
    const onAbort = () => { p.kill('SIGKILL'); reject(new FfmpegError('aborted')); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    p.stderr.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const m = l.match(/pts_time:([\d.]+)/);
        if (m && l.includes('Parsed_showinfo')) cuts.push(Number(m[1]));
        const t = l.match(/time=(\d+):(\d+):([\d.]+)/);
        if (t && opts.onProgress) opts.onProgress(Math.min(1, (Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) / durationSec));
        tail = (tail + l + '\n').slice(-3000);
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(cuts);
      else reject(new FfmpegError(`scene detection failed (${code})`, tail));
    });
  });
}

/** Extract a single JPEG frame (scaled) at timestamp. */
export async function extractFrame(file: string, t: number, out: string, width = 512, opts: RunOpts = {}) {
  await ffmpeg(['-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out], {
    timeoutMs: 60_000,
    ...opts,
  });
}

/** Extract mono 16kHz mp3 audio for speech-to-text. */
export async function extractSpeechAudio(file: string, out: string, maxSec: number, opts: RunOpts = {}) {
  await ffmpeg(['-i', file, '-vn', '-t', String(maxSec), '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', out], opts);
}
