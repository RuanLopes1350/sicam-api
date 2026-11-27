# Multi-stage Dockerfile — sicam-api (HTTP Server + BullMQ Geo/Cartography Worker)
FROM node:22-bookworm-slim AS base
ENV COREPACK_ENABLE_STRICT=0
RUN corepack enable && corepack prepare pnpm@9.7.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY openapi ./openapi
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3333

RUN groupadd --system --gid 1001 sicam \
	&& useradd --system --uid 1001 --gid sicam --create-home sicam

COPY --from=builder --chown=sicam:sicam /app/package.json ./package.json
COPY --from=builder --chown=sicam:sicam /app/node_modules ./node_modules
COPY --from=builder --chown=sicam:sicam /app/dist ./dist
COPY --from=builder --chown=sicam:sicam /app/drizzle ./drizzle
COPY --from=builder --chown=sicam:sicam /app/openapi ./openapi

USER sicam
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3333) + '/api/v1/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server.js"]

# Estágio worker inclui Chromium headless (Playwright) para renderização offline 300 DPI (ADR-12)
FROM api AS worker
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
	&& apt-get install -y --no-install-recommends fonts-liberation fonts-dejavu-core \
	&& node ./node_modules/playwright/cli.js install --with-deps chromium \
	&& chmod -R a+rX /ms-playwright \
	&& rm -rf /var/lib/apt/lists/*

USER sicam
HEALTHCHECK NONE
CMD ["node", "dist/worker.js"]
