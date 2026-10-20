# syntax=docker/dockerfile:1.7
# One multi-stage Dockerfile, three runtime targets: api, worker, web.
#   docker build -f docker/Dockerfile --target api    -t recapai-api .
#   docker build -f docker/Dockerfile --target worker -t recapai-worker .
#   docker build -f docker/Dockerfile --target web    -t recapai-web .

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 NPM_CONFIG_UPDATE_NOTIFIER=false
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------- install all deps (cached on lockfile) ----------
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---------- build everything ----------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build -w @recap/core && npm run build -w @recap/api && npm run build -w @recap/worker
RUN npm run build -w @recap/web
# Prune dev dependencies for the Node services
RUN npm prune --omit=dev --workspace=@recap/core --workspace=@recap/api --workspace=@recap/worker --include-workspace-root

# ---------- API ----------
FROM base AS api
ENV NODE_ENV=production PORT=4000 SERVICE_NAME=api
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg postgresql-client tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/prisma packages/core/prisma
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY docker/entrypoint-api.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && useradd -r -u 10001 -g node app && mkdir -p /data && chown app:node /data
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

# ---------- Video worker (FFmpeg + Myanmar fonts) ----------
FROM base AS worker
ENV NODE_ENV=production SERVICE_NAME=worker WORK_DIR=/work FONTS_DIR=/usr/share/fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg fonts-noto-core fonts-noto-extra fonts-sil-padauk fontconfig espeak-ng postgresql-client tini \
    && fc-cache -f && rm -rf /var/lib/apt/lists/* \
    && fc-list | grep -qi "Noto Sans Myanmar"
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/prisma packages/core/prisma
COPY --from=build /app/apps/worker/package.json apps/worker/
COPY --from=build /app/apps/worker/dist apps/worker/dist
RUN useradd -r -u 10001 -g node app && mkdir -p /work && chown app:node /work
USER app
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4100').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/worker/dist/index.js"]

# ---------- Web (Next.js standalone) ----------
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
COPY --from=build /app/apps/web/public apps/web/public
RUN useradd -r -u 10001 -g node app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
