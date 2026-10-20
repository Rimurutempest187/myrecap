import { Hono } from 'hono';
import path from 'node:path';
import { prisma, env, storage, keys, badRequest, notFound, createJob } from '@recap/core';
import { body, z } from '../lib/validate.js';
import { requireAuth } from '../lib/auth.js';
import { rateLimit } from '../lib/rateLimit.js';
import { effectivePlan } from '../lib/plan.js';
import { publicAsset } from '../lib/serialize.js';
import type { AppEnv } from '../lib/types.js';

const EXT_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
};

export const uploadRoutes = new Hono<AppEnv>();
uploadRoutes.use('*', requireAuth);

/** Step 1: request a presigned upload URL for a project's source video. */
uploadRoutes.post('/', rateLimit({ name: 'upload', limit: 30, windowSec: 3600, by: 'user' }), async (c) => {
  const user = c.get('user');
  const b = await body(
    c,
    z.object({
      projectId: z.string().min(1),
      filename: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(100),
      sizeBytes: z.number().int().positive(),
    }),
  );
  const e = env();
  const allowed = e.ALLOWED_VIDEO_MIME.split(',').map((s) => s.trim());
  if (!allowed.includes(b.mimeType)) throw badRequest(`Unsupported file type ${b.mimeType}. Allowed: MP4, MOV, MKV, WEBM, AVI`);
  const plan = await effectivePlan(user);
  const maxMb = Math.min(plan.maxUploadMb, e.MAX_UPLOAD_MB);
  if (b.sizeBytes > maxMb * 1024 * 1024) throw badRequest(`File too large. Your plan allows up to ${maxMb} MB.`);

  const project = await prisma.project.findFirst({ where: { id: b.projectId, userId: user.id, deletedAt: null } });
  if (!project) throw notFound('Project not found');
  if (!project.copyrightConfirmedAt) throw badRequest('Copyright confirmation is required before uploading');
  if (!['DRAFT', 'UPLOADED', 'FAILED'].includes(project.status)) {
    throw badRequest('The source video can only be replaced before analysis starts');
  }

  const ext = EXT_BY_MIME[b.mimeType] ?? (path.extname(b.filename).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4');
  const asset = await prisma.asset.create({
    data: {
      userId: user.id,
      kind: 'SOURCE_VIDEO',
      status: 'PENDING_UPLOAD',
      storageKey: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filename: b.filename.replace(/[^\p{L}\p{N}._\- ]/gu, '_').slice(0, 200),
      mimeType: b.mimeType,
      sizeBytes: BigInt(b.sizeBytes),
    },
  });
  const key = keys.source(user.id, asset.id, ext);
  await prisma.asset.update({ where: { id: asset.id }, data: { storageKey: key } });
  const target = await storage().presignUpload(key, b.mimeType, b.sizeBytes);
  return c.json({ assetId: asset.id, upload: target });
});

/** Step 2: confirm the upload; verifies the object exists & size matches, then queues server-side validation (ffprobe). */
uploadRoutes.post('/:assetId/complete', async (c) => {
  const user = c.get('user');
  const b = await body(c, z.object({ projectId: z.string().min(1) }));
  const asset = await prisma.asset.findFirst({ where: { id: c.req.param('assetId'), userId: user.id, kind: 'SOURCE_VIDEO' } });
  if (!asset) throw notFound('Upload not found');
  const project = await prisma.project.findFirst({ where: { id: b.projectId, userId: user.id, deletedAt: null } });
  if (!project) throw notFound('Project not found');

  const head = await storage().head(asset.storageKey);
  if (!head) throw badRequest('Upload not found in storage. Please retry the upload.');
  if (head.size !== Number(asset.sizeBytes)) {
    await storage().delete(asset.storageKey);
    await prisma.asset.update({ where: { id: asset.id }, data: { status: 'REJECTED' } });
    throw badRequest('Uploaded file size does not match. Please retry.');
  }
  await prisma.asset.update({ where: { id: asset.id }, data: { status: 'UPLOADED' } });
  // replace previous source if any
  if (project.sourceAssetId && project.sourceAssetId !== asset.id) {
    const old = await prisma.asset.findUnique({ where: { id: project.sourceAssetId } });
    if (old) {
      await storage().delete(old.storageKey).catch(() => undefined);
      await prisma.asset.update({ where: { id: old.id }, data: { status: 'DELETED' } });
    }
  }
  await prisma.project.update({ where: { id: project.id }, data: { sourceAssetId: asset.id, status: 'DRAFT' } });
  const plan = await effectivePlan(user);
  const { job } = await createJob({
    userId: user.id,
    projectId: project.id,
    type: 'PROBE',
    credits: 0,
    estCostUsd: 0,
    idempotencyKey: `probe:${asset.id}`,
    maxConcurrent: plan.maxConcurrentJobs + 1,
    input: { assetId: asset.id },
  });
  return c.json({ asset: publicAsset({ ...asset, status: 'UPLOADED' }), jobId: job.id });
});
