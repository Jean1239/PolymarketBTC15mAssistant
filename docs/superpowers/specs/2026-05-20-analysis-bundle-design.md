# Analysis Bundle — Design

**Date:** 2026-05-20
**Status:** Approved (awaiting plan)
**Author:** brainstorming session with Claude

## Problem

Beyond the dashboard charts and aggregate stats, the user needs to perform deep, offline analysis of bot performance:

1. **Counterfactual backtesting** — re-enable disabled exits (`TAKE_PROFIT`, `STOP_LOSS`, `SIGNAL_FLIP`, `TIME_DECAY`) and replay against historical ticks to learn whether their removal was net-positive, without re-enabling them in production.
2. **Indicator hit-rate** — quantify how much each indicator contributes to win rate so weights in the scoring engines can be recalibrated.
3. **Strategy comparison** — compare metrics across two `config_hash` versions on the same period of market data.
4. **Real-trading drag** — measure the impact of fees and order-send delay between the simulator and the live exchange. The user suspects this is a large component of underperformance.

Python/Jupyter offline analysis was chosen as the host environment (numerically rich, plays well with `pandas` / `numpy` / `matplotlib`). The dashboard's job is to make it trivial to pull the exact set of files needed and nothing else.

## Goals

- One-click download of a per-bot "analysis bundle" ZIP from the dashboard.
- Bundle contains the minimum file set required to reproduce all four analyses above.
- A starter Jupyter notebook in the repo seeds the user with working code for each of the four use cases.

## Non-Goals

- A Python CLI (notebook is the sole entry point for now).
- Auto-tuning indicator weights via sklearn (deferred until manual hit-rate review is complete).
- Re-enabling disabled exits in production (deferred — decision driven by what the backtest reveals).
- Capturing order-book depth tick-by-tick (current logs only contain best bid/ask via `mkt_up` / `mkt_down`).

## Architecture

```
┌──────────────────────────┐        ┌──────────────────────────┐
│  Dashboard /files page   │        │  Local Jupyter session   │
│                          │        │                          │
│  [Download bundle] ──────┼─HTTPS──┼──>  bundle.zip           │
│                          │        │       │                  │
└──────────────────────────┘        │       ▼                  │
            │                       │  analysis/starter.ipynb  │
            │                       │       │                  │
            ▼                       │       ▼                  │
┌──────────────────────────┐        │  pandas / matplotlib     │
│  logServer.js            │        │                          │
│  GET /api/analysis-bundle│        └──────────────────────────┘
│   ?bot=15m|5m            │
│                          │
│  → ZIP stream:           │
│    - dryrun_{bot}.csv    │
│    - dryrun_{bot}_trades │
│    - real_{bot}_trades   │
│    - strategy_versions_  │
│      {bot}.json          │
│    - manifest.json       │
└──────────────────────────┘
```

The new endpoint reuses the same hand-rolled ZIP construction pattern already used by `/api/files/zip-selected` (no third-party `archiver` dependency — direct local-header / central-directory / EOCD writes with CRC32). No background jobs, no on-disk staging. The notebook runs entirely off the local copy of the ZIP — there is no Python ↔ server coupling.

## Components

### 1. Server endpoint — `GET /api/analysis-bundle?bot=15m|5m`

- **Auth:** same gate as the rest of `/api/*` (rejects unauthenticated with 401).
- **Validation:** missing or invalid `bot` → 400 with JSON error.
- **Behavior:**
  - Build the file list for the chosen bot. If a file is missing on disk, omit it but record the omission in `manifest.json`.
  - Generate `manifest.json` in memory and append to the archive.
  - Stream the ZIP back with `Content-Disposition: attachment; filename="polymarket-analysis-{bot}-{YYYYMMDD-HHMM}.zip"`.
- **Files included** (per bot):
  - `dryrun_{bot}.csv` — per-tick log (all indicators + sim state + retroactive outcome).
  - `dryrun_{bot}_trades.csv` — per-trade journal with `config_hash`.
  - `real_{bot}_trades.csv` — live-trading journal (always included when present; central to fee/delay analysis).
  - `strategy_versions_{bot}.json` — append-only registry that decodes `config_hash` → full config + label + detection time.
- **`manifest.json` schema:**

  ```json
  {
    "bot": "15m",
    "generatedAt": "2026-05-20T11:00:00Z",
    "tradeSource": "sim",
    "currentConfigHash": "abc123…",
    "files": [
      {
        "name": "dryrun_15m.csv",
        "bytes": 12345678,
        "rows": 432100,
        "firstTs": "2026-04-01T00:00:00Z",
        "lastTs": "2026-05-20T10:59:59Z"
      },
      …
    ],
    "missing": ["real_15m_trades.csv"]
  }
  ```

  `rows`, `firstTs`, `lastTs` are computed by streaming the file once during bundle construction (counts newlines + reads first/last data row).

### 2. Dashboard UI — `/files` page

- New primary button in the page header: **"Download analysis bundle (15m)"** (label tracks the selected bot from the existing `useSelectedBot` hook).
- Tooltip on the button lists the 4 files + manifest so the user knows what they're getting.
- The existing file list filters by the selected bot when one is active: any name containing `_{bot}` (e.g. `dryrun_15m_trades.csv`) plus the bot-specific `strategy_versions_{bot}.json`. A toggle ("Show all files") reverts to the full list for operational debugging.
- The existing `/api/files/zip` (full download) and per-file download remain available — this design adds, never removes.

### 3. Notebook starter — `analysis/starter.ipynb`

Located at the repo root, outside the Docker image. Runs locally against an unzipped bundle. Includes a sibling `analysis/requirements.txt` with `pandas`, `numpy`, `matplotlib`, `seaborn`.

Section breakdown:

1. **Load** — reads the manifest, loads each CSV / JSON with `pandas`, prints row counts and date ranges. Sanity-checks the bundle is complete.
2. **Decode strategy** — joins trade rows with `strategy_versions_{bot}.json` on `config_hash` to attach a human-readable `strategy_label` to every trade.
3. **Real vs sim diff** — joins `real_{bot}_trades.csv` to `dryrun_{bot}_trades.csv` on `(entry_time, market_slug)`. Computes per-trade slippage (`real.entry_price - sim.entry_price`), realized fee, and PnL delta. Aggregates total drag from fees + delay.
4. **Counterfactual backtest** — implements a Python `replay(ticks_df, config)` function that mirrors `decide()` (from `src/engines/edge.js`) and `evaluateExit()` (from `src/trading/position.js`). Runs four variants (TP-on, SL-on, FLIP-on, TIME_DECAY-on) plus combinations. Output: per-variant PnL bruto + net vs current baseline. Includes a validation cell that re-runs the replay with the **current** `config_hash` and asserts the produced trade list matches `dryrun_{bot}_trades.csv` row-for-row — confirms the Python engine is faithful before any counterfactual conclusions are drawn.
5. **Indicator hit-rate** — for each indicator (`rsi`, `ofi_1m`, `regime`, `ha_count`, `vwap_dist_pct`, `btc_vs_ptb`, hour-of-day, market price band), buckets the values and computes settled win-rate + average PnL per bucket using the per-tick `outcome` column. Highlights buckets where WR < 50% or PnL is negative.
6. **Strategy comparison** — user picks two `config_hash` values; the cell computes WR, profit factor, gross PnL, net PnL, and max drawdown on the overlap period.
7. **Fee + delay impact** — aggregates the slippage + fee drag from section 3 by hour-of-day, regime, and entry price band. Surfaces conditions where the real-vs-sim gap is largest.

Each section is a small number of cells with one or two `matplotlib` / `seaborn` plots. No Plotly — fewer moving parts.

## Data Flow

1. User clicks **Download analysis bundle** on `/files`.
2. Browser sends `GET /api/analysis-bundle?bot=15m` with session cookie.
3. Server validates auth, opens each candidate file with a streaming read, counts rows + grabs first/last timestamps.
4. Server builds `manifest.json` in memory.
5. Server creates a ZIP stream (`archiver`), appends each file (skipping missing ones, recording in `manifest.missing`), appends the manifest, and pipes the stream to the response.
6. Browser saves the ZIP locally.
7. User extracts the ZIP, opens `analysis/starter.ipynb` in Jupyter, points the first cell at the extracted directory, runs.

## Risks / Open Questions

- **Engine fidelity.** The biggest risk is that the Python port of `decide()` / `evaluateExit()` drifts from the JS implementation. Mitigation: the section-4 validation cell forces a round-trip check before any counterfactual runs.
- **Bundle size.** Per-tick CSVs can grow large. At 1 tick/s, the 15m bot writes ~86k rows/day. After ~30 days the CSV can hit tens of MB. ZIP compression on text helps significantly, but if the file ever exceeds, say, 100 MB compressed, we may need date-range slicing on the endpoint (out of scope for v1 — add only if it becomes a problem).
- **`real_*_trades.csv` schema parity.** Real-trade and sim-trade CSV schemas are documented as identical. If they ever diverge, section 3's join will silently drop columns. The notebook should print column diffs as a sanity check.

## Acceptance

- `GET /api/analysis-bundle?bot=15m` returns a ZIP with the four expected files (when present) + `manifest.json`, behind the auth gate.
- `/files` page shows a "Download analysis bundle ({bot})" button driven by the selected bot.
- The file list filters by selected bot with a toggle to show all.
- `analysis/starter.ipynb` runs end-to-end on a real bundle and produces output for all seven sections.
- The validation cell in section 4 passes against the current strategy.
