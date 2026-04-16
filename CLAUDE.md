# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install      # install dependencies
npm start        # run 15m assistant (node src/index.js)
npm run start:5m # run 5m assistant  (node src/index5m.js)
```

No test runner or linter is configured. The project uses ES modules (`"type": "module"` in package.json).

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
- **edge.js** — Compares model probability vs Polymarket market price to compute edge. `decide` uses phase-dependent thresholds (EARLY/MID/LATE) to emit `ENTER` or `NO_TRADE`. *(15m)*
- **edge5m.js** — Re-exports `computeEdge`; `decide5m` uses 5m-tuned phases (EARLY >3m / MID >1.5m / LATE) and lower thresholds. *(5m)*

### Main loops

Thin orchestrators — each one initializes mode-specific streams, computes mode-specific indicators/signals, then delegates all shared concerns to the trading modules below.

- **index.js** (15m) — Starts Binance trade stream + Polymarket live WS + Chainlink WS; indicator pipeline: VWAP, RSI, MACD, Heiken Ashi, regime; logs to `./logs/signals.csv`.
- **index5m.js** (5m) — Starts Binance OFI stream + Polymarket live WS + Chainlink WS; indicator pipeline: short VWAP, RSI(5), EMA cross, momentum, order flow; logs to `./logs/signals_5m.csv`.

### Configuration (`src/config.js`, `src/config5m.js`)

All tunable parameters (poll interval, TA periods, Polymarket series IDs, RPC URLs) live here and are read from environment variables with defaults. `config5m.js` extends the base config with 5m-tuned values (RSI period 5, VWAP window 10 candles, EMA 3/8).

### Trading (`src/trading/`)

Optional live-trading integration using `@polymarket/clob-client` SDK. Enabled when `POLYMARKET_PRIVATE_KEY` is set; otherwise the app runs in read-only mode.

All modules are reusable by future bots targeting other markets or strategies.

- **client.js** — Initializes `ClobClient` with L1 (EIP-712) + L2 (HMAC) auth. Derives API credentials on first run via `createOrDeriveApiKey()`. Caches the client singleton. Auto-detects `POLY_GNOSIS_SAFE` when `POLYMARKET_SIGNATURE_TYPE=1` but the funder address is a GnosisSafe contract. Exposes `balanceAddress` (funder or EOA) for USDC balance queries.
- **orders.js** — `buyMarketOrder()` and `sellMarketOrder()` wrappers around `client.createAndPostMarketOrder()` using `OrderType.FAK` (Fill and Kill — partial fills accepted). Buy price = `bestAsk + 0.02`; sell price = `bestBid - 0.02`, both clamped to valid range. Returns `{ ok, order }` or `{ ok: false, error }`.
- **position.js** — In-memory position state: `recordBuy()`, `recordSell()`, `getPosition()`, `computeROI()`, `resetIfMarketChanged()`. `fetchPositionBalance()` syncs shares from chain via `getBalanceAllowance()` (used before selling to get actual on-chain balance). `fetchUsdcBalance(address)` reads USDC.e balance directly from Polygon blockchain (not the CLOB API, which only tracks deposited collateral). `evaluateExit()` recommends exits: TP triggers when model confirms reversal (`oppositeProb >= signalFlipMinProb`); SL requires a stricter `stopLossMinProb` threshold AND the position to have aged at least `stopLossMinDurationS` seconds (both configurable, 5m uses tighter values); TIME_DECAY only applies when entry price ≥ 0.50 (cheap entries are held to resolution).
- **keyboard.js** — `setupKeyboard({ tradingEnabled })` sets up stdin raw mode and returns `{ actionQueue, getConfirmHint(ctx), stdinError }`. The action queue is drained each tick by the executor. `getConfirmHint` builds the [Y]/[N] confirmation line shown on the display.
- **executor.js** — `processActionQueue(queue, ctx)` drains the keyboard action queue and executes buy/sell orders: selects side, picks bestAsk/bestBid with slippage, calls `buyMarketOrder`/`sellMarketOrder`, fetches on-chain balance, calls `recordBuy`/`recordSell`, logs errors to `./logs/trade_errors.log`. Calls optional `onSold` callback after a successful sell.
- **priceLatch.js** — `createPriceLatch()` returns `{ update(ctx) }`. Manages the state machine that latches the Chainlink BTC/USD reference price at market open (used as the "price to beat" on the display). Reads from the market object first, then fetches historical Chainlink if the app started late (>30s after open), otherwise latches the live price.
- **redeem.js** — `redeemSettledPositions({ wallet, conditionId, marketSlug })`. Called automatically on every market slug change when `tradingEnabled` is true. Calls `ConditionalTokens.redeemPositions(USDC_E, ZERO_BYTES32, conditionId, [1, 2])` on Polygon to convert any winning tokens back to USDC. Redeeming both index sets is safe: the CTF contract pays out only for positions actually held; losing tokens return $0. Logs to `./logs/trade_orders.log`. Fire-and-forget — does not block the poll loop.
- **tracker.js** — `createTradeTracker()` returns `{ update(ctx), getStats(), getRecentOutcomes() }`. Tracks the first signal seen per market; when the market slug changes (settlement), computes win/loss and P&L based on the final Chainlink price vs the latched reference. Returns a `settled` object from `update()` so the caller writes it to the CSV in its own format.

Both main loops listen for keypresses when trading is enabled: **[B]** buy the recommended side, **[S]** sell 100% of position, **[Q]** quit. Actions are queued and processed inside the main loop where market data is available.

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
| `POLYMARKET_PRIVATE_KEY` | — | Polygon wallet private key (enables trading) |
| `POLYMARKET_FUNDER` | (derived from key) | Polymarket profile address (proxy/GnosisSafe wallet) |
| `POLYMARKET_SIGNATURE_TYPE` | `0` | `0`=EOA, `1`=POLY_PROXY (auto-detects GnosisSafe), `2`=GNOSIS_SAFE |
| `POLYMARKET_TRADE_AMOUNT` | `5` | USDC amount per trade |
| `DRY_RUN` | `false` | Set to `true` to run in paper-trading-only mode (no real orders, no redemption, even if private key is set) |
| `TRADE_TAKE_PROFIT_PCT` | `20` | ROI % to recommend take-profit (requires model reversal) |
| `TRADE_STOP_LOSS_PCT` | `25` | ROI % loss to recommend stop-loss (requires model reversal) |
| `TRADE_SIGNAL_FLIP_PROB` | `0.58` (15m) / `0.62` (5m) | Min opposite-side probability to consider model reversed |
| `TRADE_SL_MIN_PROB` | `0.65` | Min opposite-side probability specifically to trigger stop-loss (can be stricter than flip prob) |
| `TRADE_SL_MIN_DURATION_S` | `120` | Minimum seconds a position must be held before stop-loss can fire |
| `TRADE_FLIP_COOLDOWN_S` | `60` (15m) / `90` (5m) | Seconds to wait after a SIGNAL_FLIP before re-entering the same market |
| `TRADE_FLIP_CONFIRM_TICKS` | `2` (15m) / `5` (5m) | Consecutive confirming ticks required before SIGNAL_FLIP exit fires |

## Output

- Terminal screen refreshed every second via ANSI escape codes (`\x1b[H` + per-line `\x1b[K` + `\x1b[J`), rendered inside an alternate screen buffer.
- `./logs/signals.csv` — one row per poll tick (15m mode) with regime, signal, model probabilities, market prices, edge, and recommendation.
- `./logs/signals_5m.csv` — one row per poll tick (5m mode) with OFI, momentum, EMA cross, RSI, model probs, edge, and recommendation.
- `./logs/dryrun_15m.csv` — paper-trading tick-by-tick log for the 15m app (see below).
- `./logs/dryrun_5m.csv` — paper-trading tick-by-tick log for the 5m app (see below).
- `./logs/dryrun_15m_trades.csv` — per-trade journal (one row per completed trade) for 15m.
- `./logs/dryrun_5m_trades.csv` — per-trade journal (one row per completed trade) for 5m.
- `./logs/polymarket_market_<slug>.json` — raw Polymarket market JSON dumped once per new market slug.

### Paper-trading simulator (`src/dryRun.js`)

Enabled automatically in both apps — no extra flags needed. Each app creates one simulator at startup:

```
createDryRunSimulator15m("./logs/dryrun_15m.csv", CONFIG.trading)  // used by index.js
createDryRunSimulator5m("./logs/dryrun_5m.csv", CONFIG.trading)    // used by index5m.js
```

**How it works:** the simulator maintains a virtual position and mirrors real trading logic:

1. **BUY** — when the bot emits an `ENTER` signal and no virtual position is open, it simulates a buy at the current market price (using `CONFIG.trading.tradeAmount` as the virtual investment).
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

**Stop-loss guards (15m):** the 15m simulator uses `stopLossMinProb = 0.65` (stricter than the `signalFlipMinProb` gate) and `stopLossMinDurationS = 120` to avoid being stopped out in the first ~2 minutes of a volatile move.

**Signal-flip (5m — disabled):** `disableSignalFlip = true`. A 5-day dry-run showed 158 SIGNAL_FLIP exits with only 3.8% winning — the lower threshold was catching transient blips across 0.58 that then reverted, cutting positions that would have settled as wins.

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
