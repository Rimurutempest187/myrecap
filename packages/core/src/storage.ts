import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env.js';

export interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface HeadResult {
  size: number;
  contentType?: string;
}

export interface Storage {
  driver: 'local' | 's3';
  presignUpload(key: string, contentType: string, sizeBytes: number): Promise<UploadTarget>;
  presignDownload(key: string, opts?: { filename?: string; inline?: boolean; ttlSec?: number }): Promise<string>;
  head(key: string): Promise<HeadResult | null>;
  downloadToFile(key: string, dest: string): Promise<void>;
  uploadFile(key: string, src: string, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

// ---------- signed URL helpers for the local driver ----------
export function signLocal(op: 'get' | 'put', key: string, expires: number, extra = ''): string {
  return createHmac('sha256', env().SESSION_SECRET).update(`${op}\n${key}\n${expires}\n${extra}`).digest('hex');
}

export function verifyLocal(op: 'get' | 'put', key: string, expires: number, sig: string, extra = ''): boolean {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(signLocal(op, key, expires, extra), 'hex');
  const given = Buffer.from(sig || '', 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function safeKey(key: string): string {
  if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error('Invalid storage key');
  }
  return key;
}

class LocalStorage implements Storage {
  driver = 'local' as const;
  root = path.resolve(env().LOCAL_STORAGE_DIR);

  pathFor(key: string) {
    return path.join(this.root, safeKey(key));
  }

  async presignUpload(key: string, contentType: string, sizeBytes: number): Promise<UploadTarget> {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const extra = `${contentType}\n${sizeBytes}`;
    const sig = signLocal('put', key, exp, extra);
    const q = new URLSearchParams({ key, exp: String(exp), sig, ct: contentType, size: String(sizeBytes) });
    return { url: `${env().API_PUBLIC_URL}/api/storage/local?${q}`, method: 'PUT', headers: { 'Content-Type': contentType } };
  }

  async presignDownload(key: string, opts: { filename?: string; inline?: boolean; ttlSec?: number } = {}) {
    const exp = Math.floor(Date.now() / 1000) + (opts.ttlSec ?? env().SIGNED_URL_TTL_SEC);
    const fn = opts.filename ?? '';
    const disp = opts.inline ? 'inline' : 'attachment';
    const sig = signLocal('get', key, exp, `${fn}\n${disp}`);
    const q = new URLSearchParams({ key, exp: String(exp), sig, fn, disp });
    return `${env().API_PUBLIC_URL}/api/storage/local?${q}`;
  }

  async head(key: string) {
    try {
      const s = await stat(this.pathFor(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async writeStream(key: string, body: Readable, maxBytes: number): Promise<number> {
    const dest = this.pathFor(key);
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part-${Date.now()}`;
    let total = 0;
    body.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) body.destroy(new Error('Upload exceeds declared size'));
    });
    try {
      await pipeline(body, createWriteStream(tmp));
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return total;
  }

  readStream(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.pathFor(key), range);
  }

  async downloadToFile(key: string, dest: string) {
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(createReadStream(this.pathFor(key)), createWriteStream(dest));
  }

  async uploadFile(key: string, src: string) {
    const dest = this.pathFor(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(createReadStream(src), createWriteStream(dest));
  }

  async delete(key: string) {
    await rm(this.pathFor(key), { force: true });
  }

  async deletePrefix(prefix: string) {
    const dir = this.pathFor(prefix.replace(/\/$/, ''));
    let n = 0;
    try {
      n = (await readdir(dir, { recursive: true })).length;
    } catch {
      return 0;
    }
    await rm(dir, { recursive: true, force: true });
    return n;
  }
}

class S3Storage implements Storage {
  driver = 's3' as const;
  client: S3Client;
  bucket: string;

  constructor() {
    const e = env();
    const endpoint =
      e.S3_ENDPOINT || (e.STORAGE_DRIVER === 'r2' && e.R2_ACCOUNT_ID ? `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
    this.client = new S3Client({
      region: e.S3_REGION,
      endpoint,
      forcePathStyle: !!e.S3_ENDPOINT,
      credentials: { accessKeyId: e.S3_ACCESS_KEY_ID!, secretAccessKey: e.S3_SECRET_ACCESS_KEY! },
    });
    this.bucket = e.S3_BUCKET!;
  }

  async presignUpload(key: string, contentType: string, sizeBytes: number): Promise<UploadTarget> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), ContentType: contentType, ContentLength: sizeBytes });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: 3600, signableHeaders: new Set(['content-type', 'content-length']) });
    return { url, method: 'PUT', headers: { 'Content-Type': contentType } };
  }

  async presignDownload(key: string, opts: { filename?: string; inline?: boolean; ttlSec?: number } = {}) {
    const disp = opts.filename
      ? `${opts.inline ? 'inline' : 'attachment'}; filename="${opts.filename.replace(/[^\w.\-]/g, '_')}"`
      : undefined;
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key), ResponseContentDisposition: disp });
    return getSignedUrl(this.client, cmd, { expiresIn: opts.ttlSec ?? env().SIGNED_URL_TTL_SEC });
  }

  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null;
      throw e;
    }
  }

  async downloadToFile(key: string, dest: string) {
    await mkdir(path.dirname(dest), { recursive: true });
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    await pipeline(r.Body as Readable, createWriteStream(dest));
  }

  async uploadFile(key: string, src: string, contentType: string) {
    const s = await stat(src);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: safeKey(key),
        Body: createReadStream(src),
        ContentType: contentType,
        ContentLength: s.size,
      }),
    );
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
  }

  async deletePrefix(prefix: string) {
    let n = 0;
    let token: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: safeKey(prefix), ContinuationToken: token }),
      );
      const objs = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (objs.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objs } }));
        n += objs.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return n;
  }
}

let instance: Storage | null = null;
export function storage(): Storage {
  if (!instance) instance = env().STORAGE_DRIVER === 'local' ? new LocalStorage() : new S3Storage();
  return instance;
}
export function localStorageDriver(): LocalStorage {
  const s = storage();
  if (s.driver !== 'local') throw new Error('Local storage driver not active');
  return s as LocalStorage;
}

export const keys = {
  source: (userId: string, assetId: string, ext: string) => `users/${userId}/sources/${assetId}${ext}`,
  voice: (userId: string, projectId: string, segIdx: number, hash: string) =>
    `users/${userId}/projects/${projectId}/voice/${segIdx}-${hash}.mp3`,
  render: (userId: string, projectId: string, assetId: string) => `users/${userId}/projects/${projectId}/renders/${assetId}.mp4`,
  thumb: (userId: string, projectId: string, assetId: string) => `users/${userId}/projects/${projectId}/thumbs/${assetId}.jpg`,
  projectPrefix: (userId: string, projectId: string) => `users/${userId}/projects/${projectId}/`,
  music: (id: string) => `library/music/${id}.mp3`,
};

export { Readable };
