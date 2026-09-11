# Ingest Container — long-lived Hyperliquid WS shards
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Copy the workspace manifests first so dependency installation stays cacheable
# when only source changes. `apps/*` and `packages/*` are the root workspace
# globs; every one of them must be present before install, because the lockfile
# describes the whole workspace graph. Copying only a subset makes Bun resolve
# the root dependencies alone and quietly omit everything a workspace declares.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/api-gateway/package.json ./apps/api-gateway/
COPY apps/copier/package.json ./apps/copier/
COPY apps/ingest/package.json ./apps/ingest/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
COPY packages/shared-types/package.json ./packages/shared-types/

# `--ignore-scripts` is required, not an optimisation: the root `prepare` script
# runs `lefthook install`, which needs `git` and is meaningless in a container.
# Without this flag the install step fails and the image cannot be built.
RUN bun install --frozen-lockfile --ignore-scripts

# Copy the sources (node_modules and build output are excluded via .dockerignore).
COPY . .

EXPOSE 3001

# /health is served by the Bun HTTP server in src/index.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `start` (bun src/index.ts), NOT `dev` — `dev` is `bun --watch`, which would run
# a filesystem watcher in production. No build step is needed either:
# @hyperdash/shared-types resolves through its `exports` map to `./src/index.ts`,
# so Bun consumes the TypeScript source directly.
CMD ["bun", "run", "--filter=@hyperdash/ingest", "start"]
