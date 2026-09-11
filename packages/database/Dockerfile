# One-shot schema migration image.
#
# `infrastructure/docker/postgres/init.sql` only creates extensions and a liveness
# table — it does NOT create the application schema. Without this step a freshly
# deployed database has no `copy_strategies`, `trader_stats`, or Better Auth
# tables, and the copier fails on its first reconcile pass.
#
# Run to completion, then exit:
#   docker compose -f docker-compose.prod.yml run --rm migrate
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Workspace manifests first (see apps/ingest/Dockerfile for why all of them).
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/api-gateway/package.json ./apps/api-gateway/
COPY apps/copier/package.json ./apps/copier/
COPY apps/ingest/package.json ./apps/ingest/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
COPY packages/shared-types/package.json ./packages/shared-types/

# `--ignore-scripts` because the root `prepare` script runs `lefthook install`,
# which needs `git` and is meaningless in a container.
RUN bun install --frozen-lockfile --ignore-scripts

# Only the database workspace is needed; copying it alone keeps the image small.
COPY packages/database ./packages/database

# Each script is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-running this
# service is safe. Order matters: the base schema first, then the trader-stats and
# Better Auth tables that depend on it.
CMD ["bun", "run", "--filter=@hyperdash/database", "migrate"]
