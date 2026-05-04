import { CONFIG as BASE } from "./config.js";

export const CONFIG = {
  ...BASE,

  candleWindowMinutes: 5,

  // Shorter RSI for 5m — 5-period on 1m candles = 5 minutes of data
  rsiPeriod: 5,
  rsiMaPeriod: 5,

  // VWAP slope lookback (in minutes / candles)
  vwapSlopeLookbackMinutes: 3,
  // Only use last N candles for VWAP in 5m mode
  vwapCandleWindow: 10,

  // EMA crossover periods
  emaCrossFast: 3,
  emaCrossSlow: 8,

  polymarket: {
    ...BASE.polymarket,
    seriesId: "10684",
    seriesSlug: "btc-up-or-down-5m"
  },

  // 5m-specific trading overrides
  trading: {
    ...BASE.trading,
    // Higher conviction required before treating a signal as reversed (flip/TP/SL gate).
    // Raised from 0.58 after dry-run analysis: SIGNAL_FLIP fired 158× with only 3.8% win —
    // the lower threshold was catching transient blips across 0.58 that then reverted.
    signalFlipMinProb: Number(process.env.TRADE_SIGNAL_FLIP_PROB || "0.62"),
    // Even higher conviction required before stopping out
    stopLossMinProb: Number(process.env.TRADE_SL_MIN_PROB || "0.65"),
    // Position must be held at least 2 minutes before SL can fire
    stopLossMinDurationS: Number(process.env.TRADE_SL_MIN_DURATION_S || "120"),
    // Longer cooldown between flips on the faster 5m timeframe
    flipCooldownS: Number(process.env.TRADE_FLIP_COOLDOWN_S || "90"),
    // Require 5 consecutive confirming ticks before exiting on signal flip
    flipConfirmTicks: Number(process.env.TRADE_FLIP_CONFIRM_TICKS || "5"),
    // Disable stop-loss on 5m: data shows 78% of SLs exit before a loss, but the 22%
    // that cut winners cost more than the savings. Holding to settlement is +$50 better
    // across 161 SL trades. The 85% settled win rate makes hold-to-settlement dominant.
    disableStopLoss: (process.env.TRADE_DISABLE_STOP_LOSS_5M ?? "true").toLowerCase() === "true",
    // Disable signal-flip on 5m: 158 SIGNAL_FLIPs showed 3.8% win rate.
    // Lower threshold was catching transient blips across 0.58 that then reverted.
    disableSignalFlip: (process.env.TRADE_DISABLE_SIGNAL_FLIP_5M ?? "true").toLowerCase() === "true",
    // Disable TIME_DECAY on 5m: 433 TIME_DECAY exits totalled -$159.63 vs +$154.79 on 161
    // SETTLED_WINs. Hold-to-settlement dominant (97.6% settled win rate); early cut destroys value.
    disableTimeDecay: (process.env.TRADE_DISABLE_TIME_DECAY_5M ?? "true").toLowerCase() === "true",
    // Entry price filter tuned for 5m dry-run: entries < 0.50 lose $3.53, entries
    // at 0.50–0.54 lose $5.46 historically. Only 0.55–0.60 zone shows positive PnL.
    // Uses its own env vars so it can differ from the 15m config.
    entryMinMarketPrice: Number(process.env.TRADE_ENTRY_MIN_PRICE_5M || "0.50"),
    // Lowered from 0.60: dry-run shows entries >= 0.52 are net-losers (-$11.44 vs +$9.86 below).
    entryMaxMarketPrice: Number(process.env.TRADE_ENTRY_MAX_PRICE_5M || "0.52"),
    // Hours (UTC) during which new entries are blocked. Overrides 15m list.
    // Updated from v11 analysis (30-Apr to 04-May, 592 trades):
    // Released H21 (+$10.49 in 23 trades — was the single best hour, erroneously blocked).
    // Added H04 (-$8.43 in 34 trades — worst unblocked hour).
    // Retained H02, H03, H06, H10, H16, H19, H20 from v11 analysis.
    blockedHoursUtc: process.env.TRADE_BLOCKED_HOURS_UTC_5M
      ? process.env.TRADE_BLOCKED_HOURS_UTC_5M.split(",").map(Number)
      : [2, 3, 4, 6, 10, 16, 19, 20],
    // Tighter TIME_DECAY on 5m: require ≥15% loss before cutting (vs 5% on 15m),
    // and fire earlier (2.5 min left vs 1.5 min). Cuts clearly-lost positions
    // sooner but avoids trimming the small recoveries seen near settlement.
    timeDecayMinLeftMin: Number(process.env.TRADE_TIME_DECAY_MIN_LEFT_MIN_5M || "2.5"),
    timeDecayMinLossPct: Number(process.env.TRADE_TIME_DECAY_MIN_LOSS_PCT_5M || "15"),
    // High-conviction sizing disabled by default on 5m — higher noise per trade.
    highConvictionMultiplier: Number(process.env.TRADE_HIGH_CONVICTION_MULT_5M || "1"),
  },
};
