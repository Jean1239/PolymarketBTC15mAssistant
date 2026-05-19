import { clamp } from "../utils.js";
import { edgeAdjustmentForEntry } from "../fees.js";

export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  const marketUp = sum > 0 ? marketYes / sum : null;
  const marketDown = sum > 0 ? marketNo / sum : null;

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

export function decide({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null, marketUp = null, marketDown = null, conflicted = false, regime = null, blockedRegimes = [], feeRate = 0 }) {
  const phase = remainingMinutes > 10 ? "EARLY" : remainingMinutes > 5 ? "MID" : "LATE";

  const baseThreshold = phase === "EARLY" ? 0.05 : phase === "MID" ? 0.1 : 0.2;

  const minProb = phase === "EARLY" ? 0.55 : phase === "MID" ? 0.6 : 0.65;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  // Regime filter: skip entry in low-signal regimes (e.g. CHOP, RANGE)
  if (regime && blockedRegimes.includes(regime)) {
    return { action: "NO_TRADE", side: null, phase, reason: `regime_${regime.toLowerCase()}` };
  }

  // Indicator conflict: HA + MACD + RSI majority disagrees with VWAP direction
  if (conflicted) {
    return { action: "NO_TRADE", side: null, phase, reason: "indicator_conflict" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;
  const bestMarketPrice = bestSide === "UP" ? marketUp : marketDown;

  // Fee adjustment: raise the edge bar by feeRate * p * (1-p) so we never
  // ENTER on a trade whose model edge is consumed by the entry taker fee.
  // Settlement is fee-free, so this single-sided adjustment captures the
  // round-trip cost when the position is held to resolution.
  const feeAdj = edgeAdjustmentForEntry(bestMarketPrice, feeRate);
  const threshold = baseThreshold + feeAdj;

  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold.toFixed(3)}` };
  }

  if (bestModel !== null && bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };
  }

  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}
