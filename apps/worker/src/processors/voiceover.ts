import {
  prisma,
  storage,
  keys,
  synthesizeWith,
  voiceModel,
  audioDuration,
  voiceHash,
  estimateVoiceCredits,
  computeTimeline,
  buildCues,
  PermanentJobError,
  TtsError,
} from '@recap/core';
import type { JobContext } from '../context.js';

/** Synthesize Myanmar narration per segment (only changed segments), measure durations, then build subtitle timings. */
export async function processVoiceover(ctx: JobContext) {
  const project = await prisma.project.findUnique({ where: { id: ctx.job.projectId! } });
  if (!project || project.deletedAt) throw new PermanentJobError('Project not found');
  const voice = await voiceModel(project.voiceName);
  if (!voice) throw new PermanentJobError('The selected voice is no longer available. Choose another voice and try again.');
  const segs = await prisma.scriptSegment.findMany({ where: { projectId: project.id }, orderBy: { idx: 'asc' } });
  if (!segs.length) throw new PermanentJobError('Script is empty');

  const pending = segs.filter(
    (s) => !s.audioKey || s.audioTextHash !== voiceHash(s.narration, project.voiceName, project.voiceRate, project.voicePitch),
  );
  let chars = 0;
  for (const [k, s] of pending.entries()) {
    await ctx.progress(5 + (k / Math.max(1, pending.length)) * 80, `Generating Myanmar voice (${k + 1}/${pending.length})`);
    const hash = voiceHash(s.narration, project.voiceName, project.voiceRate, project.voicePitch);
    const out = ctx.file(`v${s.idx}.mp3`);
    try {
      await synthesizeWith(voice, s.narration, { rate: project.voiceRate, pitch: project.voicePitch, outFile: out, signal: ctx.signal });
    } catch (e) {
      if (e instanceof TtsError && !e.retryable) throw new PermanentJobError(e.message);
      throw e;
    }
    const dur = await audioDuration(out, ctx.signal);
    const key = keys.voice(project.userId, project.id, s.idx, hash);
    await storage().uploadFile(key, out, 'audio/mpeg');
    const old = s.audioKey;
    await prisma.scriptSegment.update({ where: { id: s.id }, data: { audioKey: key, audioDurationSec: dur, audioTextHash: hash } });
    if (old && old !== key) await storage().delete(old).catch(() => undefined);
    const n = Array.from(s.narration).length;
    chars += n;
    await ctx.usage('TTS_CHARS', n, (n / 1e6) * voice.unitUsdPer1M, voice.id);
  }

  await ctx.progress(90, 'Creating Myanmar subtitles');
  const fresh = await prisma.scriptSegment.findMany({ where: { projectId: project.id }, orderBy: { idx: 'asc' } });
  const timeline = computeTimeline(fresh.map((s) => ({ idx: s.idx, audioDurationSec: s.audioDurationSec })));
  const cues = buildCues(fresh, timeline);
  await prisma.$transaction([
    prisma.subtitle.deleteMany({ where: { projectId: project.id } }),
    prisma.subtitle.createMany({
      data: cues.map((c) => ({ projectId: project.id, idx: c.idx, segmentIdx: c.segmentIdx, startSec: c.startSec, endSec: c.endSec, text: c.text })),
    }),
    prisma.project.update({ where: { id: project.id }, data: { status: 'VOICED', lastError: null } }),
  ]);
  const total = timeline.reduce((a, t) => a + t.duration, 0);
  return {
    result: { synthesized: pending.length, chars, outputDurationSec: total, subtitles: cues.length },
    charge: chars ? estimateVoiceCredits(chars) : 0,
    projectStatus: 'VOICED' as const,
  };
}
