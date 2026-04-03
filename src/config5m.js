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
  }
};
