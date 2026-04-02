// Edge detection and decision engine for 5m mode.
// Reuses computeEdge from edge.js — only the decision thresholds change.

import { clamp } from "../utils.js";

export { computeEdge } from "./edge.js";

export function decide5m({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null }) {
  // Phases tuned for 5-minute window
  const phase = remainingMinutes > 3 ? "EARLY" : remainingMinutes > 1.5 ? "MID" : "LATE";

  const threshold = phase === "EARLY" ? 0.04 : phase === "MID" ? 0.08 : 0.15;
  const minProb = phase === "EARLY" ? 0.54 : phase === "MID" ? 0.58 : 0.62;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold}` };
  }

  if (bestModel !== null && bestModel < minProb) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${minProb}` };
  }

  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}
