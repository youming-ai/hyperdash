# Ingest Container — long-lived Hyperliquid WS shards
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Install deps separately for cache
COPY package.json bun.lock ./
COPY apps/ingest/package.json ./apps/ingest/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build shared types if needed
RUN bun run --filter=@hyperdash/shared-types build || true

EXPOSE 3001
CMD ["bun", "run", "--filter=@hyperdash/ingest", "dev"]
