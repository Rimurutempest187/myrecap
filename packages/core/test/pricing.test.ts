import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgresql://x';
  process.env.SESSION_SECRET ||= 'x'.repeat(40);
});

describe('pricing & helpers', async () => {
  const { estimateAnalyzeCredits, estimateVoiceCredits, estimateRenderCredits } = await import('../src/pricing.js');
  const { parseJsonLoose } = await import('../src/ai/llm.js');
  const { buildSsml } = await import('../src/tts/index.js');
  const { safeKey } = await import('../src/storage.js');
  const { productionConfigProblems, env, resetEnvCache } = await import('../src/env.js');

  it('estimates credits with min/max bounds', () => {
    expect(estimateAnalyzeCredits(30)).toBe(2);
    expect(estimateAnalyzeCredits(20 * 60)).toBe(20);
    expect(estimateAnalyzeCredits(10 * 3600)).toBe(40);
    expect(estimateVoiceCredits(10)).toBe(1);
    expect(estimateVoiceCredits(1000)).toBe(3);
    expect(estimateRenderCredits(60)).toBe(3);
    expect(estimateRenderCredits(5)).toBe(2);
  });

  it('parses JSON from fenced / noisy model output', () => {
    expect(parseJsonLoose<{ a: number }>('```json\n{"a":1}\n```').a).toBe(1);
    expect(parseJsonLoose<{ a: number }>('Sure! {"a":2} done').a).toBe(2);
    expect(() => parseJsonLoose('nope')).toThrow();
  });

  it('builds escaped SSML with prosody for Myanmar voice', () => {
    const s = buildSsml('မင်္ဂလာပါ <b>&', 'my-MM-NilarNeural', 1.2, -5);
    expect(s).toContain('xml:lang="my-MM"');
    expect(s).toContain('rate="+20%"');
    expect(s).toContain('pitch="-5%"');
    expect(s).toContain('&lt;b&gt;&amp;');
  });

  it('rejects unsafe storage keys', () => {
    expect(() => safeKey('../etc/passwd')).toThrow();
    expect(() => safeKey('/abs')).toThrow();
    expect(safeKey('users/a/b.mp4')).toBe('users/a/b.mp4');
  });

  it('flags insecure production config', () => {
    const old = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'production', STORAGE_DRIVER: 'local', TTS_PROVIDER: 'espeak' });
    resetEnvCache();
    const p = productionConfigProblems(env(), 'worker');
    expect(p.some((x) => x.includes('STORAGE_DRIVER=local'))).toBe(true);
    expect(p.some((x) => x.includes('espeak'))).toBe(true);
    process.env = old;
    resetEnvCache();
  });
});
