# ---
# jupyter:
#   jupytext:
#     text_representation:
#       format_name: percent
# ---

# %% [markdown]
# # Polymarket BTC Bot — Offline Analysis
#
# Edit `BUNDLE_DIR` to point at the directory where you extracted the analysis ZIP.

# %%
from __future__ import annotations
import json
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_theme(style="whitegrid")
pd.set_option("display.max_columns", 60)

BUNDLE_DIR = Path("./bundle")  # <-- edit this
assert BUNDLE_DIR.exists(), f"Bundle dir not found: {BUNDLE_DIR.resolve()}"

# %% [markdown]
# ## 1. Load

# %%
manifest = json.loads((BUNDLE_DIR / "manifest.json").read_text())
BOT = manifest["bot"]
print(f"Bot: {BOT}  generatedAt: {manifest['generatedAt']}  source: {manifest['tradeSource']}")
print(f"Missing files: {manifest['missing']}")
for f in manifest["files"]:
    print(f"  {f['name']:36s}  rows={f['rows']}  {f['firstTs']} -> {f['lastTs']}")

def load_csv(name: str) -> pd.DataFrame | None:
    fp = BUNDLE_DIR / name
    if not fp.exists():
        return None
    return pd.read_csv(fp)

ticks = load_csv(f"dryrun_{BOT}.csv")
sim_trades = load_csv(f"dryrun_{BOT}_trades.csv")
real_trades = load_csv(f"real_{BOT}_trades.csv")
versions = json.loads((BUNDLE_DIR / f"strategy_versions_{BOT}.json").read_text())

for df, label in [(ticks, "ticks"), (sim_trades, "sim_trades"), (real_trades, "real_trades")]:
    if df is None:
        print(f"  {label}: <missing>")
    else:
        print(f"  {label}: {len(df):,} rows, {len(df.columns)} cols")

# Parse timestamps once
for df, col in [
    (ticks, "timestamp"),
    (sim_trades, "entry_time"),
    (sim_trades, "exit_time"),
    (real_trades, "entry_time"),
    (real_trades, "exit_time"),
]:
    if df is not None and col in df.columns:
        df[col] = pd.to_datetime(df[col], utc=True, errors="coerce")

# %% [markdown]
# ## 2. Decode strategy
#
# Every trade row carries a `config_hash`. The strategy registry maps each hash to its full
# config + a human-readable label.

# %%
versions_df = pd.DataFrame(versions)
print(f"Strategy versions in registry: {len(versions_df)}")
cols = [c for c in ["hash", "label", "detectedAt"] if c in versions_df.columns]
print(versions_df[cols].to_string(index=False))

def attach_label(df: pd.DataFrame | None) -> pd.DataFrame | None:
    if df is None or "config_hash" not in df.columns:
        return df
    out = df.merge(
        versions_df[["hash", "label"]].rename(columns={"hash": "config_hash", "label": "strategy_label"}),
        on="config_hash",
        how="left",
    )
    out["strategy_label"] = out["strategy_label"].fillna("unknown")
    return out

sim_trades = attach_label(sim_trades)
real_trades = attach_label(real_trades)

if sim_trades is not None and "strategy_label" in sim_trades.columns:
    print("\nTrades per strategy (sim):")
    print(sim_trades["strategy_label"].value_counts())

# %% [markdown]
# ## 3. Real vs sim — slippage, fees, PnL delta
#
# Joins real and sim trades on `(entry_time, market_slug)`. Slippage = `real.entry_price - sim.entry_price`.
# Drag = sum of (sim.pnl - real.pnl).

# %%
if real_trades is None or real_trades.empty:
    print("No real trades in this bundle — skip section 3.")
else:
    key_cols = ["entry_time", "market_slug"]
    joined = sim_trades.merge(
        real_trades,
        on=key_cols,
        how="inner",
        suffixes=("_sim", "_real"),
    )
    joined["slippage"] = joined["entry_price_real"] - joined["entry_price_sim"]
    joined["pnl_delta"] = joined["pnl_sim"] - joined["pnl_real"]

    summary = joined[["slippage", "pnl_delta", "pnl_sim", "pnl_real"]].describe()
    print(summary)
    print(f"\nMatched trades: {len(joined)}")
    print(f"Total sim PnL on matched trades:  {joined['pnl_sim'].sum():+.2f}")
    print(f"Total real PnL on matched trades: {joined['pnl_real'].sum():+.2f}")
    print(f"Total drag (sim - real):           {joined['pnl_delta'].sum():+.2f}")

    fig, axes = plt.subplots(1, 2, figsize=(11, 4))
    sns.histplot(joined["slippage"], bins=40, ax=axes[0])
    axes[0].set_title("Slippage distribution (real - sim entry price)")
    sns.scatterplot(data=joined, x="slippage", y="pnl_real",
                    hue="side_real" if "side_real" in joined.columns else None,
                    ax=axes[1])
    axes[1].set_title("Slippage vs real PnL")
    plt.tight_layout()
