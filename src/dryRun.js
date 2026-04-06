/**
 * Dry-run study logger.
 *
 * Accumulates per-tick snapshots in memory for the current market. When the
 * market slug changes (settlement), flushes the buffer to CSV with outcome
 * columns filled in retroactively:
 *
 *   outcome          — "UP" or "DOWN" (which side actually won)
 *   btc_at_settlement — final Chainlink BTC/USD price
 *   direction_correct — 1 if signal matched outcome, 0 if not, "" if NO TRADE
 *   signal_roi        — hypothetical ROI if entered at that tick's market price
 *
 * Usage:
 *   const logger = createDryRunLogger15m("./logs/dryrun_15m.csv");
 *   // inside the poll loop (after priceLatch.update):
 *   logger.tick({ slug, priceToBeat, btcPrice, signalSide, entryPrice, dataValues });
 *   // on process exit:
 *   logger.flushNow();
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./utils.js";

export const HEADER_15M = [
  "timestamp", "market_slug", "time_left_min",
  "btc_price", "market_up", "market_down",
  "regime", "signal", "model_up", "model_down", "edge_up", "edge_down", "rec_detail",
  "rsi", "rsi_slope", "macd_hist", "macd_label", "ha_color", "ha_count",
  "vwap", "vwap_dist_pct", "vwap_slope",
  "outcome", "btc_at_settlement", "direction_correct", "signal_roi",
];

export const HEADER_5M = [
  "timestamp", "market_slug", "time_left_min",
  "btc_price", "market_up", "market_down",
  "signal", "model_up", "model_down", "edge_up", "edge_down", "rec_detail",
  "ofi_30s", "ofi_1m", "ofi_2m", "roc1", "roc3", "ema_cross",
  "rsi", "ha_color", "ha_count", "vwap", "vwap_dist_pct", "vwap_slope",
  "outcome", "btc_at_settlement", "direction_correct", "signal_roi",
];

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

function createBuffer(csvPath, header) {
  let currentSlug = null;
  let lastPriceToBeat = null;
  let lastBtcPrice = null;
  let buffer = []; // { dataValues, signalSide: "UP"|"DOWN"|null, entryPrice: number|null }[]

  function _ensureHeader() {
    ensureDir(path.dirname(csvPath));
    if (!fs.existsSync(csvPath)) {
      fs.writeFileSync(csvPath, header.join(",") + "\n", "utf8");
    }
  }

  function _flush() {
    if (buffer.length === 0) return;

    _ensureHeader();

    const ptb = lastPriceToBeat;
    const btcFinal = lastBtcPrice;
    const canComputeOutcome = ptb !== null && btcFinal !== null;
    const outcome = canComputeOutcome ? (btcFinal > ptb ? "UP" : "DOWN") : null;

    const lines = buffer.map(({ dataValues, signalSide, entryPrice }) => {
      let correct = "";
      let roi = "";
      if (outcome !== null && signalSide !== null) {
        correct = signalSide === outcome ? "1" : "0";
        roi = entryPrice !== null && entryPrice > 0
          ? (signalSide === outcome ? fmt((1 / entryPrice) - 1, 4) : "-1.0000")
          : "";
      }
      return toCsvLine([
        ...dataValues,
        outcome ?? "",
        btcFinal !== null ? fmt(btcFinal, 2) : "",
        correct,
        roi,
      ]);
    });

    fs.appendFileSync(csvPath, lines.join("\n") + "\n", "utf8");
    buffer = [];
  }

  /**
   * Record one tick. Call after all indicators and priceLatch.update() are computed.
   *
   * @param {string}        slug         - current market slug
   * @param {number|null}   priceToBeat  - latched BTC open price (may be null early in market)
   * @param {number|null}   btcPrice     - live Chainlink/Polymarket BTC price
   * @param {"UP"|"DOWN"|null} signalSide - direction of the signal (null if NO TRADE)
   * @param {number|null}   entryPrice   - market price for signalSide (null if NO TRADE)
   * @param {Array}         dataValues   - pre-settlement CSV columns (all except outcome cols)
   */
  function tick({ slug, priceToBeat, btcPrice, signalSide, entryPrice, dataValues }) {
    if (slug !== currentSlug && currentSlug !== null) {
      _flush();
    }
    currentSlug = slug;
    if (priceToBeat !== null) lastPriceToBeat = priceToBeat;
    if (btcPrice !== null) lastBtcPrice = btcPrice;
    buffer.push({ dataValues, signalSide, entryPrice });
  }

  /** Flush current buffer immediately (call on process exit). */
  function flushNow() {
    _flush();
  }

  return { tick, flushNow };
}

/** Create a dry-run logger for the 15-minute assistant. */
export function createDryRunLogger15m(csvPath) {
  return createBuffer(csvPath, HEADER_15M);
}

/** Create a dry-run logger for the 5-minute assistant. */
export function createDryRunLogger5m(csvPath) {
  return createBuffer(csvPath, HEADER_5M);
}
