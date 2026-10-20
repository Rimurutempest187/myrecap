import { readFile } from 'node:fs/promises';
import {
  prisma,
  storage,
  env,
  chat,
  parseJsonLoose,
  transcribe,
  detectScenesFull,
  extractFrame,
  extractSpeechAudio,
  FRAME_DESCRIBE_SYSTEM,
  planSystemPrompt,
  planUserPrompt,
  PermanentJobError,
  LlmError,
  logger,
  type ChatMessage,
} from '@recap/core';
import type { JobContext } from '../context.js';
import { buildScenes, pickScenesForFrames, sanitizeSegments, myanmarRatio } from './scenes.js';

interface FrameDesc {
  t: number;
  desc: string;
  interest?: number;
}

async function llm(ctx: JobContext, messages: ChatMessage[], opts: { model?: string; json?: boolean; maxTokens?: number } = {}) {
  try {
    const r = await chat(messages, { ...opts, signal: ctx.signal });
    await ctx.usage('LLM_INPUT_TOKENS', r.inputTokens, (r.inputTokens / 1e6) * env().LLM_INPUT_USD_PER_1M);
    await ctx.usage('LLM_OUTPUT_TOKENS', r.outputTokens, (r.outputTokens / 1e6) * env().LLM_OUTPUT_USD_PER_1M);
    return r.text;
  } catch (e) {
    if (e instanceof LlmError && !e.retryable) throw new PermanentJobError(e.message);
    throw e;
  }
}

export async function processAnalyze(ctx: JobContext) {
  const project = await prisma.project.findUnique({ where: { id: ctx.job.projectId! } });
  if (!project || project.deletedAt) throw new PermanentJobError('Project not found');
  const asset = project.sourceAssetId ? await prisma.asset.findUnique({ where: { id: project.sourceAssetId } }) : null;
  if (!asset || asset.status !== 'READY' || !asset.durationSec) throw new PermanentJobError('Source video is not ready');
  const e = env();
  const duration = asset.durationSec;

  await ctx.progress(2, 'Downloading video');
  const src = ctx.file('source');
  await storage().downloadToFile(asset.storageKey, src);

  // 1) Scene detection (real FFmpeg scene-change analysis)
  await ctx.progress(8, 'Detecting scenes');
  const cuts = await detectScenesFull(src, e.SCENE_THRESHOLD, duration, {
    signal: ctx.signal,
    timeoutMs: Math.max(120_000, duration * 1000),
    onProgress: (f) => void ctx.progress(8 + f * 22).catch(() => undefined),
  });
  const scenes = buildScenes(cuts, duration);
  logger.info({ jobId: ctx.job.id, cuts: cuts.length, scenes: scenes.length }, 'scenes detected');
  await ctx.usage('ANALYZE_SECONDS', duration, 0);

  // 2) Optional speech-to-text of original dialogue (improves plot understanding)
  let transcript: Array<{ start: number; end: number; text: string }> | undefined;
  if (asset.hasAudio && e.STT_API_KEY && e.STT_BASE_URL) {
    await ctx.progress(31, 'Transcribing dialogue');
    try {
      const audio = ctx.file('speech.mp3');
      const maxSec = Math.min(duration, 3600);
      await extractSpeechAudio(src, audio, maxSec, { signal: ctx.signal, timeoutMs: 600_000 });
      const bytes = await readFile(audio);
      if (bytes.length < 24 * 1024 * 1024) {
        const tr = await transcribe(audio, bytes, ctx.signal);
        if (tr) {
          transcript = tr.segments.filter((s) => s.text);
          await ctx.usage('STT_MINUTES', maxSec / 60, (maxSec / 60) * e.STT_USD_PER_MIN);
        }
      }
    } catch (err) {
      logger.warn({ err, jobId: ctx.job.id }, 'transcription failed; continuing with visual analysis only');
    }
  }

  // 3) Sample one frame per (selected) scene and get visual descriptions from the vision model
  const picks = pickScenesForFrames(scenes, e.ANALYSIS_MAX_FRAMES);
  await ctx.progress(35, `Extracting ${picks.length} key frames`);
  const frames: Array<{ t: number; i: number; dataUrl: string }> = [];
  for (const [k, p] of picks.entries()) {
    const f = ctx.file(`f${k}.jpg`);
    await extractFrame(src, p.t, f, 512, { signal: ctx.signal });
    const b64 = (await readFile(f)).toString('base64');
    frames.push({ t: p.t, i: p.i, dataUrl: `data:image/jpeg;base64,${b64}` });
    await ctx.progress(35 + ((k + 1) / picks.length) * 10);
  }

  const descs: FrameDesc[] = [];
  const batch = e.ANALYSIS_FRAMES_PER_CALL;
  const batches = Math.ceil(frames.length / batch);
  for (let b = 0; b < batches; b++) {
    const slice = frames.slice(b * batch, (b + 1) * batch);
    await ctx.progress(45 + (b / batches) * 30, `AI analyzing scenes (${b + 1}/${batches})`);
    const content: ChatMessage['content'] = [
      { type: 'text', text: `Video "${asset.filename ?? project.title}", ${duration.toFixed(0)}s long. Frames ${b * batch + 1}-${b * batch + slice.length} of ${frames.length}. Previous context: ${descs.slice(-3).map((d) => d.desc).join(' | ') || 'none'}` },
    ];
    for (const fr of slice) {
      content.push({ type: 'text', text: `Frame at t=${fr.t}s:` });
      content.push({ type: 'image_url', image_url: { url: fr.dataUrl, detail: 'low' } });
    }
    const text = await llm(ctx, [{ role: 'system', content: FRAME_DESCRIBE_SYSTEM }, { role: 'user', content }], { model: e.VISION_MODEL || e.LLM_MODEL, json: true, maxTokens: 4000 });
    let parsed: { frames?: FrameDesc[] } = {};
    try {
      parsed = parseJsonLoose(text);
    } catch {
      logger.warn({ jobId: ctx.job.id }, 'frame description JSON parse failed');
    }
    const list = Array.isArray(parsed.frames) ? parsed.frames : [];
    slice.forEach((fr, idx) => {
      const d = list.find((x) => Math.abs(Number(x.t) - fr.t) < 0.6) ?? list[idx];
      descs.push({ t: fr.t, desc: String(d?.desc ?? '').slice(0, 300), interest: Number(d?.interest) || undefined });
    });
  }

  const sceneInfos = scenes.map((s, i) => {
    const d = descs.find((x) => x.t >= s.start && x.t <= s.end) ?? descs.reduce<FrameDesc | undefined>((best, x) => (!best || Math.abs(x.t - s.start) < Math.abs(best.t - s.start) ? x : best), undefined);
    return { start: s.start, end: s.end, desc: d?.desc, interest: d?.interest, i };
  });

  // 4) Script plan in Myanmar language with timestamp selection
  await ctx.progress(78, 'Writing Myanmar recap script');
  const sys = planSystemPrompt(project.recapType);
  const user = planUserPrompt({
    durationSec: duration,
    targetDurationSec: Math.min(project.targetDurationSec, Math.round(duration * 0.9)),
    customPrompt: project.customPrompt,
    scenes: sceneInfos,
    transcript,
    originalTitle: asset.filename ?? project.title,
  });
  let plan: { title?: string; summary?: string; segments?: unknown } | null = null;
  let segments: ReturnType<typeof sanitizeSegments> = [];
  let lastErr = '';
  for (let attempt = 0; attempt < 3 && segments.length === 0; attempt++) {
    const msgs: ChatMessage[] = [{ role: 'system', content: sys }, { role: 'user', content: user }];
    if (lastErr) msgs.push({ role: 'user', content: `Your previous answer was rejected: ${lastErr}. Return valid JSON with Myanmar narration only.` });
    const text = await llm(ctx, msgs, { json: true, maxTokens: 12000 });
    try {
      plan = parseJsonLoose(text);
      const segs = sanitizeSegments(plan?.segments, duration);
      const ratio = myanmarRatio(segs.map((s) => s.narration).join(' '));
      if (segs.length < 2) lastErr = 'too few segments';
      else if (ratio < 0.7) lastErr = `narration is not in Myanmar script (myanmar ratio ${ratio.toFixed(2)})`;
      else segments = segs;
    } catch (err: any) {
      lastErr = err.message;
    }
    await ctx.progress(80 + attempt * 5);
  }
  if (!segments.length) throw new Error(`AI could not produce a valid Myanmar script: ${lastErr}`);

  await ctx.progress(95, 'Saving script');
  await prisma.$transaction(async (tx) => {
    await tx.subtitle.deleteMany({ where: { projectId: project.id } });
    await tx.scriptSegment.deleteMany({ where: { projectId: project.id } });
    await tx.scriptSegment.createMany({
      data: segments.map((s, i) => ({ projectId: project.id, idx: i, sourceStart: s.sourceStart, sourceEnd: s.sourceEnd, narration: s.narration, sceneNote: s.sceneNote ?? null })),
    });
    await tx.project.update({
      where: { id: project.id },
      data: {
        status: 'SCRIPT_READY',
        lastError: null,
        analysis: {
          aiTitle: plan?.title ?? null,
          summary: plan?.summary ?? null,
          sceneCount: scenes.length,
          scenes: sceneInfos.slice(0, 400).map((s) => ({ start: s.start, end: s.end, desc: s.desc ?? null, interest: s.interest ?? null })),
          transcriptSegments: transcript?.length ?? 0,
          framesAnalyzed: frames.length,
          analyzedAt: new Date().toISOString(),
        },
      },
    });
  });
  return { result: { segments: segments.length, scenes: scenes.length }, charge: ctx.job.creditsReserved, projectStatus: 'SCRIPT_READY' as const };
}
