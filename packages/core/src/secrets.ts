/**
 * Encryption for secrets stored in the database (provider API keys).
 * AES-256-GCM with a key derived from SECRETS_KEY (falls back to SESSION_SECRET).
 * Format: v1:<iv b64>:<tag b64>:<ciphertext b64>
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from './env.js';

function key(): Buffer {
  const material = process.env.SECRETS_KEY || env().SESSION_SECRET;
  return createHash('sha256').update(`recapai-secrets:${material}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** "sk-…AbCd" style hint safe to show in UI. */
export function keyHint(k: string) {
  const t = k.trim();
  if (t.length <= 8) return '••••';
  return `${t.slice(0, 3)}…${t.slice(-4)}`;
}
