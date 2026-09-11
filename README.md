# HyperDash - Copy Trading Platform

Copy trading platform for the Hyperliquid derivatives exchange.

## Features

- **Trader Discovery** - Browse and analyze top traders
- **Copy Trading** - Automatically copy trades from selected traders
- **Strategy Management** - Create and manage copy strategies with risk controls
- **Trading Terminal** (`/terminal`) - Live orderbook, 1m candlesticks, trade
  tape and tracked-whale positioning per market (Hyperliquid WS feed)
- **Market Analytics** (`/analytics`) - Open-interest table, funding / price
  heatmaps, liquidation-like stress heatmap and whale-flow tracking

## Real-time Feed

`api-gateway` runs a sharded Hyperliquid WebSocket client (2 connections × 12
coins by default) and fans data out to browsers over `ws://<host>/ws`:

- Channels: `mids`, `ctx[:COIN]`, `trades:COIN`, `book:COIN`, `candle:COIN`, `state`
- Order books & 1m candles are **demand-driven**: subscribed only while a
  browser watches that coin
- History (`/feed/history/funding|price|oi|volume|stress|whale-flow`) is
  recorded into Redis by the feed recorder (best-effort; the pipeline works
  without Redis, history just stays empty)
- Hyperliquid constraints (per IP) baked into the client: ~13 subscriptions
  per connection, ≤10 concurrent connections, 30 new connections/min → the
  client shards, throttles and backs off accordingly
- Configure via `HL_FEED_COINS`, `HL_WHALE_ADDRESSES`; web uses
  `VITE_WS_URL` (default `ws://localhost:3000/ws`)

### Whale auto-discovery

No manual seed list required: the gateway watches every trade and ranks
addresses by live taker/maker volume (`whale-discovery.ts`). Periodically it
ingests the top whales' full profiles (stats/trades/positions) into Postgres,
so the leaderboard and whale-position panels populate automatically:

- `HL_AUTO_INGEST` = `1` (default) — enables the periodic ingest cycle
- `HL_INGEST_INTERVAL_MS` — ingest period in ms (default 600000 / 10 min)
- `HL_COPY_ENGINE_AUTOSTART` = `1` — opt-in; starts the copy-trading engine
  with the gateway (places real orders — leave off in dev)

## Architecture

```
┌─────────────────────────────┐        ┌──────────────┐
│  Web (TanStack Start)        │        │  api-gateway │
│  on Cloudflare Workers       │        │  (ingestion, │
│   • Hono API  /api/*         │        │   Go engine  │
│   • Better Auth (SIWE)       │        │   execution) │
│   • Drizzle → Hyperdrive     │        └──────┬───────┘
└──────────────┬───────────────┘               │
               │                                │
               ▼                                ▼
        ┌──────────────┐                 ┌──────────────┐
        │  PostgreSQL  │◀────────────────│  Hyperliquid │
        │  (Hyperdrive)│                 │   API / WS   │
        │  + KV        │                 └──────────────┘
        └──────────────┘
```

The web app is a self-contained TanStack Start application deployed to Cloudflare
Workers with its own Hono API. `api-gateway` (Express) and the Go `copy-engine`
are the persistent-process plane: Hyperliquid ingestion and trade execution.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Dev runtime / PM | Bun |
| Web framework | TanStack Start (React 18), Vite 7 |
| Prod runtime | Cloudflare Workers |
| Web API | Hono (`/api/*`), typed `hono/client` |
| Auth | Better Auth (SIWE wallet sign-in) |
| Wallet UI | wagmi + RainbowKit |
| Database | PostgreSQL via Drizzle ORM, reached through Hyperdrive |
| Cache / sessions | Cloudflare KV |
| Validation | Zod 4 |
| Styling | Tailwind v4 |
| Lint / format | Biome |
| Build | Turborepo, Bun |
| Ingestion / execution | Express (api-gateway), Go (copy-engine) |

## Quick Start

```bash
# Install
bun install

# Start infrastructure (Postgres + Redis)
bun run docker:up

# Migrate database (business + Better Auth tables)
bun run db:migrate

# Dev (web + ingestion gateway)
bun run dev
```

Web: http://localhost:5173

## Deploy (Cloudflare Workers)

```bash
cd apps/web

# One-time provisioning (returns ids for wrangler.toml)
bunx wrangler hyperdrive create hyperdash-db --connection-string="postgres://user:pass@host:5432/db"
bunx wrangler kv namespace create KV

# Secrets
bunx wrangler secret put BETTER_AUTH_SECRET   # openssl rand -base64 32
bunx wrangler secret put RESEND_API_KEY
bunx wrangler secret put EMAIL_FROM

# Deploy
bun run deploy
```

## Project Structure

```
apps/
  web/           # TanStack Start on Workers (Hono API, SIWE, Drizzle/Hyperdrive)
  api-gateway/   # Hyperliquid ingestion + jobs
  copy-engine/   # Go trading engine
packages/
  database/      # Drizzle schemas + migrations (incl. Better Auth)
  shared-types/  # Shared Zod schemas / types
  contracts/     # Legacy tRPC (api-gateway only)
```

## Environment

Web secrets are Worker bindings (`wrangler.toml` + `wrangler secret put`); see
`apps/web/.dev.vars.example` and `apps/web/.env.example`. Backend services use
`DATABASE_URL`, `REDIS_URL`, `HYPERLIQUID_API_URL`.

## Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start web + ingestion gateway |
| `bun run build` | Build all |
| `bun run type-check` | Typecheck workspace |
| `bun run lint` | Biome check |
| `bun run db:migrate` | Migrations |
| `bun run docker:up` | Start Docker services |
