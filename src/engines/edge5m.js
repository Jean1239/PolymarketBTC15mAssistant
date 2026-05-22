// Edge detection and decision engine for 5m mode.
// Reuses computeEdge from edge.js — only the decision thresholds change.

import { edgeAdjustmentForEntry } from "../fees.js";

export { computeEdge } from "./edge.js";

export function decide5m({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null, marketUp = null, marketDown = null, heikenColor = null, ofi1m = null, feeRate = 0, minTimeLeftMin = 0 }) {
  // Phases tuned for 5-minute window
  const phase = remainingMinutes > 3 ? "EARLY" : remainingMinutes > 1.5 ? "MID" : "LATE";

  const baseThreshold = phase === "EARLY" ? 0.04 : phase === "MID" ? 0.12 : 0.25;
  const minProb = phase === "EARLY" ? 0.54 : phase === "MID" ? 0.62 : 0.70;

  // Early-window gate: skip entries past the first ~minute of the market.
  // Late entries chase an already-priced move and lose (see config5m
  // entryMinTimeLeftMin). Disabled when minTimeLeftMin <= 0.
  if (minTimeLeftMin > 0 && remainingMinutes < minTimeLeftMin) {
    return { action: "NO_TRADE", side: null, phase, reason: `too_late_lt_${minTimeLeftMin}m` };
  }

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;
  const bestMarketPrice = bestSide === "UP" ? marketUp : marketDown;

  // OFI alignment filter: reject if order flow contradicts the chosen direction.
  // OFI is the primary signal on 5m — entering against it means noise, not edge.
  // Previously required BOTH HA and OFI to disagree; OFI alone is now sufficient.
  if (ofi1m !== null) {
    const ofiAgainst = (bestSide === "UP" && ofi1m < -0.05) ||
                       (bestSide === "DOWN" && ofi1m > 0.05);
    if (ofiAgainst) {
      return { action: "NO_TRADE", side: null, phase, reason: "ofi_conflict" };
    }
  }

  // Fee adjustment: bump the edge bar by feeRate * p * (1-p) so we don't ENTER
  // on signals whose theoretical edge is fully eaten by the taker fee.
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
