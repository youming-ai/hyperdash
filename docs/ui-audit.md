# HyperDash Web — UI review & redesign

Date: 2026-09-10 · Scope: `apps/web` · Reference: hyperdash.com (tokens measured in-browser)

## Method

Every claim below was measured, not eyeballed. A headless Chrome instance was driven
over CDP to load each route, wait for data, then evaluate computed styles: WCAG
contrast ratios (with alpha compositing through the ancestor chain), horizontal
overflow offenders, the full font-size / radius / colour census, interactive-target
sizes, table semantics and landmark structure. Seven routes × three viewports
(375 / 768 / 1440) × two themes = 42 measured combinations. The reference site was
probed with the same instrumentation so its palette and metrics are real values, not
guesses.

## What was actually wrong

### 1. There was no design system

`styles.css` contained only `@import "tailwindcss"` — no `@theme` block. Tailwind v4
therefore never generated the semantic utilities. Verified live:

```
bg-primary  bg-muted  bg-accent  bg-popover  bg-success  bg-warning
text-muted-foreground  text-card-foreground  border-input  ring-ring
→ all computed to background-color: rgba(0,0,0,0)   (empty classes)
```

The consequence: `components/ui/{button,card,badge}.tsx` (shadcn-shaped but never
wired to a theme) were visually inert, and the one route that used them rendered a
primary CTA with no background at all. Meanwhile 108 call sites bypassed them with
`text-[hsl(var(--fg-accent))]`-style arbitrary values.

### 2. The fonts were declared but never loaded

`font-family: "Geist", "Geist Mono"` with **zero** font files, **zero** `@font-face`
rules and `document.fonts` empty. The entire brand typography was falling back to the
OS font. The reference site really does load BDO Grotesk + Geist Mono.

### 3. Two oranges, and every surface a step too dark

| Role | hyperdash.com (measured) | Was |
| --- | --- | --- |
| Solid button | `#fd4612` | `#e33b0d` — not in the palette |
| Accent text | `#fd5e32` | `#ed3602` — a third orange |
| Page | `rgb(20,18,16)` | `rgb(16,14,10)` — one step darker |
| Panel | `rgb(25,22,19)` | `rgb(20,18,16)` — the reference's *page* colour |
| Hairline | `rgba(255,255,255,.04)` | opaque grey `#262422` |

The foreground greys and the `#5cc09b` / `#d44b62` direction colours were already
correct — that part of the original port was right.

### 4. No type or radius scale

Eight font sizes per page, six radii on a single screen (`0/4/6/8/12/999`). Each route
had its own set:

```
/           14 12 13 10.5 11 15 12.5 11.5     (8 sizes)
/terminal   14 12 12.5 18 10 15 10.5 24
/traders    12 14 12.5 10.5 15 20 13
/analytics  12.5 14 10.5 15 24 12
/strategies 14 12.5 11 24 15 10.5 30
```

### 5. Contrast failed in both themes

11 violations dark, 11 light. Systematic causes: `--fg-quaternary #726e68` on
`#141210` = 3.7:1 (used for market volume, footers, card links); white on the orange
= 4.29:1 (every primary button); and in light mode `--success` green on white =
**3.4:1**, so every green price and PnL failed.

### 6. Three routes were permanently stuck on "Loading…"

`/traders`, `/traders/$address` and `/strategies` never resolved. Root cause was in
the data layer, not the UI: the Hyperdrive `localConnectionString` in
`apps/api/wrangler.toml` and `apps/web/wrangler.toml` used role
`hyperdash:hyperdash_password`, but compose only defines `postgres:postgres` — the
`hyperdash` role does not exist, so every DB-backed endpoint returned 500. The market
endpoints proxy the public Hyperliquid API directly, which is why the site looked
partly alive and hid the failure.

Compounding it, **no query had an error branch**, and several fetchers actively
resolved failures into empty arrays (`if (!res.ok) return { metas: [] }`,
`catch { return [] }`). `isError` was therefore unreachable and every outage rendered
as a legitimate empty state — the traders page told users to "wait for the
auto-ingest cycle" during a 500.

### 7. Confirmed bugs found while measuring

- **Order book "Spread" row displayed the mid price**, not ask − bid.
- **Open interest was rendered as USD but is denominated in coin units.** BTC showed
  `$35.5K` (real notional `$2.77B`), and because the table sorted on the raw field,
  high-supply memecoins ranked above BTC — under a heading reading "Top N markets by
  open interest".
- **Candlestick y-axis labels did not match their gridlines**; the tick price was
  round-tripped through two different offsets.
- **The heatmap time axis was computed and thrown away** — columns were used only for
  their `.length`, so no cell said which hour it was.
- **The primary CTA on `/strategies/new` collapsed to 19px tall on phones**: `flex-1`
  inside a `flex-col` parent makes the flex main axis vertical, so `flex-basis: 0`
  beat `h-9`.
- `$-1,234` (sign between symbol and digits) and `+-500` rendered in green.
- Dead controls: Pause/Resume with no `onClick`, "Copy This Trader" with no handler,
  "Edit Settings" silently starting a *new* strategy.
- `alert()` used for all form validation; toggles whose label sat outside the
  `<label>`; ~960 heatmap cells with no text alternative.
- Sharpe and max-drawdown columns rendered `0.00` for every one of 79 rows (the
  columns are constant in the database) — a display-honesty problem the UI now
  handles by rendering `—` rather than a confident zero.

## What changed

**Design system (`src/styles.css`)** — a real `@theme inline` bridge, self-hosted Geist
+ Geist Mono variable fonts (54KB total, SIL OFL), a 9-step type ramp, 4/6/8 radii, a
warm-gray surface ladder calibrated to the reference, and translucent hairlines that
composite correctly on every surface tier.

**Contrast** — every foreground/background pair was solved numerically before being
written. Two deliberate departures from the reference: the solid accent is `#cf3406`
rather than its `#ed3602` (which measures 4.09:1 with white text; `#cf3406` measures
5.06:1, and its hover state `#d8380a` measures 4.68:1 so the hover also clears AA),
and dark-mode rose is `#e2657c` rather than its `#d44b62` (4.27:1 on a panel). Both are
documented inline with their measured ratios.

**Component layer** — `Panel`, `PageHeader`, `StatCard/StatGrid`, `Segmented`
(WAI-ARIA tablist with roving tabindex and arrow keys), `Th/Td/TableWrap` (`scope`,
`aria-sort`, focusable scroll regions), `PanelState` for loading/empty/error,
`AddressText`, `Badge`, `Button`. Deleted the dead `DataTable`, `VirtualTradeList`,
`generateMockTrades` and the broken `card.tsx`.

**Honest states** — `readJson()` and the feed client now throw; every query renders
three distinct branches. An outage can no longer be mistaken for "no data".

**App shell** — one navigation instead of two (the icon rail duplicated the topbar's
list), one container width across all routes, plus `errorComponent` /
`notFoundComponent` so a render failure is themed rather than raw.

**Pages** — `/` is now a market dashboard (was a marketing page competing with
Terminal in the nav); Terminal is restructured so the chart is no longer the third
block below the fold on small screens; Analytics tabs are URL-addressable; tables
gained sticky identity columns, real sort semantics and mobile affordances.

## Header right side (follow-up review)

A dedicated audit of the top bar's right cluster found four defects, all now fixed.

**Measured before:** the theme toggle was `32×32`, RainbowKit's stock ConnectButton was
`126×40`, and a second auth control was `57×28` — three heights in one 52px bar, so the
row never lined up. Worse, that third control was a **permanently disabled "Sign in"**
rendered for every disconnected visitor, sitting immediately beside "Connect Wallet":
two competing CTAs for a single intent, and a disabled control is unreachable by
keyboard, so its explanatory `aria-label` was dead weight. Two `ConnectButton`
instances were also mounted at once (one `display:none`), doubling the wagmi/RainbowKit
subtree.

| | before | after |
| --- | --- | --- |
| Theme toggle | `32×32` @y10 | `32×32` @y10 |
| Wallet control | `126×40` @y6 | `91×32` @y10 |
| Auth control | `57×28`, disabled, always shown | only when a wallet is connected |
| Row alignment | 3 heights, 3 offsets | 1 height, 1 offset |
| Stock RainbowKit buttons | 2 mounts | 0 (fully custom) |

The fixes:

1. **One wallet control at the system's size.** A new `WalletButton` uses
   `ConnectButton.Custom` to render a 32px control from the shared `Button` primitive, so
   it matches the theme toggle. Beyond alignment this removes a real theming bug:
   RainbowKit's stock "wrong network" state is a hardcoded blue (`#1d4ed8`) that ignored
   both themes, and its own palette was not token-driven. A single instance now covers
   every breakpoint, replacing the two mounted copies.
2. **The disabled "Sign in" is gone.** `AuthButton` returns `null` until a wallet is
   connected, so disconnected visitors see exactly one CTA.
3. **The sign-in error no longer lives in the layout flow.** It was inline text with
   `max-w-[220px]`, which could stretch the header; it is now an absolutely positioned,
   dismissible alert anchored under the button.
4. **Sign-out reports failure.** `useAuth.signOut` had no `try/catch`, so a failed
   sign-out was a silent no-op that left the session cookie live while the UI implied
   otherwise. It now surfaces the error, always disconnects locally, and exposes
   `isSigningOut` for a pending state.

The solid accent was also deepened from `#d93a08` (4.61:1) to `#cf3406` (5.06:1) for
margin above the AA line, with the hover state verified too.

## Verification

- `bunx tsc --noEmit` → **0 errors**
- `bunx biome check apps/web/src` → **clean** (0 errors, 0 warnings)
- `bun test src/` → **29 pass, 0 fail**
- `bun run build` → **success**, 8 pages prerendered, tokens and both fonts present in
  the emitted bundle, `html.light` override block intact
- Re-audit, 42 combinations: **0 contrast violations, 0 horizontal overflow,
  0 off-scale font sizes**; smallest interactive target is 24×24 (WCAG 2.5.8 AA)

## Known remaining work

- **Data quality, not UI.** `sharpe_ratio` and `max_drawdown` are constant across all
  79 `trader_stats` rows, `pnl_7d == pnl_30d` for 65 of 79, and zero traders are
  active within 7 days. The UI now degrades honestly (`—`, neutral tones, empty-state
  copy) but the 7D/30D/All tabs and the Sharpe/DD columns stay close to meaningless
  until the ingestion pipeline computes them.
- **AI-annotated columns**: `/analytics` "OI 24H" is populated only from recorded feed
  history, so it shows `—` until the recorder has been running.
- **Feed REST host.** `/feed/history/*` and `/feed/whales` are served by the
  *api-gateway* service (port 3000), while the browser's socket points at the ingest
  hub (3001). Analytics panels therefore error out unless `VITE_FEED_REST_URL` is set.
  The client now says so explicitly instead of rendering an empty heatmap.
- Two lint fixes belong to a concurrent branch: `apps/api/src/server/routers/user.ts`
  has an unorganised import, and the `agent-wallets` router imports
  `ENCRYPTION_KEY`, which the local `.dev.vars` must supply.
