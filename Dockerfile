# syntax=docker/dockerfile:1.7
FROM oven/bun:1 AS build

WORKDIR /app

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    python3 \
    make \
    g++ \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm

COPY package.json bun.lock tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

ARG OPENCLAW_GIT_REF=main
ENV OPENCLAW_GIT_REF=${OPENCLAW_GIT_REF}

RUN bun install --frozen-lockfile
RUN bun run build

FROM oven/bun:1 AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Install Node.js 22 (for openclaw CLI runtime), pnpm (for openclaw update),
# tini (PID 1 zombie reaping), python3 (for openclaw plugins).
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl tini python3 python3-venv \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && corepack enable && corepack prepare pnpm@10 --activate \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY --from=build /app/openclaw ./openclaw
COPY --from=build /app/src/ui ./src/ui

# Persist npm/pnpm state under /data so openclaw update survives redeploys.
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

# Prepare persistent data directory for Railway volume mount.
RUN mkdir -p /data/.openclaw /data/workspace /data/npm /data/pnpm /data/pnpm-store /data/npm-cache \
  && chown -R bun:bun /data

ENV PORT=8080
ENV OPENCLAW_PUBLIC_PORT=8080
ENV OPENCLAW_NODE=bun
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace

EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["bun", "run", "dist/server.js"]
