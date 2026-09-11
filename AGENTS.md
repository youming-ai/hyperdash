# Repository Guidelines

## Project Structure

This is a Turborepo + **Bun** monorepo for a Hyperliquid copy trading platform.

```
apps/
  web/              # TanStack Start app on Cloudflare Workers (Vite, port 5173)
                    #   - Hono API at /api/*  (src/server/hono.ts)
                    #   - Better Auth SIWE    (src/lib/auth.ts)
                    #   - Drizzle over Hyperdrive (src/db/index.ts)
  api-gateway/      # Background ingestion + execution plane (Express, port 3000)
                    #   Hyperliquid polling/jobs that populate the DB. NOT the web API.
  copy-engine/      # Go trading engine that executes copied trades (port 3006)
packages/
  database/         # Drizzle ORM schemas, migrations, Better Auth tables
  shared-types/     # Shared Zod schemas / TypeScript types
  contracts/        # Legacy tRPC contracts (used by api-gateway only)
```

Internal workspace dependencies use `workspace:*`. The web app consumes the DB
schema via the Worker-safe subpaths `@hyperdash/database/schema` and
`@hyperdash/database/auth-schema` (source, bundled by Vite).

## Build, Test & Development

| Command | What it does |
|---------|--------------|
| `bun install` | Install dependencies |
| `bun run dev` | Start web + API gateway concurrently |
| `bun run dev:web` | Start web app only (Vite) |
| `bun run dev:api` | Start ingestion gateway only |
| `bun run build` | Build all packages/apps |
| `bun run test` | Run tests via Turborepo (`bun test`) |
| `bun run type-check` | TypeScript `--noEmit` across workspace |
| `bun run lint` | Biome check |
| `bun run lint:fix` | Biome auto-fix |
| `bun run db:migrate` | Run PostgreSQL migrations (incl. Better Auth tables) |
| `bun run docker:up` | Start Postgres + Redis containers |
| `cd apps/web && bun run start` | Run the Worker locally (`wrangler dev`) |
| `cd apps/web && bun run deploy` | `wrangler deploy` the web Worker |
| `cd apps/web && bun run auth:generate` | Regenerate Better Auth Drizzle schema |

## Coding Style & Naming

- **Formatter/Linter**: Biome (no ESLint/Prettier).
- **Indent** 2 spaces · **Quotes** single JS/TS, double JSX · **Trailing commas** all · **Line width** 100 · **Semicolons** always · **Arrow parens** always.
- **Imports**: Biome organize-imports enabled. Path alias in web is `~/*` → `src/*`.
- TypeScript strict mode. Avoid `any`.
- Repo rules: no `ReturnType<typeof fn>` type exports (name the type); don't extract one-expression helper functions.

## Testing

- **Runner**: `bun test`. `vitest` only for Cloudflare Workers integration tests that need the real runtime/bindings.
- **Test files**: `*.test.ts` alongside source.
- Cover services, routers, and utility logic.

## Commit & Pull Request Guidelines

- **Commit format**: `type(scope): description` — `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.
  - Example: `feat(web): port traders router to Hono`
- **PRs**: feature branches; clear description of changes.

## Architecture Notes

- **Web app**: TanStack Start (SSR/SSG) on **Cloudflare Workers**. Its own **Hono** API is mounted at `/api/*` via the catch-all `src/routes/api/$.ts`; routers live in `src/server/routers/`. The frontend calls it with the typed `hono/client` (`src/lib/api-client.ts`). No tRPC in the web app.
- **Auth**: Better Auth **SIWE** (wallet sign-in). The wallet address bridges to the business `users.id` (uuid) via `src/server/user.ts`.
- **Data**: PostgreSQL via Drizzle, reached from the Worker through **Hyperdrive** with a per-request client (`src/db/index.ts`). Migrations in `packages/database/postgres/`.
- **api-gateway**: persistent background service for Hyperliquid ingestion/jobs that populate the DB the web reads. It is NOT the web's API. Long-lived work (WS, polling) stays here or in the Go engine — Workers are request-scoped.
- **Copy Engine**: Go 1.21+ service that executes copied trades.

## Environment

Web (Workers): bindings + secrets via `wrangler.toml` / `wrangler secret put`; see `apps/web/.dev.vars.example`.

- Bindings: `HYPERDRIVE`, `KV`. Vars: `PUBLIC_ORIGIN`, `HYPERLIQUID_API_URL`.
- Secrets: `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `SENTRY_DSN`.
- Client-safe (`VITE_` prefix): `VITE_PUBLIC_ORIGIN`, `VITE_WALLETCONNECT_PROJECT_ID`.

Backend services (`api-gateway`, migrations): `DATABASE_URL`, `REDIS_URL`, `HYPERLIQUID_API_URL`.

## Agent-Specific Instructions

- **Bun only**: never `npm`/`pnpm`/`yarn`/`node`/`tsx` as CLIs. Biome only (no ESLint/Prettier).
- Web runtime code must be **Workers-compatible** (Web-standard APIs; read config from `c.env`, not `process.env`; build DB/auth per request, never module-level singletons).
- The web API is **Hono + Better Auth** — do not reintroduce tRPC there. tRPC remains only in `api-gateway`/`contracts` (legacy ingestion).
- Use existing workspace packages rather than duplicating types/schemas.
- Follow TanStack Router/Start file conventions in `apps/web/src/routes/`.
