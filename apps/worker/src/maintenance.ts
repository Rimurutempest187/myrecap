import { readdir, stat, rm, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { prisma, env, storage, logger, keys, finalizeFailed } from '@recap/core';

/** Remove stale temp job directories left behind by crashed workers. */
export async function cleanupTempDirs() {
  const dir = path.resolve(env().WORK_DIR);
  const maxAge = env().TEMP_RETENTION_HOURS * 3600_000;
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      const p = path.join(dir, name);
      const s = await stat(p).catch(() => null);
      if (s && Date.now() - s.mtimeMs > maxAge) {
        await rm(p, { recursive: true, force: true });
        removed++;
      }
    }
  } catch {
    /* dir may not exist yet */
  }
  return removed;
}

/** Purge soft-deleted projects' DB rows, abandoned uploads, expired sessions, and orphaned jobs. */
export async function purgeDeleted() {
  const days = env().DELETED_PROJECT_PURGE_DAYS;
  const cutoff = new Date(Date.now() - days * 86400_000);
  const projects = await prisma.project.findMany({ where: { deletedAt: { lt: cutoff } }, take: 200 });
  for (const p of projects) {
    await storage().deletePrefix(keys.projectPrefix(p.userId, p.id)).catch(() => undefined);
    await prisma.asset.deleteMany({ where: { id: { in: [p.sourceAssetId, p.outputAssetId, p.thumbnailAssetId].filter(Boolean) as string[] } } });
    await prisma.project.delete({ where: { id: p.id } });
  }
  // uploads that never completed (24h)
  const stale = await prisma.asset.findMany({
    where: { status: 'PENDING_UPLOAD', createdAt: { lt: new Date(Date.now() - 86400_000) } },
    take: 500,
  });
  for (const a of stale) {
    await storage().delete(a.storageKey).catch(() => undefined);
    await prisma.asset.delete({ where: { id: a.id } });
  }
  const deletedAssets = await prisma.asset.findMany({ where: { status: { in: ['DELETED', 'REJECTED'] }, updatedAt: { lt: cutoff } }, take: 500 });
  for (const a of deletedAssets) {
    await storage().delete(a.storageKey).catch(() => undefined);
    await prisma.asset.delete({ where: { id: a.id } });
  }
  const sessions = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return { projects: projects.length, staleUploads: stale.length, assets: deletedAssets.length, sessions: sessions.count };
}

/** Jobs stuck ACTIVE beyond timeout (e.g. worker killed by OOM) are failed and refunded. */
export async function reapStuckJobs() {
  const cutoff = new Date(Date.now() - (env().JOB_TIMEOUT_MIN + 10) * 60_000);
  const stuck = await prisma.job.findMany({ where: { status: 'ACTIVE', startedAt: { lt: cutoff } } });
  for (const j of stuck) await finalizeFailed(j.id, 'Job timed out (worker stopped responding). Credits were refunded — please retry.');
  return stuck.length;
}

/** pg_dump → gzip → object storage (backups/), with retention. */
export async function backupDatabase() {
  const e = env();
  if (!e.BACKUP_ENABLED) return null;
  const dir = path.resolve(e.WORK_DIR, 'backups');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `db-${stamp}.sql.gz`);
  const url = e.DATABASE_URL.replace(/\?schema=[^&]+&?/, '?').replace(/\?$/, '');
  const proc = spawn(e.PG_DUMP_PATH, ['--no-owner', '--no-privileges', '--format=plain', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err += d));
  const exit = new Promise<number>((r) => proc.on('close', (c) => r(c ?? 1)));
  await pipeline(proc.stdout, createGzip(), createWriteStream(file));
  if ((await exit) !== 0) throw new Error(`pg_dump failed: ${err.slice(0, 500)}`);
  const key = `backups/db/${stamp}.sql.gz`;
  await storage().uploadFile(key, file, 'application/gzip');
  await rm(file, { force: true });
  logger.info({ key }, 'database backup uploaded');
  // retention: delete by listing via known naming isn't possible in generic interface; store index in settings
  const idx = await prisma.systemSetting.findUnique({ where: { key: 'backups' } });
  const list: string[] = [...(((idx?.value as any)?.keys as string[]) ?? []), key];
  const keep = e.BACKUP_RETENTION_DAYS;
  const toDelete = list.length > keep ? list.slice(0, list.length - keep) : [];
  for (const k of toDelete) await storage().delete(k).catch(() => undefined);
  const remaining = list.slice(toDelete.length);
  await prisma.systemSetting.upsert({ where: { key: 'backups' }, create: { key: 'backups', value: { keys: remaining } }, update: { value: { keys: remaining } } });
  return key;
}
