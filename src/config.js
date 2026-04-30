export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://api.binance.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 1_000,
  candleWindowMinutes: 15,

  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,

  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: "10192",
    seriesSlug: "btc-up-or-down-15m",
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down"
  },

  trading: {
    privateKey: process.env.POLYMARKET_PRIVATE_KEY || "",
    funder: process.env.POLYMARKET_FUNDER || "",
    signatureType: Number(process.env.POLYMARKET_SIGNATURE_TYPE || "0"),
    tradeAmount: Number(process.env.POLYMARKET_TRADE_AMOUNT || "5"),
    // Exit thresholds
    takeProfitPct: Number(process.env.TRADE_TAKE_PROFIT_PCT || "20"),   // vender ao atingir +20% ROI
    stopLossPct: Number(process.env.TRADE_STOP_LOSS_PCT || "25"),        // vender ao atingir -25% ROI
    signalFlipMinProb: Number(process.env.TRADE_SIGNAL_FLIP_PROB || "0.58"), // prob oposta que indica inversão
    // Stop-loss guards: require higher conviction + minimum hold time before stopping out
    stopLossMinProb: Number(process.env.TRADE_SL_MIN_PROB || "0.65"),            // min opposite prob to trigger SL
    stopLossMinDurationS: Number(process.env.TRADE_SL_MIN_DURATION_S || "240"),  // seconds position must age before SL fires
    // PTB safety guard: suppress SL/SIGNAL_FLIP exits when BTC is this many USD
    // on the winning side of the price-to-beat. Absorbs ~$9 ptb drift + buffer.
    ptbSafeMarginUsd: Number(process.env.TRADE_PTB_SAFE_MARGIN_USD || "30"),
    // Entry price filter: only enter if the market price of the chosen side is
    // within [entryMinMarketPrice, entryMaxMarketPrice].
    // Defaults come from dry-run analysis: entries below 0.50 are net-losers on 15m
    // (settlement win-rate drops below 50% in [0.45-0.50) band). See STRATEGY_LOG.md.
    entryMinMarketPrice: Number(process.env.TRADE_ENTRY_MIN_PRICE || "0.50"),
    entryMaxMarketPrice: Number(process.env.TRADE_ENTRY_MAX_PRICE || "0.58"),
    // Cooldown after a SIGNAL_FLIP before re-entering the same market
    flipCooldownS: Number(process.env.TRADE_FLIP_COOLDOWN_S || "60"),
    // Consecutive ticks model must confirm reversal before SIGNAL_FLIP fires
    flipConfirmTicks: Number(process.env.TRADE_FLIP_CONFIRM_TICKS || "2"),
    // Disable exits:
    //   - SIGNAL_FLIP: 15m data shows 25 flips with avg -$0.36 PnL; hold-to-settlement
    //     performs better. Enable via TRADE_DISABLE_SIGNAL_FLIP=false to re-activate.
    disableSignalFlip: (process.env.TRADE_DISABLE_SIGNAL_FLIP ?? "true").toLowerCase() === "true",
    disableStopLoss: (process.env.TRADE_DISABLE_STOP_LOSS ?? "false").toLowerCase() === "true",
    // TIME_DECAY exit: fires when time-left (min) < X AND losing more than Y%.
    // Only applies to expensive entries (entryPrice >= 0.50).
    timeDecayMinLeftMin: Number(process.env.TRADE_TIME_DECAY_MIN_LEFT_MIN || "1.5"),
    timeDecayMinLossPct: Number(process.env.TRADE_TIME_DECAY_MIN_LOSS_PCT || "5"),
    // BTC vs price-to-beat entry filter: skip entry when |btcPrice - priceToBeat| < threshold.
    // Near-zero divergence = market undecided — 41.5% win rate in [-5,+5) zone on 15m.
    // Set to 0 to disable. Override with TRADE_BTC_VS_PTB_MIN_USD.
    btcVsPtbMinAbsUsd: Number(process.env.TRADE_BTC_VS_PTB_MIN_USD || "5"),
    // High-conviction position sizing. When entry price ∈ [entryMin, entryMax]
    // AND chosen-side model prob ≥ minProb, trade amount is multiplied.
    // Multiplier=1 disables the feature.
    highConvictionMultiplier: Number(process.env.TRADE_HIGH_CONVICTION_MULT || "2"),
    highConvictionMinProb: Number(process.env.TRADE_HIGH_CONVICTION_MIN_PROB || "0.70"),
    highConvictionEntryMin: Number(process.env.TRADE_HIGH_CONVICTION_ENTRY_MIN || "0.50"),
    highConvictionEntryMax: Number(process.env.TRADE_HIGH_CONVICTION_ENTRY_MAX || "0.52"),
    // Regimes in which new entries are blocked (15m only).
    // CHOP and RANGE have low directional signal — more STOP_LOSS and TIME_DECAY events.
    // Override with TRADE_BLOCKED_REGIMES as a comma-separated list (e.g. "CHOP,RANGE").
    blockedRegimes: process.env.TRADE_BLOCKED_REGIMES
      ? process.env.TRADE_BLOCKED_REGIMES.split(",").map(s => s.trim().toUpperCase())
      : ["CHOP", "RANGE"],
    // Hours (UTC) during which new entries are blocked. Derived from dry-run analysis:
    // 00h, 02h, 04h, 08h, 11h, 17–18h, 21h show consistent negative PnL on 15m.
    // Override with TRADE_BLOCKED_HOURS_UTC as a comma-separated list (e.g. "0,2,4").
    blockedHoursUtc: process.env.TRADE_BLOCKED_HOURS_UTC
      ? process.env.TRADE_BLOCKED_HOURS_UTC.split(",").map(Number)
      : [0, 2, 4, 8, 11, 17, 18, 21],
    // When true: paper-trading only — no real orders even if private key is set
    dryRunOnly: (process.env.DRY_RUN || "").toLowerCase() === "true",
    // When true: enables real order execution. Default false = simulated/paper mode.
    liveTradingEnabled: (process.env.POLYMARKET_LIVE_TRADING || "").toLowerCase() === "true",
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  }
};
