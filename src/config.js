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
    stopLossMinDurationS: Number(process.env.TRADE_SL_MIN_DURATION_S || "120"),  // seconds position must age before SL fires
    // PTB safety guard: suppress SL/SIGNAL_FLIP exits when BTC is this many USD
    // on the winning side of the price-to-beat. Absorbs ~$9 ptb drift + buffer.
    ptbSafeMarginUsd: Number(process.env.TRADE_PTB_SAFE_MARGIN_USD || "30"),
    // Cooldown after a SIGNAL_FLIP before re-entering the same market
    flipCooldownS: Number(process.env.TRADE_FLIP_COOLDOWN_S || "60"),
    // Consecutive ticks model must confirm reversal before SIGNAL_FLIP fires
    flipConfirmTicks: Number(process.env.TRADE_FLIP_CONFIRM_TICKS || "2"),
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
