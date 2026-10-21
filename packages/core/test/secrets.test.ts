import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgresql://x';
  process.env.SESSION_SECRET ||= 'x'.repeat(40);
});

describe('secret encryption', async () => {
  const { encryptSecret, decryptSecret, keyHint } = await import('../src/secrets.js');
  it('round-trips and uses a random IV', () => {
    const a = encryptSecret('sk-live-abcdef123456');
    const b = encryptSecret('sk-live-abcdef123456');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('abcdef');
    expect(decryptSecret(a)).toBe('sk-live-abcdef123456');
    expect(decryptSecret(null)).toBeNull();
  });
  it('detects tampering', () => {
    const [v, iv, tag, data] = encryptSecret('secret-value').split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });
  it('fails with a different key', () => {
    const blob = encryptSecret('k');
    const prev = process.env.SECRETS_KEY;
    process.env.SECRETS_KEY = 'another-key-entirely';
    expect(() => decryptSecret(blob)).toThrow();
    process.env.SECRETS_KEY = prev;
    if (prev === undefined) delete process.env.SECRETS_KEY;
  });
  it('produces safe hints', () => {
    expect(keyHint('sk-proj-1234567890WXYZ')).toBe('sk-…WXYZ');
    expect(keyHint('short')).toBe('••••');
  });
});
