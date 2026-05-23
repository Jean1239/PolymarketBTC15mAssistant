const _executionMode = (process.env.EXECUTION_MODE ?? "paper").toLowerCase();
if (_executionMode !== "paper" && _executionMode !== "real") {
  console.error(`[startup] EXECUTION_MODE inválido: '${_executionMode}'. Use 'paper' ou 'real'.`);
  process.exit(1);
}

export const CONFIG = {
  executionMode: _executionMode,

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
    // Polymarket taker fee rate. BTC markets are "Crypto" category → 0.07.
    // Fee formula: fee_usdc = shares * feeRate * price * (1 - price).
    // Applied to all FAK fills (entry + non-settle exits). Settlement is fee-free.
    // Override with TRADE_FEE_RATE if a market uses a different category.
    feeRate: Number(process.env.TRADE_FEE_RATE ?? "0.07"),
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
    // Disable TIME_DECAY on 15m: 143 exits over 5 days totalled -$139.86 while non-TD
    // trades (SETTLED_WIN + SL) netted +$100.22 at 73.6% WR. Raising entryMinMarketPrice
    // to 0.50 made every single trade qualify for TD — same pattern that caused -$159 on 5m
    // in v10. Hold-to-settlement is the dominant strategy. Override with TRADE_DISABLE_TIME_DECAY.
    disableTimeDecay: (process.env.TRADE_DISABLE_TIME_DECAY ?? "true").toLowerCase() === "true",
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
    // Hours (UTC) during which new entries are blocked.
    //
    // Default emptied 2026-05-17 (mirrors 5m decision): per-hour sample
    // sizes (n≈10–30) are too small to distinguish bad hours from noise.
    // Power analysis: detecting a $0.30/trade deviation with power 0.8
    // requires ~79 trades/hour. Hour list had been thrashing across analyses,
    // flipping the same hours between "good" and "bad" purely on small-window
    // variance. Empty list lets the price/regime/signal filters drive
    // selection and increases sample volume needed to validate hour-level
    // edges. Override with TRADE_BLOCKED_HOURS_UTC to re-enable manually.
    blockedHoursUtc: process.env.TRADE_BLOCKED_HOURS_UTC
      ? process.env.TRADE_BLOCKED_HOURS_UTC.split(",").map(Number)
      : [],
    // Max fractional drift (0–1) between the sim's decision price and the live
    // bestAsk/bestBid at order-send time. If the market moved more than this between
    // the sim deciding to trade and the order actually firing, the real order is
    // skipped (sim still records the virtual trade). Default 0.02 = 2%.
    slippageTolerancePct: Number(process.env.TRADE_SLIPPAGE_TOLERANCE_PCT ?? "0.02"),
    // Absolute price buffer (0–1) added to the sim's decision price on BUY
    // (and subtracted from bestBid on SELL) when posting the FAK order's
    // limit price. On BUY the limit is `simDecisionPrice + takerBuffer`, so
    // the buffer is the maximum slippage we accept relative to the price the
    // sim signed off on — beyond that the FAK correctly kills because filling
    // would be -EV at the model's probability. CLOB still matches at the
    // lowest available ask ≤ limit, so a normal book fills at simDecisionPrice
    // or better.
    //
    // Default lowered from 0.10 → 0.05 after 196-trade real run (2026-05-14 →
    // 2026-05-17) showed avg +1.27¢ entry slippage vs sim, with 23% of real
    // fills landing above `entryMaxMarketPrice` because the 10¢ cap spanned
    // most of the 0.50–0.60 entry band. 5¢ keeps the FAK alive on normal book
    // jitter while keeping fills inside the configured price band.
    takerBuffer: Number(process.env.TRADE_TAKER_BUFFER ?? "0.05"),
    // When true the bot skips the on-chain CTF.redeemPositions call after a
    // market settles. Polymarket-managed wallets (POLY_PROXY, POLY_1271,
    // POLY_GNOSIS_SAFE) hold the conditional tokens in their smart wallet,
    // not in the EOA, so calling redeemPositions directly from the EOA
    // redeems nothing AND burns POL on a no-op tx. Polymarket's own backend
    // batch-redeems these wallets automatically — leaving redemption to them
    // is the correct path for SIG_TYPE 1/2/3. Set to "false" only for pure
    // EOA accounts (SIG_TYPE 0) that hold their own CT tokens.
    disableAutoRedeem: (process.env.TRADE_DISABLE_AUTO_REDEEM ?? "true").toLowerCase() === "true",
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  }
};
