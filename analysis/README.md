# Polymarket BTC Bot — Analysis Notebook

Offline Python analysis of the bot's performance.

## Setup

```bash
cd analysis
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Get the data

1. Open the dashboard, switch the bot selector to the bot you want to analyse (15m or 5m).
2. Go to **Files**.
3. Click **Bundle análise ({bot})**.
4. Extract the ZIP somewhere local — note the path.

The bundle contains:

| File | Purpose |
|---|---|
| `dryrun_{bot}.csv` | Per-tick log (every indicator + sim state + retroactive outcome). |
| `dryrun_{bot}_trades.csv` | Per-trade journal (with `config_hash` for strategy era). |
| `real_{bot}_trades.csv` | Live-trading journal (when present). Central to fee/delay analysis. |
| `strategy_versions_{bot}.json` | Maps each `config_hash` to its full config + label. |
| `manifest.json` | Generated metadata (row counts, date ranges, missing files). |

## Open the notebook

The starter is shipped as `starter.py` in [jupytext](https://jupytext.readthedocs.io/) percent format
(`# %%` cell markers). Two ways to use it:

**VS Code:** open `starter.py` — the Jupyter extension renders the cells natively.

**Classic Jupyter:** convert once with `jupytext`:

```bash
jupytext --to notebook starter.py
jupyter notebook starter.ipynb
```

## What the notebook covers

1. **Load** — reads the bundle and runs sanity checks.
2. **Decode strategy** — attaches a `strategy_label` to every trade.
3. **Real vs sim** — per-trade slippage, fees, PnL delta.
4. **Counterfactual backtest** — replays alternative exit configs (TP, SL, FLIP, TIME_DECAY) over historical ticks. Includes a validation cell that asserts the Python engine matches the JS engine.
5. **Indicator hit-rate** — per-bucket win-rate for each indicator.
6. **Strategy comparison** — pick two `config_hash` values, compare metrics on overlap.
7. **Fee + delay impact** — aggregated drag by hour, regime, and price band.
