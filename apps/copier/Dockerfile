# Copier Container — long-lived reconciliation loop for copy trading.
#
# This process places real orders when LIVE=1, so it is deliberately NOT run on
# a serverless/runtime that can be evicted mid-position, and it keeps enough
# signal handling (see src/index.ts) to drain in-flight work on SIGTERM.
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Workspace manifests first, so the install layer stays cached when only source
# changes. Every workspace member must be present: the lockfile describes the
# whole graph, and with only a subset copied Bun resolves the root dependencies
# alone and silently omits every workspace dependency.
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/api-gateway/package.json ./apps/api-gateway/
COPY apps/copier/package.json ./apps/copier/
COPY apps/ingest/package.json ./apps/ingest/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
COPY packages/shared-types/package.json ./packages/shared-types/

# `--ignore-scripts` is required: the root `prepare` script runs
# `lefthook install`, which needs `git` and is meaningless in a container.
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

# No build step. Both workspace packages this app consumes resolve to
# TypeScript source through their `exports` maps
# (@hyperdash/database/schema -> postgres/src/schema.ts,
#  @hyperdash/shared-types -> src/index.ts), and Bun runs the TS directly.

# Run as an unprivileged user, because this process holds the key material used
# to sign exchange orders.
RUN addgroup -S -g 1001 appuser && adduser -S -u 1001 -G appuser appuser \
  && chown -R appuser:appuser /app
USER appuser

# No HTTP server to probe: this is a worker, not a service. The healthcheck
# therefore verifies the process is alive rather than a route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD pgrep -f "apps/copier/src/index.ts" >/dev/null || exit 1

# Invoke the entry point directly rather than the workspace `start` script,
# which passes `--env-file=../../.env`. In a container the environment is
# supplied by the orchestrator; reading a file would silently shadow it.
CMD ["bun", "apps/copier/src/index.ts"]
