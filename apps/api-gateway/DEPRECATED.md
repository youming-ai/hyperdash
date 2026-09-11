# DEPRECATED — api-gateway (Express)

> **Status: deprecated 2026-08-28. Will be removed after 2026-09-30. Do not add features.**

`apps/api-gateway` (Express + tRPC, port 3000) is replaced by three independently deployable units:

| Concern | App | Runtime | Deploy |
|---|---|---|---|
| FE | `apps/web` | Cloudflare Workers (Vite + TanStack Start) | `wrangler deploy` |
| BE | `apps/api` | Cloudflare Workers / Bun (Hono) | `wrangler deploy` / `bun run start` |
| Ingest | `apps/ingest` | Container (Bun) — WS shards → Queue/Redis → BE | `docker build` / `bun run dev` |

Execution plane `apps/copy-engine` (Go) now consumes `copy:signals` from BE via Redis Stream/List (`internal/queue/consumer.go`).

**Migration:**
- HTTP API → `apps/api/src/server/hono.ts` (`/api/*`, Better Auth SIWE, Drizzle/Hyperdrive)
- Hyperliquid WS + feed recording → `apps/ingest/src/index.ts`
- Whale discovery cron → `apps/ingest/src/jobs/whale-discovery.cron.ts` (10m, `discovery.isReady()` gate)
- Copy queue → `apps/api/src/queues/copy.queue.ts` → Go consumer

**Why removed:** Workers request-scoped model cannot host long-lived WS/polling; sharing FE/BE/Ingest in one Express process blocks independent scaling and deploys. See `apps/ingest/README.md` and `apps/api/README.md`.

**Verification (independent deploy):**
```bash
bun run dev:web          # FE only — no api-gateway
bun --cwd apps/api run dev   # BE only
bun --cwd apps/ingest run dev # Ingest only — needs REDIS_URL, HYPERLIQUID_API_URL
go run ./cmd/server      # copy-engine only — needs REDIS_URL
# each starts without api-gateway; `docker-compose up` no longer requires it
```
