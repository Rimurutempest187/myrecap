import type { Asset, Project, Job, User, Plan } from '@recap/core';

export const RATIO_LABEL = { R9_16: '9:16', R16_9: '16:9', R1_1: '1:1' } as const;

export function publicUser(u: User & { plan?: Plan | null }) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    creditBalance: u.creditBalance,
    monthlyCreditLimit: u.monthlyCreditLimit,
    plan: u.plan ? publicPlan(u.plan) : null,
    createdAt: u.createdAt,
  };
}

export function publicPlan(p: Plan) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    priceCents: p.priceCents,
    currency: p.currency,
    monthlyCredits: p.monthlyCredits,
    maxUploadMb: p.maxUploadMb,
    maxVideoMinutes: p.maxVideoMinutes,
    maxConcurrentJobs: p.maxConcurrentJobs,
    maxOutputHeight: p.maxOutputHeight,
    watermark: p.watermark,
    features: p.features,
    purchasable: !!p.stripePriceId,
  };
}

export function publicAsset(a: Asset | null | undefined) {
  if (!a) return null;
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: Number(a.sizeBytes),
    durationSec: a.durationSec,
    width: a.width,
    height: a.height,
    hasAudio: a.hasAudio,
    createdAt: a.createdAt,
  };
}

export function publicJob(j: Job) {
  return {
    id: j.id,
    projectId: j.projectId,
    type: j.type,
    status: j.status,
    progress: j.progress,
    stage: j.stage,
    error: j.error,
    attempts: j.attempts,
    creditsReserved: j.creditsReserved,
    creditsCharged: j.creditsCharged,
    estCostUsd: j.estCostUsd,
    cancelRequested: j.cancelRequested,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
  };
}

export function publicProject(p: Project) {
  return {
    id: p.id,
    title: p.title,
    recapType: p.recapType,
    aspectRatio: RATIO_LABEL[p.aspectRatio],
    fitMode: p.fitMode,
    customPrompt: p.customPrompt,
    targetDurationSec: p.targetDurationSec,
    status: p.status,
    voiceName: p.voiceName,
    analysisModelId: p.analysisModelId,
    autoPilot: p.autoPilot,
    voiceRate: p.voiceRate,
    voicePitch: p.voicePitch,
    originalAudioVolume: p.originalAudioVolume,
    musicTrackId: p.musicTrackId,
    musicVolume: p.musicVolume,
    transition: p.transition,
    subtitleStyle: p.subtitleStyle,
    subtitlesEnabled: p.subtitlesEnabled,
    analysis: p.analysis,
    lastError: p.lastError,
    copyrightConfirmed: !!p.copyrightConfirmedAt,
    sourceAssetId: p.sourceAssetId,
    outputAssetId: p.outputAssetId,
    thumbnailAssetId: p.thumbnailAssetId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
