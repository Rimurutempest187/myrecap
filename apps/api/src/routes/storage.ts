import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { env, localStorageDriver, verifyLocal, forbidden, badRequest, notFound } from '@recap/core';

/**
 * Signed local file endpoint — used ONLY when STORAGE_DRIVER=local (development / single-node).
 * In production with R2/S3, clients upload/download directly via presigned URLs.
 */
export const storageRoutes = new Hono();

storageRoutes.put('/local', async (c) => {
  if (env().STORAGE_DRIVER !== 'local') throw notFound();
  const q = c.req.query();
  const exp = Number(q.exp);
  const size = Number(q.size);
  if (!verifyLocal('put', q.key, exp, q.sig, `${q.ct}\n${q.size}`)) throw forbidden('Invalid or expired upload URL');
  const ct = c.req.header('content-type');
  if (ct !== q.ct) throw badRequest('Content-Type mismatch');
  const len = Number(c.req.header('content-length'));
  if (len && len !== size) throw badRequest('Content-Length mismatch');
  const body = c.req.raw.body;
  if (!body) throw badRequest('Empty body');
  const written = await localStorageDriver().writeStream(q.key, Readable.fromWeb(body as any), size);
  if (written !== size) throw badRequest('Upload incomplete');
  return c.body(null, 200);
});

storageRoutes.get('/local', async (c) => {
  if (env().STORAGE_DRIVER !== 'local') throw notFound();
  const q = c.req.query();
  if (!verifyLocal('get', q.key, Number(q.exp), q.sig, `${q.fn ?? ''}\n${q.disp ?? 'attachment'}`)) throw forbidden('Invalid or expired link');
  const drv = localStorageDriver();
  const head = await drv.head(q.key);
  if (!head) throw notFound('File not found');
  const ext = q.key.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', mp3: 'audio/mpeg', jpg: 'image/jpeg', avi: 'video/x-msvideo' };
  const type = types[ext ?? ''] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300' };
  if (q.fn) headers['Content-Disposition'] = `${q.disp === 'inline' ? 'inline' : 'attachment'}; filename="${q.fn.replace(/[^\w.\-]/g, '_')}"`;
  const range = c.req.header('range');
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? Number(m[1]) : Math.max(0, head.size - Number(m[2]));
      const end = m[2] && m[1] ? Math.min(Number(m[2]), head.size - 1) : head.size - 1;
      if (start >= head.size || start > end) return c.body(null, 416, { 'Content-Range': `bytes */${head.size}` });
      const stream = drv.readStream(q.key, { start, end });
      return new Response(Readable.toWeb(stream) as any, {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${head.size}`, 'Content-Length': String(end - start + 1) },
      });
    }
  }
  return new Response(Readable.toWeb(drv.readStream(q.key)) as any, { status: 200, headers: { ...headers, 'Content-Length': String(head.size) } });
});
