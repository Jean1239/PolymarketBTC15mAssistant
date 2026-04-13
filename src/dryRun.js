/**
 * Paper-trading simulator (dry-run v2).
 *
 * Simulates real trading: enters on first ENTER signal, tracks the position,
 * evaluates exits using the same TP/SL/signal-flip/time-decay logic as real
 * trading, and logs every tick with full position + simulation state.
 *
 * On market settlement (slug change), open positions resolve at $1 (win) or
 * $0 (loss) based on whether the held side matches the actual outcome.
 *
 * Also writes a per-trade journal to a separate CSV for easy analysis.
 *
 * Usage:
 *   const sim = createDryRunSimulator15m("./logs/dryrun_15m.csv", config);
 *   // inside the poll loop:
 *   sim.tick({ slug, priceToBeat, btcPrice, rec, modelUp, modelDown,
 *              marketUp, marketDown, timeLeftMin, dataValues });
 *   // on process exit:
 *   sim.flushNow();
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./utils.js";

// ── Headers ─────────────────────────────────────────────────────────────────

const SIM_COLS = [
  "sim_action", "sim_side", "sim_entry_price", "sim_current_price",
  "sim_roi_pct", "sim_exit_reason", "sim_pnl", "sim_cum_pnl",
];

const OUTCOME_COLS = ["outcome", "btc_at_settlement"];

const INDICATOR_COLS_15M = [
  "timestamp", "market_slug", "time_left_min",
  "btc_price", "market_up", "market_down",
  "regime", "signal", "model_up", "model_down", "edge_up", "edge_down", "rec_detail",
  "rsi", "rsi_slope", "macd_hist", "macd_label", "ha_color", "ha_count",
  "vwap", "vwap_dist_pct", "vwap_slope",
];

const INDICATOR_COLS_5M = [
  "timestamp", "market_slug", "time_left_min",
  "btc_price", "market_up", "market_down",
  "signal", "model_up", "model_down", "edge_up", "edge_down", "rec_detail",
  "ofi_30s", "ofi_1m", "ofi_2m", "roc1", "roc3", "ema_cross",
  "rsi", "ha_color", "ha_count", "vwap", "vwap_dist_pct", "vwap_slope",
];

export const HEADER_15M = [...INDICATOR_COLS_15M, ...SIM_COLS, ...OUTCOME_COLS];
export const HEADER_5M  = [...INDICATOR_COLS_5M,  ...SIM_COLS, ...OUTCOME_COLS];

const TRADE_JOURNAL_HEADER = [
  "entry_time", "exit_time", "market_slug", "side",
  "entry_price", "exit_price", "shares", "invested",
  "exit_value", "pnl", "roi_pct", "exit_reason", "duration_s",
];

// ── CSV helpers ─────────────────────────────────────────────────────────────

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function toCsvLine(values) {
  return values.map(csvEscape).join(",");
}

function fmt(v, decimals = 4) {
  if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) return null;
  return Number(v).toFixed(decimals);
}

// ── Exit evaluation (inlined to avoid position.js module-level side effects) ─

function evaluateSimExit({ pos, modelUp, modelDown, currentMarketPrice, timeLeftMin, config }) {
  if (!pos.active || currentMarketPrice == null) {
    return { shouldSell: false, reason: null, roiPct: null };
  }

  const currentValue = pos.shares * currentMarketPrice;
  const pnlUsdc = currentValue - pos.invested;
  const roiPct = (pnlUsdc / pos.invested) * 100;

  const oppositeProb = (modelUp != null && modelDown != null)
    ? (pos.side === "UP" ? modelDown : modelUp)
    : null;
  const modelConfirmsReversal = oppositeProb != null && oppositeProb >= config.signalFlipMinProb;

  // Stop-loss guards: higher prob threshold + minimum hold time
  const slMinProb = config.stopLossMinProb ?? config.signalFlipMinProb;
  const slConfirmed = oppositeProb != null && oppositeProb >= slMinProb;
  const positionAgeS = pos.entryTime ? (Date.now() - pos.entryTime) / 1000 : Infinity;
  const slAgedEnough = positionAgeS >= (config.stopLossMinDurationS ?? 0);

  // Take profit — only if model also confirms reversal
  if (roiPct >= config.takeProfitPct && modelConfirmsReversal) {
    return { shouldSell: true, reason: "TAKE_PROFIT", roiPct };
  }

  // Stop loss — requires stricter prob + minimum hold time
  if (roiPct <= -config.stopLossPct && slConfirmed && slAgedEnough) {
    return { shouldSell: true, reason: "STOP_LOSS", roiPct };
  }

  // Signal flipped with enough conviction
  if (modelConfirmsReversal) {
    return { shouldSell: true, reason: "SIGNAL_FLIP", roiPct };
  }

  // Time decay — only for expensive entries (≥ 50¢)
  const entryWasCheap = pos.entryPrice < 0.50;
  if (timeLeftMin != null && timeLeftMin < 1.5 && roiPct < -5 && !entryWasCheap) {
    return { shouldSell: true, reason: "TIME_DECAY", roiPct };
  }

  return { shouldSell: false, reason: null, roiPct };
}

// ── Simulator core ──────────────────────────────────────────────────────────

function createSimulator(csvPath, header, config) {
  const tradesPath = csvPath.replace(/\.csv$/, "_trades.csv");

  let currentSlug = null;
  let lastPriceToBeat = null;
  let lastBtcPrice = null;
  let buffer = []; // { dataValues[], simCols[] }[]

  // Virtual position
  let pos = { active: false, side: null, entryPrice: 0, shares: 0, invested: 0, marketSlug: null, entryTime: null };
  let cumulativePnl = 0;

  // Trade stats
  let wins = 0;
  let losses = 0;
  let totalTrades = 0;
  let recentTrades = []; // { side, pnl, roi, ts, reason }[]

  // Cooldown tracking: timestamp (ms) of last SIGNAL_FLIP exit, reset on new market
  let lastFlipTime = null;
  const flipCooldownMs = (config.flipCooldownS ?? 0) * 1000;

  // Consecutive-tick confirmation counter for SIGNAL_FLIP
  let flipConfirmCount = 0;
  const flipConfirmTicks = config.flipConfirmTicks ?? 1;

  function _resetPos() {
    pos = { active: false, side: null, entryPrice: 0, shares: 0, invested: 0, marketSlug: null, entryTime: null };
  }

  function _ensureHeader(filePath, headerRow) {
    ensureDir(path.dirname(filePath));
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, headerRow.join(",") + "\n", "utf8");
    }
  }

  function _logTrade({ exitPrice, exitValue, pnl, roiPct, reason, exitTime }) {
    _ensureHeader(tradesPath, TRADE_JOURNAL_HEADER);
    const durationS = pos.entryTime ? Math.round((exitTime - pos.entryTime) / 1000) : "";
    const row = toCsvLine([
      pos.entryTime ? new Date(pos.entryTime).toISOString() : "",
      new Date(exitTime).toISOString(),
      pos.marketSlug,
      pos.side,
      fmt(pos.entryPrice, 4),
      fmt(exitPrice, 4),
      fmt(pos.shares, 4),
      fmt(pos.invested, 2),
      fmt(exitValue, 4),
      fmt(pnl, 4),
      fmt(roiPct, 2),
      reason,
      durationS,
    ]);
    fs.appendFileSync(tradesPath, row + "\n", "utf8");

    // Update in-memory stats
    totalTrades += 1;
    if (pnl >= 0) wins += 1; else losses += 1;
    recentTrades.unshift({ side: pos.side, pnl, roi: roiPct, ts: exitTime, reason });
    if (recentTrades.length > 10) recentTrades.pop();
  }

  function _settlePosition() {
    if (!pos.active) return;

    const ptb = lastPriceToBeat;
    const btcFinal = lastBtcPrice;
    if (ptb == null || btcFinal == null) {
      // Can't determine outcome — force close at last known market price (best effort)
      _resetPos();
      return;
    }

    const outcome = btcFinal > ptb ? "UP" : "DOWN";
    const won = pos.side === outcome;
    const resolutionPrice = won ? 1.0 : 0.0;
    const exitValue = pos.shares * resolutionPrice;
    const pnl = exitValue - pos.invested;
    const roiPct = (pnl / pos.invested) * 100;
    const reason = won ? "SETTLED_WIN" : "SETTLED_LOSS";

    cumulativePnl += pnl;
    _logTrade({ exitPrice: resolutionPrice, exitValue, pnl, roiPct, reason, exitTime: Date.now() });
    _resetPos();
  }

  function _flush() {
    if (buffer.length === 0) return;

    _ensureHeader(csvPath, header);

    const ptb = lastPriceToBeat;
    const btcFinal = lastBtcPrice;
    const canCompute = ptb !== null && btcFinal !== null;
    const outcome = canCompute ? (btcFinal > ptb ? "UP" : "DOWN") : null;

    const lines = buffer.map(({ dataValues, simCols }) => {
      return toCsvLine([
        ...dataValues,
        ...simCols,
        outcome ?? "",
        btcFinal !== null ? fmt(btcFinal, 2) : "",
      ]);
    });

    fs.appendFileSync(csvPath, lines.join("\n") + "\n", "utf8");
    buffer = [];
  }

  /**
   * Record one tick and run the paper-trading simulation.
   *
   * @param {string}      slug        - current market slug
   * @param {number|null} priceToBeat - latched BTC open price
   * @param {number|null} btcPrice    - live Chainlink/Polymarket BTC price
   * @param {Object}      rec         - recommendation { action, side, phase, strength }
   * @param {number|null} modelUp     - time-aware model probability for UP
   * @param {number|null} modelDown   - time-aware model probability for DOWN
   * @param {number|null} marketUp    - current market price for UP side
   * @param {number|null} marketDown  - current market price for DOWN side
   * @param {number|null} timeLeftMin - minutes remaining in the market
   * @param {Array}       dataValues  - indicator CSV columns (everything before sim columns)
   */
  function tick({ slug, priceToBeat, btcPrice, rec, modelUp, modelDown, marketUp, marketDown, timeLeftMin, dataValues }) {
    // ── Market changed → settle open position and flush buffer ──────────
    if (slug !== currentSlug && currentSlug !== null) {
      _settlePosition();
      _flush();
      lastFlipTime = null;     // reset cooldown on new market
      flipConfirmCount = 0;    // reset flip confirmation on new market
    }

    currentSlug = slug;
    if (priceToBeat !== null) lastPriceToBeat = priceToBeat;
    if (btcPrice !== null) lastBtcPrice = btcPrice;

    // ── Simulation logic ────────────────────────────────────────────────
    let simAction = "WAIT";
    let simSide = "";
    let simEntryPrice = "";
    let simCurrentPrice = "";
    let simRoiPct = "";
    let simExitReason = "";
    let simPnl = "";

    if (pos.active) {
      const currentMktPrice = pos.side === "UP" ? marketUp : marketDown;

      // Evaluate exit
      const rawEval = evaluateSimExit({
        pos, modelUp, modelDown,
        currentMarketPrice: currentMktPrice,
        timeLeftMin,
        config,
      });

      // Apply consecutive-tick confirmation gate for SIGNAL_FLIP
      let exitEval = rawEval;
      if (rawEval.shouldSell && rawEval.reason === "SIGNAL_FLIP") {
        flipConfirmCount++;
        if (flipConfirmCount < flipConfirmTicks) {
          exitEval = { shouldSell: false, reason: null, roiPct: rawEval.roiPct };
        }
      } else {
        flipConfirmCount = 0;
      }

      if (exitEval.shouldSell && currentMktPrice != null) {
        // ── SELL ────────────────────────────────────────────────────────
        const exitValue = pos.shares * currentMktPrice;
        const pnl = exitValue - pos.invested;
        const roiPct = (pnl / pos.invested) * 100;

        cumulativePnl += pnl;

        simAction = "SELL";
        simSide = pos.side;
        simEntryPrice = fmt(pos.entryPrice, 4);
        simCurrentPrice = fmt(currentMktPrice, 4);
        simRoiPct = fmt(roiPct, 2);
        simExitReason = exitEval.reason;
        simPnl = fmt(pnl, 4);

        if (exitEval.reason === "SIGNAL_FLIP") {
          lastFlipTime = Date.now();
        }
        flipConfirmCount = 0;

        _logTrade({ exitPrice: currentMktPrice, exitValue, pnl, roiPct, reason: exitEval.reason, exitTime: Date.now() });
        _resetPos();
      } else {
        // ── HOLD ────────────────────────────────────────────────────────
        simAction = "HOLD";
        simSide = pos.side;
        simEntryPrice = fmt(pos.entryPrice, 4);
        simCurrentPrice = currentMktPrice != null ? fmt(currentMktPrice, 4) : "";
        simRoiPct = exitEval.roiPct != null ? fmt(exitEval.roiPct, 2) : "";
      }
    } else if (rec.action === "ENTER" && rec.side) {
      // ── BUY — skip if still within post-flip cooldown ─────────────────
      const inCooldown = flipCooldownMs > 0 && lastFlipTime !== null &&
        (Date.now() - lastFlipTime) < flipCooldownMs;

      const entryMktPrice = !inCooldown ? (rec.side === "UP" ? marketUp : marketDown) : null;
      if (entryMktPrice != null && entryMktPrice > 0) {
        const shares = config.tradeAmount / entryMktPrice;
        pos = {
          active: true,
          side: rec.side,
          entryPrice: entryMktPrice,
          shares,
          invested: config.tradeAmount,
          marketSlug: slug,
          entryTime: Date.now(),
        };

        flipConfirmCount = 0;

        simAction = "BUY";
        simSide = rec.side;
        simEntryPrice = fmt(entryMktPrice, 4);
        simCurrentPrice = fmt(entryMktPrice, 4);
        simRoiPct = "0.00";
      }
    }

    const simCols = [
      simAction,
      simSide,
      simEntryPrice,
      simCurrentPrice,
      simRoiPct,
      simExitReason,
      simPnl,
      fmt(cumulativePnl, 4),
    ];

    buffer.push({ dataValues, simCols });
  }

  /** Flush current buffer immediately (call on process exit). */
  function flushNow() {
    _settlePosition();
    _flush();
  }

  /** Get cumulative stats and current virtual position for display purposes. */
  function getStats() {
    return {
      wins, losses, totalTrades, cumulativePnl, recentTrades,
      position: {
        active: pos.active,
        side: pos.side,
        entryPrice: pos.entryPrice,
        shares: pos.shares,
        invested: pos.invested,
        entryTime: pos.entryTime,
        marketSlug: pos.marketSlug,
      },
    };
  }

  return { tick, flushNow, getStats };
}

// ── Factory functions ───────────────────────────────────────────────────────

/**
 * Create a paper-trading simulator for the 15-minute assistant.
 * @param {string} csvPath - path for the tick-by-tick CSV
 * @param {{ tradeAmount?: number, takeProfitPct?: number, stopLossPct?: number, signalFlipMinProb?: number }} [tradingConfig]
 */
export function createDryRunSimulator15m(csvPath, tradingConfig = {}) {
  const config = {
    tradeAmount: tradingConfig.tradeAmount ?? 5,
    takeProfitPct: tradingConfig.takeProfitPct ?? 20,
    stopLossPct: tradingConfig.stopLossPct ?? 25,
    signalFlipMinProb: tradingConfig.signalFlipMinProb ?? 0.58,
    stopLossMinProb: tradingConfig.stopLossMinProb ?? null,
    stopLossMinDurationS: tradingConfig.stopLossMinDurationS ?? 0,
    flipCooldownS: tradingConfig.flipCooldownS ?? 60,
    flipConfirmTicks: tradingConfig.flipConfirmTicks ?? 2,
  };
  return createSimulator(csvPath, HEADER_15M, config);
}

/**
 * Create a paper-trading simulator for the 5-minute assistant.
 * @param {string} csvPath - path for the tick-by-tick CSV
 * @param {{ tradeAmount?: number, takeProfitPct?: number, stopLossPct?: number, signalFlipMinProb?: number, stopLossMinProb?: number, stopLossMinDurationS?: number, flipCooldownS?: number }} [tradingConfig]
 */
export function createDryRunSimulator5m(csvPath, tradingConfig = {}) {
  const config = {
    tradeAmount: tradingConfig.tradeAmount ?? 5,
    takeProfitPct: tradingConfig.takeProfitPct ?? 20,
    stopLossPct: tradingConfig.stopLossPct ?? 25,
    signalFlipMinProb: tradingConfig.signalFlipMinProb ?? 0.58,
    stopLossMinProb: tradingConfig.stopLossMinProb ?? 0.65,
    stopLossMinDurationS: tradingConfig.stopLossMinDurationS ?? 120,
    flipCooldownS: tradingConfig.flipCooldownS ?? 90,
    flipConfirmTicks: tradingConfig.flipConfirmTicks ?? 3,
  };
  return createSimulator(csvPath, HEADER_5M, config);
}
