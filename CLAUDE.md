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
- **polymarket.js** — Gamma API + CLOB API: fetches the active 15m market, outcome token IDs, CLOB prices, and order books.
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

- **index.js** (15m) — Starts three WebSocket streams (Binance trades, Polymarket live, Chainlink), loops fetching klines + Polymarket snapshot, computes TA indicators, renders terminal screen, logs to `./logs/signals.csv`.
- **index5m.js** (5m) — Same structure but uses `binanceWsOfi.js` (order flow stream), 5m-specific indicators/engines, shorter VWAP window, logs to `./logs/signals_5m.csv`.

### Configuration (`src/config.js`, `src/config5m.js`)

All tunable parameters (poll interval, TA periods, Polymarket series IDs, RPC URLs) live here and are read from environment variables with defaults. `config5m.js` extends the base config with 5m-tuned values (RSI period 5, VWAP window 10 candles, EMA 3/8).

### Trading (`src/trading/`)

Optional live-trading integration using `@polymarket/clob-client` SDK. Enabled when `POLYMARKET_PRIVATE_KEY` is set; otherwise the app runs in read-only mode.

- **client.js** — Initializes `ClobClient` with L1 (EIP-712) + L2 (HMAC) auth. Derives API credentials on first run via `createOrDeriveApiKey()`. Caches the client singleton. Auto-detects `POLY_GNOSIS_SAFE` when `POLYMARKET_SIGNATURE_TYPE=1` but the funder address is a GnosisSafe contract. Exposes `balanceAddress` (funder or EOA) for USDC balance queries.
- **orders.js** — `buyMarketOrder()` and `sellMarketOrder()` wrappers around `client.createAndPostMarketOrder()` using `OrderType.FAK` (Fill and Kill — partial fills accepted). Buy price = `bestAsk + 0.02`; sell price = `bestBid - 0.02`, both clamped to valid range. Returns `{ ok, order }` or `{ ok: false, error }`.
- **position.js** — In-memory position state: `recordBuy()`, `recordSell()`, `getPosition()`, `computeROI()`, `resetIfMarketChanged()`. `fetchPositionBalance()` syncs shares from chain via `getBalanceAllowance()` (used before selling to get actual on-chain balance). `fetchUsdcBalance(address)` reads USDC.e balance directly from Polygon blockchain (not the CLOB API, which only tracks deposited collateral). `evaluateExit()` recommends exits: TP and SL only trigger when the model also confirms reversal (`oppositeProb >= signalFlipMinProb`); TIME_DECAY only applies when entry price ≥ 0.50 (cheap entries are held to resolution).

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
| `TRADE_TAKE_PROFIT_PCT` | `20` | ROI % to recommend take-profit (requires model reversal) |
| `TRADE_STOP_LOSS_PCT` | `25` | ROI % loss to recommend stop-loss (requires model reversal) |
| `TRADE_SIGNAL_FLIP_PROB` | `0.58` | Min opposite-side probability to consider model reversed |

## Output

- Terminal screen refreshed every second via ANSI escape codes (`\x1b[H` + per-line `\x1b[K` + `\x1b[J`), rendered inside an alternate screen buffer.
- `./logs/signals.csv` — one row per poll tick (15m mode) with regime, signal, model probabilities, market prices, edge, and recommendation.
- `./logs/signals_5m.csv` — one row per poll tick (5m mode) with OFI, momentum, EMA cross, RSI, model probs, edge, and recommendation.
- `./logs/polymarket_market_<slug>.json` — raw Polymarket market JSON dumped once per new market slug.
