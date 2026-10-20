import { prisma, storage, probe, env, PermanentJobError, keys, extractFrame } from '@recap/core';
import type { JobContext } from '../context.js';

/**
 * Server-side validation of an uploaded video: download, ffprobe (must be a real video with a
 * decodable video stream), enforce plan duration limits, extract a thumbnail.
 */
export async function processProbe(ctx: JobContext) {
  const input = (ctx.job.input ?? {}) as { assetId?: string };
  const asset = await prisma.asset.findUnique({ where: { id: input.assetId ?? '' } });
  if (!asset) throw new PermanentJobError('Uploaded file not found');
  const project = ctx.job.projectId ? await prisma.project.findUnique({ where: { id: ctx.job.projectId }, include: { user: { include: { plan: true } } } }) : null;
  if (!project) throw new PermanentJobError('Project not found');

  await ctx.progress(5, 'Downloading video');
  const src = ctx.file('source');
  await storage().downloadToFile(asset.storageKey, src);
  ctx.throwIfCancelled();

  await ctx.progress(40, 'Validating video');
  let info;
  try {
    info = await probe(src, ctx.signal);
  } catch (e: any) {
    await rejectAsset(asset.id, asset.storageKey);
    throw new PermanentJobError(`This file is not a valid video (${e.message}). Please upload an MP4, MOV, MKV, WEBM or AVI file.`);
  }
  const plan = project.user.plan ?? (await prisma.plan.findUnique({ where: { code: 'free' } }));
  const maxMin = Math.min(plan?.maxVideoMinutes ?? 20, env().MAX_VIDEO_MINUTES);
  if (info.durationSec > maxMin * 60) {
    await rejectAsset(asset.id, asset.storageKey);
    throw new PermanentJobError(`Video is ${(info.durationSec / 60).toFixed(1)} minutes long. Your plan allows up to ${maxMin} minutes.`);
  }
  if (info.durationSec < 5) {
    await rejectAsset(asset.id, asset.storageKey);
    throw new PermanentJobError('Video is too short (minimum 5 seconds).');
  }
  if (info.width < 160 || info.height < 120) {
    await rejectAsset(asset.id, asset.storageKey);
    throw new PermanentJobError('Video resolution is too small.');
  }

  await ctx.progress(70, 'Creating thumbnail');
  const thumb = ctx.file('thumb.jpg');
  await extractFrame(src, Math.min(info.durationSec * 0.2, 30), thumb, 640, { signal: ctx.signal });
  const thumbAsset = await prisma.asset.create({
    data: { userId: project.userId, kind: 'THUMBNAIL', status: 'READY', storageKey: `pending-thumb-${ctx.job.id}`, mimeType: 'image/jpeg' },
  });
  const tkey = keys.thumb(project.userId, project.id, thumbAsset.id);
  await storage().uploadFile(tkey, thumb, 'image/jpeg');
  await prisma.asset.update({ where: { id: thumbAsset.id }, data: { storageKey: tkey } });

  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      status: 'READY',
      durationSec: info.durationSec,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      meta: { fps: info.fps, videoCodec: info.videoCodec, audioCodec: info.audioCodec, format: info.formatName, rotation: info.rotation },
    },
  });
  await prisma.project.update({ where: { id: project.id }, data: { status: 'UPLOADED', thumbnailAssetId: thumbAsset.id, lastError: null } });
  return { result: { durationSec: info.durationSec, width: info.width, height: info.height }, charge: 0, projectStatus: 'UPLOADED' as const };
}

async function rejectAsset(id: string, key: string) {
  await prisma.asset.update({ where: { id }, data: { status: 'REJECTED' } });
  await storage().delete(key).catch(() => undefined);
}
