# Deployment

Target topology: **Cloudflare Workers** for the request-scoped surface,
**Oracle Ampere A1 (ARM64, 24 GB)** for everything long-lived.

```
Cloudflare (Workers Paid)
├─ hyperdash-web     Workers + Hyperdrive + KV
├─ hyperdash-api     Workers + Hyperdrive + KV
└─ COPY_QUEUE        Queues (optional)

        │ Hyperdrive: TCP + TLS back to the origin
        ▼

Oracle Ampere A1 (ARM64, free tier)
├─ cloudflared       outbound-only tunnel; no inbound ports
├─ postgres          application database, TLS required
├─ redis             feed history (bounded 7-day window)
├─ ingest            Hyperliquid WS shards + browser WS hub   ── SINGLETON
└─ copier            reconciliation loop; places orders when LIVE=1
```

## Why each piece lives where it does

| Component | Placement | Reason |
| --- | --- | --- |
| `apps/web`, `apps/api` | Workers | Request-scoped. Hyperdrive + KV are already wired; this is what the `wrangler.toml` files describe. |
| `apps/ingest` | Oracle | Long-lived WS client holding in-memory snapshots. **Must not be replicated** (see below). |
| `apps/copier` | Oracle | Long-lived loop that signs orders. Must be inspectable and must not be evicted mid-position. |
| `postgres`, `redis` | Oracle | Cloudflare has no managed Postgres/Redis. Hyperdrive is a pooler *in front of* your database, not a database. |
| `apps/api-gateway` | **nowhere** | Deprecated, removal 2026-09-30. Do not deploy. |

**Hyperliquid is fronted by AWS CloudFront, not Cloudflare:**

```
$ curl -sI https://api.hyperliquid.xyz/info
Server: nginx/1.22.1
Via: 1.1 ...cloudfront.net (CloudFront)
```

So running the execution plane on Cloudflare would *not* reduce distance to the
exchange — it would add an extra public hop. Latency is not a reason to move
`ingest` or `copier` to Workers.

## Hard constraints

1. **`ingest` is a singleton.** `demandFor` refcounts subscriptions in-process and
   fan-out uses Bun's in-process pub/sub, so a second replica would double the
   upstream socket count (risking Hyperliquid's per-IP limits) while each replica
   serves only its own browsers. Never `--scale ingest=2`.
2. **Hyperdrive cannot traverse a Cloudflare Tunnel.** It speaks raw TCP to
   Postgres, so the database port must be reachable from Cloudflare's egress.
   Lock it down with the host firewall and require TLS.
3. **`ENCRYPTION_KEY` must be byte-identical in two places.** The `api` Worker
   encrypts agent private keys at rest; `copier` decrypts them to sign. A
   mismatch is not caught at boot — it surfaces as a decryption failure the first
   time an order needs signing.
4. **Run exactly one execution plane.** `apps/copier` and `apps/copy-engine` both
   place real orders. `copy-engine` is gated behind the `legacy-execution` profile
   precisely so the default stack cannot double-execute.
5. **`HYPERLIQUID_TESTNET` must match** between the `api` Worker and `copier`.
   Signing for one network and submitting to the other is rejected at order time.

## Procedure

### 1. Preflight

```bash
bun scripts/preflight-deploy.ts
```

Fails on unreplaced provisioning ids and on a `PUBLIC_ORIGIN` still pointing at
localhost (which silently breaks every wallet signature, since the SIWE domain
derives from it).

### 2. Database host (Oracle)

```bash
# TLS material for Postgres (Hyperdrive talks TLS; self-signed is acceptable
# because verification is between you and Cloudflare, but pin it if you can).
mkdir -p secrets/postgres
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout secrets/postgres/server.key -out secrets/postgres/server.crt \
  -subj "/CN=$(hostname -f)"
chmod 600 secrets/postgres/server.key

# Least-privilege role for Hyperdrive. Never use the superuser.
#   CREATE ROLE hd_app LOGIN PASSWORD '<strong>';
#   GRANT CONNECT ON DATABASE hyperdash TO hd_app;
#   GRANT USAGE ON SCHEMA public TO hd_app;
#   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hd_app;
#   ALTER DEFAULT PRIVILEGES IN SCHEMA public
#     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hd_app;
```

Then restrict port 5432 in the host firewall to Cloudflare's published egress
ranges. `0.0.0.0/0` is not acceptable.

### 3. Environment

```bash
cp .env.production.example .env.production
$EDITOR .env.production          # every CHANGE_ME, plus ENCRYPTION_KEY

docker compose -f docker-compose.prod.yml --env-file .env.production config
```

### 4. Bring up the origin

```bash
# Data first, then the one-shot schema migration, then the services.
# init.sql creates extensions only — NOT the application schema.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres redis
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

`migrate` is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-running is safe.

Verify:

```bash
curl -s localhost:3001/health | jq    # {"status":"ok","feed":{"connected":true,...}}
docker compose -f docker-compose.prod.yml logs -f copier   # expect mode PAPER
```

### 5. Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create hyperdash
# Write secrets/cloudflared/config.yml mapping api.<domain> -> ingest:3001 (/ws)
# and copy the tunnel credentials JSON into secrets/cloudflared/.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d cloudflared
```

### 6. Cloudflare Workers

```bash
cd apps/api
bunx wrangler hyperdrive create hyperdash-db \
  --connection-string="postgres://hd_app:PASSWORD@DB_HOST:5432/hyperdash?sslmode=require"
bunx wrangler kv namespace create KV
# Paste both ids into apps/api/wrangler.toml AND apps/web/wrangler.toml,
# set PUBLIC_ORIGIN to the real https origin, then:

bunx wrangler secret put BETTER_AUTH_SECRET
bunx wrangler secret put ENCRYPTION_KEY       # same value as .env.production
bunx wrangler secret put RESEND_API_KEY
bunx wrangler secret put EMAIL_FROM
bunx wrangler deploy

cd ../web
bunx wrangler secret put BETTER_AUTH_SECRET
bunx wrangler secret put RESEND_API_KEY
bunx wrangler secret put EMAIL_FROM
bunx wrangler deploy

# Point the web Worker at the api Worker so the browser stays same-origin
# (no CORS, no SameSite=None cookies):
#   BE_URL = "https://hyperdash-api.<subdomain>.workers.dev"
# then redeploy.
```

Re-run `bun scripts/preflight-deploy.ts` before each deploy.

## Frontend/backend split

`BE_URL` is read at **runtime** by the web Worker (`apps/web/src/routes/api/$.ts`);
when set, it proxies `/api/*` to the api Worker. This is the recommended mode
because the browser never leaves the web origin.

`VITE_BE_URL` is different: `VITE_*` values are inlined by Vite at **build** time
(`apps/web/src/lib/api-client.tsx` reads `import.meta.env`), so declaring one in
`wrangler.toml` `[vars]` has no effect. To have the browser call the api Worker
directly you must export it in the build environment — and then handle CORS and
cross-site cookies yourself. The preflight warns if a `VITE_*` key appears in
`[vars]`.

## Going live

`LIVE=0` runs the identical pipeline against live market data with simulated
fills. Only after verifying end to end:

1. Confirm `copier` logs `mode: PAPER` and reconciles without failures.
2. Confirm agent-wallet authorization works in the UI.
3. Set `LIVE=1` and restart `copier` with a small position cap
   (`DEFAULT_MAX_POSITION_USD`).
4. Watch the first few fills before widening the caps.

## Operational notes

- **Backups.** Oracle Always Free instances can be reclaimed. `pg_dump` on a
  schedule to object storage, and keep a copy of `ENCRYPTION_KEY` off-host — loss
  of that key makes every stored agent wallet unrecoverable.
- **Observability** is optional: `--profile observability` adds Prometheus and
  Grafana (both bound to 127.0.0.1), using the configs already in
  `infrastructure/`.
- **Resource headroom.** The whole long-lived stack measures well under 2 GB
  (Postgres ~40 MB, Redis ~13 MB, plus two Bun processes), so a 24 GB host has
  room for a staging stack or generous Postgres tuning.
- **Graceful shutdown.** `copier` handles SIGTERM and drains in-flight work; the
  compose service sets `stop_grace_period: 30s` so `docker stop` cannot kill it
  mid-order.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Worker returns 500 on any DB route | Hyperdrive id still a placeholder, or Postgres unreachable from Cloudflare egress |
| Wallet sign-in rejects every signature | `PUBLIC_ORIGIN` is still `localhost` |
| `copier` exits with a decryption error at order time | `ENCRYPTION_KEY` differs between the api Worker and `.env.production` |
| `copier` exits with `DATABASE_URL is required` | env file not passed (`--env-file`) |
| `ingest` dies with `ENOENT .../zod` | image built before the `.dockerignore` fix; rebuild with `--no-cache` |
| Two orders per signal | both execution planes are running; leave `copy-engine` off |
| `cannot insert multiple commands into a prepared statement` | `postgres` driver cannot carry multiple commands per statement — one command per `client\`\`` call |
