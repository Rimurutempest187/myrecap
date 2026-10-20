import { prisma, computeTimeline, buildCues } from '@recap/core';

/** Recompute subtitle cues from narration + voice durations. Returns cue count. */
export async function regenerateSubtitles(projectId: string) {
  const segs = await prisma.scriptSegment.findMany({ where: { projectId }, orderBy: { idx: 'asc' } });
  if (!segs.length) return 0;
  const timeline = computeTimeline(segs.map((s) => ({ idx: s.idx, audioDurationSec: s.audioDurationSec })));
  const cues = buildCues(segs, timeline);
  await prisma.$transaction([
    prisma.subtitle.deleteMany({ where: { projectId } }),
    prisma.subtitle.createMany({ data: cues.map((c) => ({ projectId, idx: c.idx, segmentIdx: c.segmentIdx, startSec: c.startSec, endSec: c.endSec, text: c.text })) }),
  ]);
  return cues.length;
}
