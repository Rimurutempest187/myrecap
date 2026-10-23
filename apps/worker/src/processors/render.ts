import { writeFile, stat } from 'node:fs/promises';
import {
  prisma,
  storage,
  env,
  keys,
  probe,
  ffmpeg,
  outputSize,
  clipArgs,
  clipLengths,
  xfadeGraph,
  finalMixArgs,
  computeTimeline,
  buildAss,
  voiceHash,
  estimateRenderCredits,
  extractFrame,
  TRANSITIONS,
  TRANSITION_SEC,
  PermanentJobError,
  type Transition,
  type SubtitleStyle,
} from '@recap/core';
import type { JobContext } from '../context.js';

/**
 * Real FFmpeg render:
 *  1. download source + voice clips (+ music)
 *  2. cut & normalize one clip per segment (aspect-ratio fit, fps, audio)
 *  3. join clips with xfade transitions
 *  4. mix narration + ducked original audio + music, loudness-normalize
 *  5. burn Myanmar subtitles (libass + Noto Sans Myanmar), H.264/AAC MP4 faststart
 */
export async function processRender(ctx: JobContext) {
  const e = env();
  const project = await prisma.project.findUnique({ where: { id: ctx.job.projectId! } });
  if (!project || project.deletedAt) throw new PermanentJobError('Project not found');
  const source = project.sourceAssetId ? await prisma.asset.findUnique({ where: { id: project.sourceAssetId } }) : null;
  if (!source || source.status !== 'READY') throw new PermanentJobError('Source video is not available');
  const segs = await prisma.scriptSegment.findMany({ where: { projectId: project.id }, orderBy: { idx: 'asc' } });
  if (!segs.length) throw new PermanentJobError('Script is empty');
  for (const s of segs) {
    if (!s.audioKey || s.audioTextHash !== voiceHash(s.narration, project.voiceName, project.voiceRate, project.voicePitch)) {
      throw new PermanentJobError('Voiceover is outdated. Please regenerate the voiceover.');
    }
  }
  const input = (ctx.job.input ?? {}) as { maxHeight?: number; watermark?: boolean };
  const { width, height } = outputSize(project.aspectRatio, input.maxHeight ?? 1080);
  const fps = 30;
  const transition: Transition = (TRANSITIONS as readonly string[]).includes(project.transition) ? (project.transition as Transition) : 'fade';
  const preset = e.FFMPEG_PRESET;
  const threads = e.FFMPEG_THREADS;
  const timeoutMs = e.JOB_TIMEOUT_MIN * 60_000;

  await ctx.progress(2, 'Downloading media');
  const src = ctx.file('source');
  await storage().downloadToFile(source.storageKey, src);
  const info = await probe(src, ctx.signal);
  const voiceFiles: string[] = [];
  for (const s of segs) {
    const f = ctx.file(`voice${s.idx}.mp3`);
    await storage().downloadToFile(s.audioKey!, f);
    voiceFiles.push(f);
  }
  let music: { file: string; volume: number } | null = null;
  if (project.musicTrackId && project.musicVolume > 0) {
    const t = await prisma.musicTrack.findFirst({ where: { id: project.musicTrackId, active: true } });
    if (t) {
      const f = ctx.file('music.mp3');
      await storage().downloadToFile(t.storageKey, f);
      music = { file: f, volume: project.musicVolume };
    }
  }

  const timeline = computeTimeline(segs.map((s) => ({ idx: s.idx, audioDurationSec: s.audioDurationSec })));
  const slots = timeline.map((t) => t.duration);
  const lengths = clipLengths(slots, transition);
  const total = slots.reduce((a, b) => a + b, 0);

  // 2) per-segment clips
  const clipFiles: string[] = [];
  const clipWork = lengths.reduce((a, b) => a + b, 0);
  let done = 0;
  for (const [i, s] of segs.entries()) {
    const out = ctx.file(`clip${i}.mp4`);
    const base = 8 + (done / clipWork) * 52;
    await ctx.progress(base, `Editing scene ${i + 1}/${segs.length}`);
    await ffmpeg(
      clipArgs({
        input: src,
        output: out,
        start: s.sourceStart,
        length: lengths[i],
        sourceDuration: info.durationSec,
        width,
        height,
        fps,
        fitMode: project.fitMode === 'crop' ? 'crop' : 'blur',
        includeAudio: info.hasAudio,
        preset,
        threads,
      }),
      {
        signal: ctx.signal,
        timeoutMs,
        totalDurationSec: lengths[i],
        onProgress: (f) => void ctx.progress(base + ((f * lengths[i]) / clipWork) * 52).catch(() => undefined),
      },
    );
    clipFiles.push(out);
    done += lengths[i];
  }

  // 3) join with transitions
  await ctx.progress(60, 'Applying transitions');
  const joined = ctx.file('joined.mp4');
  if (transition === 'none' || clipFiles.length === 1) {
    const list = ctx.file('list.txt');
    await writeFile(list, clipFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined], { signal: ctx.signal, timeoutMs });
  } else {
    const g = xfadeGraph(slots, transition, TRANSITION_SEC);
    const args: string[] = [];
    clipFiles.forEach((f) => args.push('-i', f));
    args.push(
      '-filter_complex', g.filter,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      ...(threads ? ['-threads', String(threads)] : []),
      joined,
    );
    await ffmpeg(args, {
      signal: ctx.signal,
      timeoutMs,
      totalDurationSec: total,
      onProgress: (f) => void ctx.progress(60 + f * 15).catch(() => undefined),
    });
  }

  // 4+5) subtitles + audio mix + final encode
  await ctx.progress(76, 'Mixing audio & rendering subtitles');
  let assFile: string | null = null;
  const subs = project.subtitlesEnabled ? await prisma.subtitle.findMany({ where: { projectId: project.id }, orderBy: { idx: 'asc' } }) : [];
  if (subs.length || input.watermark) {
    assFile = ctx.file('subs.ass');
    await writeFile(
      assFile,
      buildAss(subs, {
        width,
        height,
        font: e.SUBTITLE_FONT,
        style: (project.subtitleStyle as SubtitleStyle | null) ?? undefined,
        watermark: input.watermark ? 'RecapAI' : undefined,
        durationSec: total,
      }),
      'utf8',
    );
  }
  const output = ctx.file('output.mp4');
  await ffmpeg(
    finalMixArgs({
      videoTrack: joined,
      voiceFiles: voiceFiles.map((file, i) => ({ file, startSec: timeline[i].start + 0.05 })),
      music,
      originalVolume: info.hasAudio ? project.originalAudioVolume : 0,
      totalDuration: total,
      assFile,
      fontsDir: e.FONTS_DIR,
      output,
      preset,
      threads,
    }),
    {
      signal: ctx.signal,
      timeoutMs,
      totalDurationSec: total,
      onProgress: (f) => void ctx.progress(76 + f * 18).catch(() => undefined),
    },
  );

  // verify output
  await ctx.progress(95, 'Verifying & uploading MP4');
  const outInfo = await probe(output, ctx.signal);
  if (Math.abs(outInfo.durationSec - total) > 2) {
    throw new Error(`Rendered duration mismatch (${outInfo.durationSec.toFixed(1)}s vs ${total.toFixed(1)}s)`);
  }
  const size = (await stat(output)).size;

  const asset = await prisma.asset.create({
    data: {
      userId: project.userId,
      kind: 'RENDER',
      status: 'UPLOADED',
      storageKey: `pending-render-${ctx.job.id}`,
      filename: `${project.title}.mp4`,
      mimeType: 'video/mp4',
      sizeBytes: BigInt(size),
      durationSec: outInfo.durationSec,
      width: outInfo.width,
      height: outInfo.height,
      hasAudio: outInfo.hasAudio,
    },
  });
  const key = keys.render(project.userId, project.id, asset.id);
  await storage().uploadFile(key, output, 'video/mp4');
  await prisma.asset.update({ where: { id: asset.id }, data: { storageKey: key, status: 'READY' } });

  // thumbnail from the rendered video
  let thumbId = project.thumbnailAssetId;
  try {
    const thumb = ctx.file('thumb.jpg');
    await extractFrame(output, Math.min(2, total / 2), thumb, 640, { signal: ctx.signal });
    const ta = await prisma.asset.create({
      data: { userId: project.userId, kind: 'THUMBNAIL', status: 'READY', storageKey: `pending-th-${asset.id}`, mimeType: 'image/jpeg' },
    });
    const tk = keys.thumb(project.userId, project.id, ta.id);
    await storage().uploadFile(tk, thumb, 'image/jpeg');
    await prisma.asset.update({ where: { id: ta.id }, data: { storageKey: tk } });
    thumbId = ta.id;
  } catch {
    /* keep previous thumbnail */
  }

  const prevOutput = project.outputAssetId;
  await prisma.project.update({
    where: { id: project.id },
    data: { outputAssetId: asset.id, thumbnailAssetId: thumbId, status: 'COMPLETED', lastError: null },
  });
  if (prevOutput) {
    const prev = await prisma.asset.findUnique({ where: { id: prevOutput } });
    if (prev) {
      await storage().delete(prev.storageKey).catch(() => undefined);
      await prisma.asset.update({ where: { id: prev.id }, data: { status: 'DELETED' } });
    }
  }
  await ctx.usage('RENDER_SECONDS', total, (total / 60) * e.RENDER_USD_PER_MIN);
  return {
    result: { assetId: asset.id, durationSec: outInfo.durationSec, width, height, sizeBytes: size },
    charge: estimateRenderCredits(total),
    projectStatus: 'COMPLETED' as const,
  };
}
