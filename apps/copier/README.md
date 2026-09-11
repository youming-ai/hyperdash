# @hyperdash/copier

Hyperliquid copy-trading **execution plane**.

This service exists because the previous execution path could not place a single
order: target sizing returned an empty map, the exchange adapter was a stub, and
the order-signing code hashed with SHA-256/JSON where Hyperliquid requires
msgpack + keccak256. It replaces that path with the standard design used by
production copy-trading platforms.

## What it does

```
lead userFills (WS) ──┐
                      ├──► reconcile ──► target state ──► IOC orders ──► Postgres
periodic sweep ───────┘
```

Two rules drive everything:

1. **Converge on target state, never replay orders.** The lead's *position* is
   the source of truth, scaled to the follower, and the account is driven toward
   it. Missed events, partial fills and manual interventions all self-correct,
   and running the reconciler twice is a no-op.
2. **The sweep is not optional.** Websockets drop and events get lost. A timer
   re-derives everything from chain state, so a lost event degrades to "fixed
   within one sweep" instead of "silently wrong indefinitely".

## Design decisions worth knowing

| Decision | Why |
|---|---|
| Signing delegated to `@nktkas/hyperliquid` | Both signing schemes (phantom-agent msgpack+keccak for L1 actions, direct EIP-712 for user-signed) are easy to get subtly wrong and impossible to debug from a 400. |
| Precision via SDK `formatPrice`/`formatSize`/`SymbolConverter` | Hyperliquid rejects orders violating tick/lot rules (max 5 significant figures on price, `MAX_DECIMALS - szDecimals` decimals, size truncated to `szDecimals`). |
| Marketable limit + `Ioc`, never a naked market order | Hyperliquid has no protected market order; an IOC aggressive limit crosses within the slippage band and cancels the rest, leaving no stale resting order. |
| Follower risk caps override the lead | A lead at 20x with a follower capped at 5x must not drag the follower to 20x. Imperfect tracking is the correct outcome. |
| Hysteresis on both paths (`minOrderUsd` + drift %) | Without deadbands a *correct* reconciler still bleeds fees re-trading noise — and if fast path and sweep disagreed, they would oscillate against each other. |
| Positions read from the chain, not our bookkeeping | "Silently wrong" is the worst failure mode for something that moves money. |
| `copy_orders` written for failures too | A rejected order is the most important row to have. |
| Paper mode is the default | The pipeline is exercised against live market data at zero risk; `LIVE=1` is an explicit opt-in. |

## Non-custodial model

Copying happens through a Hyperliquid **agent wallet** (API wallet). The protocol
lets an agent place/cancel orders and change leverage, but forbids it from
transferring funds, withdrawing to L1, or approving further agents. The guarantee
is therefore enforced by the exchange, not by a promise.

The flow is deliberately asymmetric:

1. **server** generates the keypair and stores the private key encrypted
   (AES-256-GCM); the plaintext never leaves the process
2. **user's master wallet** signs `approveAgent` — the server can never
   self-authorize
3. **server** verifies approval on-chain before trading

### Browser flow (the production path)

The user-facing flow lives in the BE and web app:

| Piece | Location |
|---|---|
| Signature builders (single source of truth) | `packages/shared-types/src/agent-wallet.ts` |
| Exchange verification | `packages/shared-types/src/agent-approval.ts` |
| Key encryption (WebCrypto — runs on Workers *and* Bun) | `packages/shared-types/src/agent-key.ts` |
| Routes: `GET /` · `POST /intent` · `POST /confirm` · `POST /cancel` | `apps/api/src/server/routers/agent-wallets.ts` |
| Hook (`wagmi` `useSignTypedData`) | `apps/web/src/hooks/useAgentWallet.ts` |
| Typed client | `apps/web/src/lib/agent-wallet-client.ts` |
| UI panel | `apps/web/src/components/AgentWalletCard.tsx` (mounted on `/strategies`) |

`approveAgent` is a **user-signed action, not an on-chain transaction**: the
wallet signs typed data and the signature is POSTed to the exchange. No gas, no
network switch, no deposit, no transaction.

The BE stores the action it issued and replays it verbatim at confirm time. It
must not recompute it: the agent name embeds the expiry timestamp that the
signature covers, so rebuilding it a moment later changes the signed message and
every confirmation fails verification. (Measured — this was a real bug during
development, and there is a regression test for it below.)

The browser also cannot influence *which* address gets authorized: the server
replays its own stored `agentAddress`.

CLI equivalents remain useful for setup and debugging:

```bash
bun src/cli/provision-agent.ts --user <userId> --name hyperdash
bun src/cli/provision-agent.ts --user <userId> --verify --master 0x<master>
```

### Configuration notes

- `ENCRYPTION_KEY` (32-byte hex) must be **identical** in the BE and here: the BE
  encrypts agent keys at rest and this process decrypts them to sign. The shared
  module is verified round-trip compatible with keys written by the earlier
  node:crypto implementation, so existing blobs keep working.
- `HYPERLIQUID_TESTNET` must agree between the BE and the executor. Mainnet and
  testnet are separate hosts (`api.hyperliquid.xyz` vs
  `api.hyperliquid-testnet.xyz`), and signing for one while submitting to the
  other fails with "Mainnet and testnet require different signature" — which
  reads like a signing bug but is a URL mismatch.
- The EIP-712 domain chainId is Hyperliquid's `421614`, **never** the browser
  wallet's connected chain (42161 on Arbitrum).

## Running it

```bash
# prerequisites: Postgres + Redis up, trader data ingested
bun run seed      # creates a demo follower + active strategy copying a real lead
bun run check     # dry run: shows sizing chain and the deltas that would be sent
bun run start     # paper mode (default)
```

Environment:

| Var | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | required |
| `LIVE` | `0` | `1` sends real orders; requires `ENCRYPTION_KEY` to decrypt agent keys |
| `ENCRYPTION_KEY` | — | 64-char hex; decrypts each account's agent key. Must match the BE's |
| `MAX_CONCURRENCY` | `8` | accounts reconciled at once (all share one exchange IP budget) |
| `SWEEP_INTERVAL_MS` | `60000` | full-reconciliation period |
| `MIN_ORDER_USD` | `10` | deadband; also Hyperliquid's minimum notional |
| `DRIFT_THRESHOLD_PCT` | `1` | ignore drift below this % of target |
| `BUILDER_ADDRESS` / `BUILDER_FEE_RATE` | — | builder-code fee routing |
| `LOG_LEVEL` | `info` | |

## Verified behaviour

Ran against live Hyperliquid market data with a seeded follower copying a real
leader holding 83 positions (~$117M notional):

- **sizing** — 61 targets computed, $295k total notional against $100k capital
  at 3x (consistent with the levered cap)
- **execution** — 61 paper fills, each lot-rounded, all persisted to `copy_orders`
- **idempotency** — a following sweep produced **zero** additional orders
- **event path** — real lead fills triggered reconciles and corrective orders
- **self-healing** — the lead's SOL position was doubled directly in Postgres
  (producing no websocket event at all); the next sweep issued exactly the
  missing 772.8 to close the gap

## Layout

```
src/
  index.ts       entry: wires event path + sweep around one reconciler
  engine.ts      the reconciler; shared by both trigger paths
  sizing.ts      lead position → scaled target (follower caps win)
  reconcile.ts   current vs target → deltas, with deadbands
  execution.ts   paper and live planes behind one interface
  hyperliquid.ts clients, chain reads, precision helpers
  lead-feed.ts   per-lead userFills subscriptions, debounced
  agent.ts       agent provisioning + on-chain approval verification
  store.ts       Postgres reads; writes copy_orders / copy_positions
  crypto.ts      AES-256-GCM agent key encryption
  cli/           seed-strategy · check · compare-oscillation · provision-agent
```

## Boundaries and next steps

### Multi-tenant

Supported. The unit of reconciliation is the **trading account**, not the
strategy: strategies are grouped by the agent wallet that executes them, their
targets are netted, and each account is driven to the merged target once.

Three properties follow, all verified locally:

- **Isolation** — each account has its own signer and its own position view, so
  one user's strategies can never act on another's positions.
- **Containment** — a failure that is specific to one account (an unreadable key,
  a suspended wallet, a rejected signature) is logged and skipped; other accounts
  keep reconciling.
- **Independent books in paper mode** — each account simulates separately, so two
  accounts cannot contaminate each other's positions even without real funds.

### Why per-account, and not per-strategy

Reconciling strategy by strategy is wrong the moment an account carries more than
one. Each strategy measured the *account's* positions against its *own* targets,
so they repeatedly undid each other and neither ever converged.

Measured with two strategies on one account (`bun run compare`), same data and
same simulated book:

| sweeps | per-strategy (before) | per-account (now) |
|---|---|---|
| 1 | 140 orders | 98 orders |
| 5 | 700 orders | **98 orders** |
| 20 | 2,800 orders | **98 orders** |

The old path grows by ~140 orders *per sweep and never converges* — at the
default 60s period that is ~8,400 pointless orders an hour. The new path
converges on the first pass and stays flat.

This is not only a multi-tenant concern: a single user who added a second
strategy hit it too.

### How the merge behaves

- Opposing views on a symbol are netted; equal and opposite resolve to no order.
- Where strategies disagree on parameters the merged order takes the more
  conservative value (strictest minimum order size, tightest slippage band), so
  it never exceeds what any contributor would have accepted alone.
- Order attribution is exact only when one strategy drove a symbol. A netted
  order is recorded with `strategy_id = NULL` rather than inventing an owner,
  which would make per-strategy P&L wrong.

### Not yet done

- **Per-strategy P&L is not attributed through netted orders.** `totalPnl`,
  `allocatedPnl` etc. are still unwritten.
- **Rate limiting is coarse.** Accounts reconcile with a bounded concurrency
  (`MAX_CONCURRENCY`) but there is no shared backoff, and Hyperliquid limits by
  IP — so all accounts share one budget.
- **Paper books are in-memory**, so they reset on restart.

### Other known gaps

- **Approval is not yet wired into the web app.** The CLI and SDK call are
  ready; the browser step (`approveAgent` from the user's master wallet) still
  needs a UI hook.
- **`copy_positions` is only synced in live mode** (paper positions are
  in-memory), and P&L accrual (`totalPnl`, `allocatedPnl`) remains unwritten.
- **Paper fills are tagged via `error_code='paper'`** rather than a real column —
  worth promoting to a column before production.
- **No kill switch yet.** `LIVE=0` and stopping the process are the current
  controls; a runtime halt belongs here before this runs unattended.
