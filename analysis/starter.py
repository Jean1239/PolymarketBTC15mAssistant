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

# %% [markdown]
# ## 4. Counterfactual backtest
#
# Replays alternative exit configurations over historical ticks. The engine mirrors
# `decide()` from `src/engines/edge.js` (or `edge5m.js`) and `evaluateExit()` from
# `src/trading/position.js`.
#
# **Approximations vs the production engine** (acceptable for directional analysis,
# not for sub-cent precision):
#   - No `flipConfirmTicks` gate (FLIP fires on first qualifying tick).
#   - No fee-aware decide() — replay assumes fee is zero (handled separately in section 7).
#   - No PTB safe-margin override (the JS engine suppresses SL/FLIP/TIME_DECAY when
#     `btc` is on the winning side and `|btc - priceToBeat| >= ptbSafeMarginUsd`).
#
# **Validation gate (cell 4a):** re-runs the replay with the CURRENT strategy config and
# compares the produced trade list to `dryrun_{bot}_trades.csv`. If trade-count delta > 5
# or PnL delta > $2, treat counterfactual numbers with skepticism.

# %%
from dataclasses import dataclass

@dataclass
class StrategyCfg:
    entry_min_price: float
    entry_max_price: float
    blocked_hours_utc: tuple
    blocked_regimes: tuple = ("CHOP", "RANGE")
    take_profit_pct: float = 20.0
    stop_loss_pct: float = 25.0
    signal_flip_min_prob: float = 0.58
    stop_loss_min_prob: float = 0.65
    stop_loss_min_duration_s: float = 240.0
    flip_cooldown_s: float = 60.0
    disable_take_profit: bool = False
    disable_stop_loss: bool = False
    disable_signal_flip: bool = False
    disable_time_decay: bool = False

@dataclass
class _Pos:
    side: str
    entry_price: float
    entry_time: pd.Timestamp
    invested: float
    shares: float

def _market_price(row, side):
    return float(row["market_up"] if side == "UP" else row["market_down"])

def _opposite_prob(row, side):
    return float(row["model_down"] if side == "UP" else row["model_up"])

def replay(ticks_df: pd.DataFrame, cfg: StrategyCfg, trade_amount: float = 5.0) -> pd.DataFrame:
    """Tick-by-tick replay. Returns the list of completed trades as a DataFrame.

    Required columns in ticks_df:
      timestamp, market_slug, time_left_min, regime (15m), signal,
      model_up, model_down, market_up, market_down, outcome.
    """
    out = []
    pos: _Pos | None = None
    cooldown_until: pd.Timestamp | None = None
    last_slug: str | None = None

    has_regime = "regime" in ticks_df.columns

    for row in ticks_df.itertuples(index=False):
        ts = row.timestamp
        slug = row.market_slug

        # Settlement: market changed -> close any open position at retroactive outcome
        if last_slug is not None and slug != last_slug and pos is not None:
            outcome = getattr(row, "outcome", None)
            won = (outcome == pos.side)
            exit_price = 1.0 if won else 0.0
            pnl = pos.shares * exit_price - pos.invested
            out.append({
                "entry_time": pos.entry_time, "exit_time": ts, "market_slug": last_slug,
                "side": pos.side, "entry_price": pos.entry_price, "exit_price": exit_price,
                "pnl": pnl, "roi_pct": 100 * pnl / pos.invested,
                "exit_reason": "SETTLED_WIN" if won else "SETTLED_LOSS",
                "duration_s": (ts - pos.entry_time).total_seconds(),
            })
            pos = None
            cooldown_until = None
        last_slug = slug

        # Exit evaluation
        if pos is not None:
            side = pos.side
            row_dict = row._asdict() if hasattr(row, "_asdict") else dict(zip(ticks_df.columns, row))
            curr = _market_price(row_dict, side)
            roi = 100 * (curr - pos.entry_price) / pos.entry_price
            opp = _opposite_prob(row_dict, side)
            age_s = (ts - pos.entry_time).total_seconds()
            t_left = float(getattr(row, "time_left_min", 9999) or 9999)
            exit_reason = None

            if not cfg.disable_take_profit and roi >= cfg.take_profit_pct and opp >= cfg.signal_flip_min_prob:
                exit_reason = "TAKE_PROFIT"
            elif not cfg.disable_stop_loss and roi <= -cfg.stop_loss_pct and opp >= cfg.stop_loss_min_prob and age_s >= cfg.stop_loss_min_duration_s:
                exit_reason = "STOP_LOSS"
            elif not cfg.disable_signal_flip and opp >= cfg.signal_flip_min_prob:
                exit_reason = "SIGNAL_FLIP"
            elif not cfg.disable_time_decay and t_left < 1.5 and roi < -5 and pos.entry_price >= 0.5:
                exit_reason = "TIME_DECAY"

            if exit_reason is not None:
                pnl = pos.shares * curr - pos.invested
                out.append({
                    "entry_time": pos.entry_time, "exit_time": ts, "market_slug": slug,
                    "side": side, "entry_price": pos.entry_price, "exit_price": curr,
                    "pnl": pnl, "roi_pct": 100 * pnl / pos.invested,
                    "exit_reason": exit_reason, "duration_s": age_s,
                })
                if exit_reason == "SIGNAL_FLIP":
                    cooldown_until = ts + pd.Timedelta(seconds=cfg.flip_cooldown_s)
                pos = None
                continue

        # Entry check
        if pos is None and (cooldown_until is None or ts >= cooldown_until):
            sig = getattr(row, "signal", None)
            if sig in ("UP", "DOWN"):
                row_dict = row._asdict() if hasattr(row, "_asdict") else dict(zip(ticks_df.columns, row))
                price = _market_price(row_dict, sig)
                hour = ts.hour
                regime_val = getattr(row, "regime", None) if has_regime else None
                if (cfg.entry_min_price <= price <= cfg.entry_max_price
                    and hour not in cfg.blocked_hours_utc
                    and (regime_val is None or regime_val not in cfg.blocked_regimes)):
                    shares = trade_amount / price
                    pos = _Pos(side=sig, entry_price=price, entry_time=ts,
                               invested=trade_amount, shares=shares)

    return pd.DataFrame(out)

# %% [markdown]
# ### 4a. Validation — Python replay must roughly match JS engine

# %%
def cfg_from_registry(entry: dict) -> StrategyCfg:
    c = entry.get("config", {}) or {}
    default_max = 0.58 if BOT == "15m" else 0.52
    default_flip = 0.58 if BOT == "15m" else 0.62
    default_cooldown = 60 if BOT == "15m" else 90
    blocked_hours = c.get("blockedHoursUtc") or []
    return StrategyCfg(
        entry_min_price=c.get("entryMinMarketPrice", 0.50),
        entry_max_price=c.get("entryMaxMarketPrice", default_max),
        blocked_hours_utc=tuple(blocked_hours),
        blocked_regimes=tuple(c.get("blockedRegimes") or ["CHOP", "RANGE"]),
        take_profit_pct=c.get("takeProfitPct", 20),
        stop_loss_pct=c.get("stopLossPct", 25),
        signal_flip_min_prob=c.get("signalFlipMinProb", default_flip),
        stop_loss_min_prob=c.get("stopLossMinProb", 0.65),
        stop_loss_min_duration_s=c.get("stopLossMinDurationS", 240),
        flip_cooldown_s=c.get("flipCooldownS", default_cooldown),
        disable_take_profit=c.get("disableTakeProfit", False),
        disable_stop_loss=c.get("disableStopLoss", False),
        disable_signal_flip=c.get("disableSignalFlip", False),
        disable_time_decay=c.get("disableTimeDecay", False),
    )

current = versions_df.iloc[-1].to_dict()  # most-recent strategy
current_cfg = cfg_from_registry(current)
print(f"Validating against current strategy: {current.get('label')} ({current['hash'][:8]}...)")

current_trades_recorded = sim_trades[sim_trades["config_hash"] == current["hash"]].copy()
if current_trades_recorded.empty:
    print("⚠️  No recorded trades for the current config_hash — validation skipped.")
else:
    window_start = current_trades_recorded["entry_time"].min()
    window_end = current_trades_recorded["exit_time"].max()
    ticks_window = ticks[(ticks["timestamp"] >= window_start) & (ticks["timestamp"] <= window_end)]

    replayed = replay(ticks_window, current_cfg)
    print(f"Recorded trades: {len(current_trades_recorded)}   Replayed: {len(replayed)}")
    print(f"Recorded PnL:    {current_trades_recorded['pnl'].sum():+.4f}")
    print(f"Replayed PnL:    {replayed['pnl'].sum():+.4f}")

    trade_delta = abs(len(replayed) - len(current_trades_recorded))
    pnl_delta = abs(replayed["pnl"].sum() - current_trades_recorded["pnl"].sum())
    if trade_delta > 5 or pnl_delta > 2.0:
        print("⚠️  Replay diverges materially from recorded trades. Engine port needs fixing before trusting counterfactuals.")
    else:
        print("✅ Replay matches recorded trades within tolerance — engine port OK for directional use.")

# %% [markdown]
# ### 4b. Counterfactual variants

# %%
if not current_trades_recorded.empty:
    base_kwargs = current_cfg.__dict__
    variants = {
        "current": current_cfg,
        "+TP": StrategyCfg(**{**base_kwargs, "disable_take_profit": False}),
        "+SL": StrategyCfg(**{**base_kwargs, "disable_stop_loss": False}),
        "+FLIP": StrategyCfg(**{**base_kwargs, "disable_signal_flip": False}),
        "+TIME_DECAY": StrategyCfg(**{**base_kwargs, "disable_time_decay": False}),
        "all exits on": StrategyCfg(**{**base_kwargs,
            "disable_take_profit": False, "disable_stop_loss": False,
            "disable_signal_flip": False, "disable_time_decay": False}),
    }

    rows = []
    for label, cfg in variants.items():
        res = replay(ticks_window, cfg)
        rows.append({
            "variant": label,
            "trades": len(res),
            "wins": int((res["pnl"] > 0).sum()) if len(res) else 0,
            "wr": float((res["pnl"] > 0).mean()) if len(res) else 0.0,
            "gross_pnl": float(res["pnl"].sum()) if len(res) else 0.0,
        })
    counterfactual_summary = pd.DataFrame(rows)
    print(counterfactual_summary.to_string(index=False))

    fig, ax = plt.subplots(figsize=(8, 4))
    sns.barplot(data=counterfactual_summary, x="variant", y="gross_pnl", ax=ax)
    ax.set_title(f"Counterfactual gross PnL by exit-config variant ({BOT})")
    ax.axhline(0, color="black", lw=0.5)
    plt.xticks(rotation=20, ha="right")
    plt.tight_layout()

