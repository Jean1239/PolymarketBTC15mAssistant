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
  },
};
