// Edge detection and decision engine for 5m mode.
// Reuses computeEdge from edge.js — only the decision thresholds change.

export { computeEdge } from "./edge.js";

export function decide5m({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null, heikenColor = null, ofi1m = null }) {
  // Phases tuned for 5-minute window
  const phase = remainingMinutes > 3 ? "EARLY" : remainingMinutes > 1.5 ? "MID" : "LATE";

  const threshold = phase === "EARLY" ? 0.04 : phase === "MID" ? 0.12 : 0.25;
  const minProb = phase === "EARLY" ? 0.54 : phase === "MID" ? 0.62 : 0.70;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

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

  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold}` };
  }

  if (bestModel !== null && bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };
  }

  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}
