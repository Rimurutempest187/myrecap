import { Hono } from 'hono';
import { prisma, availableVoices, defaultVoice, listActiveModels, getRouting, TRANSITIONS, CREDIT_RULES, storage, env, badRequest } from '@recap/core';
import { body, z } from '../lib/validate.js';
import { rateLimit } from '../lib/rateLimit.js';
import { clientIp } from '../lib/auth.js';
import { publicPlan } from '../lib/serialize.js';

export const metaRoutes = new Hono();

metaRoutes.get('/config', async (c) => {
  const plans = await prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  const packs = await prisma.creditPack.findMany({ where: { active: true }, orderBy: { credits: 'asc' } });
  const [voices, defVoice, chatModels, routing] = await Promise.all([availableVoices(), defaultVoice(), listActiveModels('CHAT'), getRouting()]);
  const engines = new Set(voices.map((v) => v.engine));
  return c.json({
    voices,
    defaultVoice: defVoice,
    ttsProvider: voices.length === 0 ? 'none' : engines.size === 1 && engines.has('ESPEAK') ? 'espeak' : 'neural',
    aiModels: routing.allowUserModelChoice
      ? chatModels.filter((m) => m.userSelectable).map((m) => ({ id: m.id, label: m.displayName, provider: m.provider.name, vision: m.supportsVision, description: m.description, creditMultiplier: m.creditMultiplier }))
      : [],
    aiReady: chatModels.length > 0,
    transitions: TRANSITIONS,
    recapTypes: [
      { id: 'ANIME', label: 'Anime Recap', description: 'Dramatic episode/season recaps with character focus' },
      { id: 'MOVIE', label: 'Movie Recap', description: 'Full plot explained, beginning to ending' },
      { id: 'SHORTS', label: 'Long-to-Shorts', description: 'Vertical 30–60s hook-driven short' },
      { id: 'HIGHLIGHTS', label: 'Highlights', description: 'Best moments with commentary' },
      { id: 'CUSTOM', label: 'Custom Recap', description: 'Your own instructions' },
    ],
    aspectRatios: ['9:16', '16:9', '1:1'],
    creditRules: CREDIT_RULES,
    plans: plans.map(publicPlan),
    creditPacks: packs.map((p) => ({ id: p.id, name: p.name, credits: p.credits, priceCents: p.priceCents, currency: p.currency, purchasable: !!p.stripePriceId })),
    paymentsEnabled: !!env().STRIPE_SECRET_KEY,
    allowedMime: env().ALLOWED_VIDEO_MIME.split(','),
  });
});

metaRoutes.get('/music', async (c) => {
  const tracks = await prisma.musicTrack.findMany({ where: { active: true }, orderBy: { title: 'asc' } });
  return c.json({
    items: await Promise.all(
      tracks.map(async (t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        license: t.license,
        licenseUrl: t.licenseUrl,
        durationSec: t.durationSec,
        mood: t.mood,
        previewUrl: await storage().presignDownload(t.storageKey, { inline: true }),
      })),
    ),
  });
});

/** Public copyright takedown (DMCA-style) report form. */
metaRoutes.post('/takedown', rateLimit({ name: 'takedown', limit: 5, windowSec: 3600 }), async (c) => {
  const b = await body(
    c,
    z.object({
      reporterName: z.string().trim().min(2).max(120),
      reporterEmail: z.string().email().max(200),
      rightsHolder: z.string().trim().min(2).max(200),
      contentUrl: z.string().url().max(500).optional().or(z.literal('')),
      projectId: z.string().max(40).optional().or(z.literal('')),
      description: z.string().trim().min(20).max(5000),
      swornStatement: z.literal(true, { message: 'The good-faith statement is required' }),
    }),
  );
  if (!b.contentUrl && !b.projectId) throw badRequest('Provide the content URL or project ID');
  const r = await prisma.takedownReport.create({
    data: { ...b, contentUrl: b.contentUrl || null, projectId: b.projectId || null, ip: clientIp(c) },
  });
  return c.json({ id: r.id, status: r.status }, 201);
});
