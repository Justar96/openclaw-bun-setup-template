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

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY --from=build /app/openclaw ./openclaw
COPY --from=build /app/src/ui ./src/ui

# Prepare persistent data directory for Railway volume mount.
# Railway overlays a volume here at runtime; pre-creating ensures
# correct ownership if the container starts before the mount is ready.
RUN mkdir -p /data/.openclaw /data/workspace \
  && chown -R bun:bun /data

ENV PORT=8080
ENV OPENCLAW_PUBLIC_PORT=8080
ENV OPENCLAW_NODE=bun
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace

VOLUME /data
EXPOSE 8080
CMD ["bun", "run", "dist/server.js"]
