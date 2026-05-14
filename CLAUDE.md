# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install      # install dependencies
npm start        # run 15m assistant (node src/index.js)
npm run start:5m # run 5m assistant  (node src/index5m.js)
```

No test runner or linter is configured. The project uses ES modules (`"type": "module"` in package.json).

## Dashboard UI components (`dashboard/src/components/ui/`)

The dashboard uses **shadcn/ui** (new-york style, Tailwind v4, React 19). All UI primitives live in `dashboard/src/components/ui/`.

### Adding new components

`npx shadcn@latest add <component>` **does not work** in this environment — the process has no outbound internet access and the CLI returns 403 when fetching from `ui.shadcn.com/r`.

When a component is needed that isn't already in `dashboard/src/components/ui/`, write it manually following the exact same pattern as the existing files:

- Import Radix primitives from `"radix-ui"` (not from individual `@radix-ui/react-*` packages directly), e.g. `import { Checkbox as CheckboxPrimitive } from "radix-ui"`
- Use `cn()` from `@/lib/utils` for class merging
- Apply shadcn new-york design tokens (`border-input`, `bg-primary`, `ring-ring/50`, `data-[state=*]:…`, etc.)
- Export a named function component (no default exports)
- Add `data-slot="<name>"` to the root element

The shadcn source for any component can be found at `https://github.com/shadcn-ui/ui/tree/main/apps/www/registry/new-york-v4/ui` for reference.

### Do not use bare HTML form elements in routes or feature components

Always use the shadcn wrapper components instead of raw HTML:

| Avoid | Use instead |
|---|---|
| `<input type="checkbox">` | `<Checkbox>` from `@/components/ui/checkbox` |
| `<input type="text">` | `<Input>` from `@/components/ui/input` |
| `<button>` | `<Button>` from `@/components/ui/button` |

`input.tsx` itself wraps a native `<input>` — that is correct and intentional (it is the shadcn component). Using a native element *outside* of a `ui/` wrapper component is the anti-pattern to avoid.

## Architecture

This is a single-process real-time console assistant for Polymarket BTC 15-minute prediction markets. It polls every 1 second and redraws a static terminal screen using ANSI escape codes + `readline`.

### Data layer (`src/data/`)

- **binance.js / binanceWs.js** — Binance REST (klines, last price) and WebSocket trade stream for live spot price.
- **polymarket.js** — Gamma API + CLOB API. Reusable functions: `createMarketResolver(polyConfig, pollIntervalMs)` returns a cached async resolver; `fetchPolymarketSnapshot(resolveMarket, polyConfig)` returns `{ ok, market, tokens, prices, orderbook }` — the canonical way for any app to get live market state.
- **polymarketLiveWs.js** — Polymarket live WebSocket (`wss://ws-live-data.polymarket.com`); primary source for the Chainlink BTC/USD price shown on Polymarket UI.
- **chainlink.js / chainlinkWs.js** — Fallback: reads Chainlink BTC/USD aggregator on Polygon via HTTP RPC or WSS RPC using ethers v6.

Price source priority: `polymarketLiveWs` → `chainlinkWs` → `chainlink` HTTP fetch.

### Shared display (`src/display.js`)

All terminal rendering helpers (ANSI colors, `kv()`, `renderScreen()`, `colorPriceLine()`, `fmtEtTime()`, `fmtEtHHMM()`, etc.) shared by both 15m and 5m modes. `renderScreen()` enters the terminal alternate screen buffer on first call (so the title always appears at row 1) and truncates output to `process.stdout.rows - 1` lines to prevent scroll overflow. Restores the normal screen on exit/SIGINT/SIGTERM.

### Indicators (`src/indicators/`)

Pure functions operating on arrays of OHLCV candles (Binance 1m klines):
- **heikenAshi.js** — Heiken Ashi candles + consecutive same-color count.
- **rsi.js** — RSI, SMA helper, slope of last N values.
- **macd.js** — MACD line, signal, histogram, histogram delta. *(15m only)*
- **vwap.js** — Session VWAP (scalar) and VWAP series (per-candle).
- **orderFlow.js** — Order Flow Imbalance scoring from real-time trade data. *(5m only)*
- **emaCross.js** — Fast EMA(3)/EMA(8) crossover, replaces MACD for short timeframes. *(5m only)*
- **momentum.js** — Rate of change (1m/3m), acceleration, volume surge. *(5m only)*

### Engines (`src/engines/`)

- **regime.js** — Classifies market as `TREND_UP`, `TREND_DOWN`, `RANGE`, or `CHOP` based on price vs VWAP, VWAP slope, VWAP cross count, and volume. *(15m only)*
- **probability.js** — `scoreDirection`: additive scoring model (up/down integer scores) from VWAP, RSI, MACD, Heiken Ashi, failed VWAP reclaim; normalizes to 0–1. `applyTimeAwareness`: decays signal toward 50% as remaining time shrinks. *(15m)*
- **probability5m.js** — `scoreDirection5m`: primary signals are order flow + momentum + EMA cross; secondary: RSI(5), HA (relaxed), short VWAP. `applyTimeAwareness5m`: quadratic decay (exponent 0.6). *(5m)*
- **edge.js** — Compares model probability vs Polymarket market price to compute edge. `decide` uses phase-dependent thresholds (EARLY/MID/LATE) to emit `ENTER` or `NO_TRADE`. Accepts `regime` and `blockedRegimes` params: returns `NO_TRADE` (reason `regime_chop` / `regime_range`) before any other check when the current regime is in the blocked list. Default blocked regimes: `CHOP`, `RANGE`. *(15m)*
- **edge5m.js** — Re-exports `computeEdge`; `decide5m` uses 5m-tuned phases (EARLY >3m / MID >1.5m / LATE) and lower thresholds. OFI alignment filter: rejects entry when `ofi_1m` contradicts the chosen direction (`ofi_1m < -0.05` for UP, `ofi_1m > 0.05` for DOWN), returning `NO_TRADE` with reason `ofi_conflict`. Previously required both HA and OFI to disagree; OFI alone is now sufficient since it is the primary 5m signal. *(5m)*

### Main loops

Thin orchestrators — each one initializes mode-specific streams, computes mode-specific indicators/signals, then delegates all shared concerns to the trading modules below.

- **index.js** (15m) — Starts Binance trade stream + Polymarket live WS + Chainlink WS; indicator pipeline: VWAP, RSI, MACD, Heiken Ashi, regime; logs to `./logs/signals.csv`.
- **index5m.js** (5m) — Starts Binance OFI stream + Polymarket live WS + Chainlink WS; indicator pipeline: short VWAP, RSI(5), EMA cross, momentum, order flow; logs to `./logs/signals_5m.csv`.

### Configuration (`src/config.js`, `src/config5m.js`)

All tunable parameters (poll interval, TA periods, Polymarket series IDs, RPC URLs) live here and are read from environment variables with defaults. `config5m.js` extends the base config with 5m-tuned values (RSI period 5, VWAP window 10 candles, EMA 3/8).

### Trading (`src/trading/`)

Optional live-trading integration using the `@polymarket/clob-client-v2` SDK (CLOB V2, live on Polygon since 2026-04-28; the legacy `@polymarket/clob-client` is not supported by the production exchange). Enabled when `POLYMARKET_PRIVATE_KEY` is set; otherwise the app runs in read-only mode. Collateral is **pUSD** (`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`), a 1:1 USDC-backed ERC-20; the old USDC.e flow is no longer used.

All modules are reusable by future bots targeting other markets or strategies.

- **client.js** — Initializes V2 `ClobClient` with L1 (EIP-712) + L2 (HMAC) auth. Constructor takes a destructured options object (`{ host, chain, signer, creds, signatureType, funderAddress }`). Signer is an ethers v6 `Wallet` with a `_signTypedData` shim that delegates to v6's `signTypedData` (the V2 SDK expects the ethers-v5-style underscore method or a viem `WalletClient`). `SignatureTypeV2` enum: `0=EOA`, `1=POLY_PROXY` (email/magic-auth proxy), `2=POLY_GNOSIS_SAFE` (Gnosis Safe owned by an EOA), `3=POLY_1271` (Polymarket smart-wallet that verifies via EIP-1271, e.g. accounts created by connecting Phantom or other non-Metamask wallets — funder has `owner()` returning the EOA and an `isValidSignature` method). Derives API credentials on first run via `createOrDeriveApiKey()`. Caches the client singleton. Auto-detects the funder shape when `POLYMARKET_SIGNATURE_TYPE=1`: probes the contract for `isOwner(address)` (→ GnosisSafe) and falls back to `owner()` matching the EOA (→ POLY_1271). Exposes `balanceAddress` (funder or EOA) for pUSD balance queries.
- **orders.js** — `buyMarketOrder()` and `sellMarketOrder()` wrappers around `client.createAndPostMarketOrder()` using `OrderType.FAK` (Fill and Kill — partial fills accepted). Buy price = `bestAsk + 0.02`; sell price = `bestBid - 0.02`, both clamped to valid range. Returns `{ ok, order }` or `{ ok: false, error }`.
- **position.js** — In-memory position state: `recordBuy()`, `recordSell()`, `getPosition()`, `computeROI()`, `resetIfMarketChanged()`. `fetchPositionBalance()` syncs shares from chain via `getBalanceAllowance()` (used before selling to get actual on-chain balance). `fetchCollateralBalance(address)` reads pUSD balance directly from Polygon (not the CLOB API, which only tracks deposited collateral). `evaluateExit()` recommends exits: TP triggers when model confirms reversal (`oppositeProb >= signalFlipMinProb`); SL requires a stricter `stopLossMinProb` threshold AND the position to have aged at least `stopLossMinDurationS` seconds (both configurable, 5m uses tighter values); TIME_DECAY only applies when entry price ≥ 0.50 (cheap entries are held to resolution).
- **executor.js** — `executeRealBuy(ctx)` and `executeRealSell(ctx)` send orders to the CLOB **only** when the dry-run simulator decided to enter or exit on the same tick (the sim already enforced every entry/exit gate). The only extra check here is a slippage guard: if the live `bestAsk`/`bestBid` drifted more than `trading.slippageTolerancePct` (default 2%) from the price the sim used for its decision, the order is skipped and the sim still records the virtual trade. Logs every order intent and outcome to `./logs/trade_orders.log` and errors to `./logs/trade_errors.log`. There is no keyboard / `actionQueue` path — the bot is fully autonomous; the prior `setupKeyboard` / `processActionQueue` code was removed in favour of the sim-driven dispatch.
- **realTradeLog.js** — `createRealTradeLogger(csvPath)` writes one row per completed real trade to `./logs/real_{15m,5m}_trades.csv` (schema identical to the dryrun trades CSV). `recordEntry(ctx)` caches the pending entry in memory; `recordExit(ctx)` flushes a full row. `getPending()` exposes the pending entry so the main loop can finalize it with a `SETTLED_WIN` / `SETTLED_LOSS` row on market settlement.
- **priceLatch.js** — `createPriceLatch()` returns `{ update(ctx) }`. Manages the state machine that latches the Chainlink BTC/USD reference price at market open (used as the "price to beat" on the display). Reads from the market object first, then fetches historical Chainlink if the app started late (>30s after open), otherwise latches the live price.
- **redeem.js** — `redeemSettledPositions({ wallet, conditionId, marketSlug })`. Called automatically on every market slug change when `tradingEnabled` is true. Calls `ConditionalTokens.redeemPositions(pUSD, ZERO_BYTES32, conditionId, [1, 2])` on Polygon to convert any winning tokens back to pUSD. The CTF contract address (`0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`) is unchanged across the V1→V2 migration; only the `collateralToken` argument moved from USDC.e to pUSD. Redeeming both index sets is safe: the CTF contract pays out only for positions actually held; losing tokens return $0. Logs to `./logs/trade_orders.log`. Fire-and-forget — does not block the poll loop.
- **tracker.js** — `createTradeTracker()` returns `{ update(ctx), getStats(), getRecentOutcomes() }`. Tracks the first signal seen per market; when the market slug changes (settlement), computes win/loss and P&L based on the final Chainlink price vs the latched reference. Returns a `settled` object from `update()` (now including a `winner` field) so the caller writes the row to its own CSV and closes any pending real-trade journal entry with `SETTLED_WIN` / `SETTLED_LOSS`.

The bots run **fully autonomously**: every tick the dry-run simulator decides whether to BUY, HOLD, SELL or WAIT; when live trading is enabled, the main loop mirrors that decision on the real exchange via `executeRealBuy`/`executeRealSell`. There is no keyboard input or human-in-the-loop confirmation step.

### Dashboard server (`src/logServer.js`)

Node.js HTTP server (no Express) serving the React dashboard and a JSON API over the log files. Started separately from the bots.

**Auth (better-auth + Drizzle + SQLite):** every `/api/*` route except `/api/auth/*` and `/api/health` requires an authenticated session cookie. better-auth lives in `src/auth/` (`instance.js`, `schema.js`, `db.js`, `migrate.js`, `seedAdmin.js`). The Drizzle schema is in `src/auth/schema.js` and migrations in `drizzle/`. The database is a single SQLite file (default `./logs/auth.db`, override with `SQLITE_PATH`) opened via `better-sqlite3` with WAL mode enabled — it lives in the same volume as the CSV logs so one persistent volume covers both. On boot the dashboard runs `runMigrations()` then `seedAdmin()` — the latter creates the admin user from `DASHBOARD_ADMIN_EMAIL`/`DASHBOARD_ADMIN_PASSWORD` (skipped if user exists, unless `DASHBOARD_ADMIN_RESET_PASSWORD=true`). Public sign-up is disabled (`disableSignUp: true`). The dashboard React app uses `better-auth/react` (`dashboard/src/lib/auth-client.ts`) and gates the layout in `dashboard/src/routes/__root.tsx` — unauthenticated users are redirected to `/login`. Required env vars on the dashboard container: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `AUTH_TRUSTED_ORIGINS`, `DASHBOARD_ADMIN_EMAIL`, `DASHBOARD_ADMIN_PASSWORD` (`SQLITE_PATH` is optional).

API endpoints:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/stats` | Aggregated `BotStats` for 15m and 5m |
| `GET` | `/api/trades/15m` | All rows from `dryrun_15m_trades.csv` |
| `GET` | `/api/trades/5m` | All rows from `dryrun_5m_trades.csv` |
| `GET` | `/api/live` | Last row of `dryrun_15m.csv` and `dryrun_5m.csv` |
| `GET` | `/api/files` | List of files in `logs/` with name, size, modified |
| `GET` | `/api/files/download?name=<file>` | Download a single log file |
| `GET` | `/api/files/zip` | Download all log files (≤50 MB each) as a ZIP |
| `POST` | `/api/logs/clear` | Archive current CSVs to `logs/archive/<timestamp>/`, then truncate each to its header row. Returns `{ ok, cleared[], archive }`. Affects: `dryrun_15m.csv`, `dryrun_5m.csv`, `dryrun_15m_trades.csv`, `dryrun_5m_trades.csv`, `signals.csv`, `signals_5m.csv`. |
| `GET` | `/api/health` | Public, unauthenticated. Returns `{ ok: true }`. Use as Coolify/Docker healthcheck URL. |
| `*` | `/api/auth/*` | Owned by better-auth (sign-in, sign-out, session, etc.). Public. |

### Proxy (`src/net/proxy.js`)

Called once at startup via `applyGlobalProxyFromEnv()`. Reads `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` and patches Node's global `fetch` dispatcher (via `undici`) and WebSocket connections to route through HTTP or SOCKS5 proxies.

## Key environment variables

| Variable | Default | Purpose |
|---|---|---|
| `POLYGON_RPC_URL` | `https://polygon-rpc.com` | Chainlink fallback HTTP RPC |
| `POLYGON_RPC_URLS` | — | Comma-separated list of fallback RPCs |
| `POLYGON_WSS_URLS` | — | WSS RPCs for real-time Chainlink fallback |
| `POLYMARKET_AUTO_SELECT_LATEST` | `true` | Auto-pick latest 15m market |
| `POLYMARKET_SLUG` | — | Pin a specific market slug |
| `POLYMARKET_5M_SERIES_ID` | (falls back to 15m series) | Series ID for 5m markets |
| `POLYMARKET_5M_SERIES_SLUG` | `btc-up-or-down-5m` | Series slug for 5m markets |
| `HTTPS_PROXY` / `ALL_PROXY` | — | Proxy for all outbound connections |
| `POLYMARKET_LIVE_TRADING` | `false` | **Sole gate** for real-money trading. `true` + a valid `POLYMARKET_PRIVATE_KEY` = real orders. Anything else = paper/simulated. Replaces the prior `DRY_RUN` flag (removed). |
| `POLYMARKET_PRIVATE_KEY` | — | Polygon wallet private key (required for real trading, ignored otherwise) |
| `POLYMARKET_FUNDER` | (derived from key) | Polymarket profile address (proxy/GnosisSafe wallet) |
| `POLYMARKET_SIGNATURE_TYPE` | `0` | `0`=EOA, `1`=POLY_PROXY (auto-detects GnosisSafe or POLY_1271 from funder shape), `2`=GNOSIS_SAFE (Metamask flow), `3`=POLY_1271 (Polymarket smart-wallet flow — Phantom/email-non-magic) |
| `POLYMARKET_TRADE_AMOUNT` | `5` | pUSD amount per trade |
| `TRADE_SLIPPAGE_TOLERANCE_PCT` | `0.02` | Max fractional drift between the sim's decision price and the live bestAsk/bestBid before a real order is skipped. `0.02` = 2%. |
| `TRADE_TAKER_BUFFER` | `0.05` | Absolute price buffer added to `bestAsk` on BUY (or subtracted from `bestBid` on SELL) when posting the FAK limit. A wider buffer keeps the order from being killed with "no orders found to match" when the book moves between snapshot and CLOB processing; it does not raise the actual fill price (slippage guard above remains the cap). `0.05` = 5¢. |
| `DASHBOARD_TRADE_SOURCE` | `sim` | Which trade journal the dashboard renders. `sim` reads `dryrun_{15m,5m}_trades.csv`; `real` reads `real_{15m,5m}_trades.csv`. Tick CSVs (`/api/live`) always come from the simulator. |
| `TRADE_TAKE_PROFIT_PCT` | `20` | ROI % to recommend take-profit (requires model reversal) |
| `TRADE_STOP_LOSS_PCT` | `25` | ROI % loss to recommend stop-loss (requires model reversal) |
| `TRADE_SIGNAL_FLIP_PROB` | `0.58` (15m) / `0.62` (5m) | Min opposite-side probability to consider model reversed |
| `TRADE_SL_MIN_PROB` | `0.65` | Min opposite-side probability specifically to trigger stop-loss (can be stricter than flip prob) |
| `TRADE_SL_MIN_DURATION_S` | `240` | Minimum seconds a position must be held before stop-loss can fire |
| `TRADE_FLIP_COOLDOWN_S` | `60` (15m) / `90` (5m) | Seconds to wait after a SIGNAL_FLIP before re-entering the same market |
| `TRADE_FLIP_CONFIRM_TICKS` | `2` (15m) / `5` (5m) | Consecutive confirming ticks required before SIGNAL_FLIP exit fires |
| `TRADE_ENTRY_MIN_PRICE` | `0.50` | 15m: minimum market price of chosen side to allow entry (raised from 0.45 — [0.45-0.50) band has <50% settlement win rate) |
| `TRADE_ENTRY_MAX_PRICE` | `0.58` | 15m: maximum market price of chosen side to allow entry |
| `TRADE_ENTRY_MIN_PRICE_5M` | `0.50` | 5m: minimum market price of chosen side to allow entry |
| `TRADE_ENTRY_MAX_PRICE_5M` | `0.52` | 5m: maximum market price of chosen side to allow entry (lowered from 0.60 — entries ≥ 0.52 were net-losers in dry-run analysis) |
| `TRADE_BTC_VS_PTB_MIN_USD` | `5` | 15m: skip entry when \|BTC − price_to_beat\| < this value (near-zero divergence = market undecided, 41.5% win rate). Set to `0` to disable. |
| `TRADE_DISABLE_TIME_DECAY` | `true` | 15m: disable TIME_DECAY early exits (143 exits cost −$139.86 while non-TD trades netted +$100.22 at 73.6% WR; hold-to-settlement dominant) |
| `TRADE_DISABLE_TIME_DECAY_5M` | `true` | 5m: disable TIME_DECAY early exits (433 exits cost −$159 vs −$5 from 165 settled trades; hold-to-settlement dominant) |
| `TRADE_BLOCKED_HOURS_UTC` | `0,8,9,11,17,18,19,21,22` | 15m: comma-separated UTC hours during which new entries are suppressed (dry-run analysis showed consistent negative PnL in these windows) |
| `TRADE_BLOCKED_HOURS_UTC_5M` | `2,3,4,6,10,16,19,20` | 5m: comma-separated UTC hours during which new entries are suppressed |
| `TRADE_BLOCKED_REGIMES` | `CHOP,RANGE` | 15m: comma-separated regime names that block entry; passed to `decide()` in edge.js; valid values: `TREND_UP`, `TREND_DOWN`, `RANGE`, `CHOP` |

## Output

- Terminal screen refreshed every second via ANSI escape codes (`\x1b[H` + per-line `\x1b[K` + `\x1b[J`), rendered inside an alternate screen buffer.
- `./logs/signals.csv` — one row per poll tick (15m mode) with regime, signal, model probabilities, market prices, edge, and recommendation.
- `./logs/signals_5m.csv` — one row per poll tick (5m mode) with OFI, momentum, EMA cross, RSI, model probs, edge, and recommendation.
- `./logs/dryrun_15m.csv` — paper-trading tick-by-tick log for the 15m app (see below).
- `./logs/dryrun_5m.csv` — paper-trading tick-by-tick log for the 5m app (see below).
- `./logs/dryrun_15m_trades.csv` — per-trade journal (one row per completed trade) for 15m.
- `./logs/dryrun_5m_trades.csv` — per-trade journal (one row per completed trade) for 5m.
- `./logs/polymarket_market_<slug>.json` — raw Polymarket market JSON dumped once per new market slug.
- `./logs/archive/<timestamp>/` — backup copies of CSV files created by `POST /api/logs/clear` before truncation.

### Paper-trading simulator (`src/dryRun.js`)

Enabled automatically in both apps — no extra flags needed. Each app creates one simulator at startup:

```
createDryRunSimulator15m("./logs/dryrun_15m.csv", CONFIG.trading)  // used by index.js
createDryRunSimulator5m("./logs/dryrun_5m.csv", CONFIG.trading)    // used by index5m.js
```

**How it works:** the simulator maintains a virtual position and mirrors real trading logic:

1. **BUY** — when the bot emits an `ENTER` signal and no virtual position is open, it simulates a buy at the current market price (using `CONFIG.trading.tradeAmount` as the virtual investment). The buy is suppressed if the market price falls outside `[entryMinMarketPrice, entryMaxMarketPrice]`, if the current UTC hour is in `blockedHoursUtc`, or (15m only) if `|btcPrice − priceToBeat| < btcVsPtbMinAbsUsd` — matching the same gates applied in live trading (`executor.js`).
2. **HOLD** — while a position is open, each tick evaluates exit conditions using the same `evaluateExit` logic as real trading (take profit, stop loss, signal flip, time decay).
3. **SELL** — when an exit condition triggers, the position is closed at the current market price. ROI and PNL are recorded.
4. **SETTLEMENT** — when the market slug changes (settlement), any open position resolves at $1 (if the held side won) or $0 (if it lost).

After selling, the simulator can re-enter on a new signal within the same market, subject to the post-flip cooldown.

**Exit conditions** (same as real trading):
| Condition | Trigger |
|---|---|
| `TAKE_PROFIT` | ROI ≥ `takeProfitPct` AND model confirms reversal (`oppositeProb >= signalFlipMinProb`) |
| `STOP_LOSS` | ROI ≤ `-stopLossPct` AND `oppositeProb >= stopLossMinProb` AND position age ≥ `stopLossMinDurationS` |
| `SIGNAL_FLIP` | Model opposite-side probability ≥ `signalFlipMinProb` (and no TP/SL threshold crossed) |
| `TIME_DECAY` | < 1.5 min left, losing > 5%, entry was ≥ 50¢ |
| `SETTLED_WIN` / `SETTLED_LOSS` | Market ended, position resolved |

**Post-flip cooldown:** after a `SIGNAL_FLIP` exit the simulator will not open a new position for `flipCooldownS` seconds (60s on 15m, 90s on 5m). The cooldown resets when a new market starts.

**Stop-loss (5m — disabled):** `disableStopLoss = true` in config5m.js. Analysis of 161 SL trades showed 78% correctly exited before a total loss, but the 22% that cut eventual winners cost far more than the savings: real SL PnL was −$75.65 vs hypothetical hold-to-settlement PnL of −$25.64 (+$50 left on the table). With an 85% settled win rate, holding to settlement is the dominant strategy on 5m.

**Stop-loss guards (15m):** the 15m simulator uses `stopLossMinProb = 0.65` (stricter than the `signalFlipMinProb` gate) and `stopLossMinDurationS = 240` to avoid being stopped out before the position has aged 4 minutes.

**Signal-flip (5m — disabled):** `disableSignalFlip = true`. A 5-day dry-run showed 158 SIGNAL_FLIP exits with only 3.8% winning — the lower threshold was catching transient blips across 0.58 that then reverted, cutting positions that would have settled as wins.

**Time-decay (5m — disabled):** `disableTimeDecay = true` in config5m.js. Cloud run analysis (2026-04-27 to 2026-04-29) showed 433 TIME_DECAY exits totalling −$159.63 while 161 SETTLED_WINs produced +$154.79 (97.6% settled win rate). Hold-to-settlement is the dominant strategy on 5m; TIME_DECAY destroys value by cutting positions that would have won.

**Output files:**

The tick CSV logs every second with all indicators + simulation state. The trades CSV logs one row per completed trade for easy analysis.

**Tick CSV simulation columns:**

| Column | Description |
|---|---|
| `sim_action` | `WAIT` (no position, no signal), `BUY`, `HOLD`, `SELL` |
| `sim_side` | `UP` or `DOWN` — which side is held |
| `sim_entry_price` | Price at which the virtual position was opened |
| `sim_current_price` | Current market price of the held side |
| `sim_roi_pct` | Current ROI % of the open position (or final ROI on SELL) |
| `sim_exit_reason` | Exit reason on SELL rows (TP, SL, FLIP, TIME_DECAY, SETTLED) |
| `sim_pnl` | Realized PNL in virtual USD (only on SELL rows) |
| `sim_cum_pnl` | Running cumulative PNL across all trades |
| `outcome` | `UP` or `DOWN` — which side actually won (retroactive) |
| `btc_at_settlement` | Final Chainlink BTC/USD price (retroactive) |

**Trades CSV columns:** `entry_time, exit_time, market_slug, side, entry_price, exit_price, shares, invested, exit_value, pnl, roi_pct, exit_reason, duration_s`

`process.on("exit")` flushes any in-progress market (settles open position) so data is not lost on Ctrl+C / Q.
