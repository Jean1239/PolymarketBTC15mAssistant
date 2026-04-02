// Probability engine for 5m mode.
// Primary signals: order flow, momentum, fast EMA crossover.
// Secondary: RSI(5), Heiken Ashi (relaxed), short VWAP.

import { clamp } from "../utils.js";

export function scoreDirection5m({
  orderFlow,
  momentumScore,
  emaCross,
  rsi,
  rsiSlope,
  heikenColor,
  heikenCount,
  price,
  vwap,
  vwapSlope
}) {
  let up = 1;
  let down = 1;

  // Order flow imbalance — primary signal (weight: up to 8 points)
  if (orderFlow) {
    up += orderFlow.up;
    down += orderFlow.down;
  }

  // Momentum — primary signal (weight: up to 5 points)
  if (momentumScore) {
    up += momentumScore.up;
    down += momentumScore.down;
  }

  // EMA crossover — secondary signal (weight: up to 3 points)
  if (emaCross) {
    if (emaCross.bullish) up += 1;
    else down += 1;

    if (emaCross.expanding && emaCross.bullish) up += 1;
    if (emaCross.expanding && !emaCross.bullish) down += 1;

    if (emaCross.crossover === "BULLISH") up += 1;
    if (emaCross.crossover === "BEARISH") down += 1;
  }

  // RSI — lighter weight with shorter period (weight: up to 2 points)
  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) up += 1;
    if (rsi < 45 && rsiSlope < 0) down += 1;

    // Extreme RSI for reversal detection
    if (rsi > 70) up += 1;
    if (rsi < 30) down += 1;
  }

  // Heiken Ashi — relaxed: only need 1 consecutive (weight: up to 1 point)
  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 1) up += 1;
    if (heikenColor === "red" && heikenCount >= 1) down += 1;
  }

  // Short VWAP — lightweight (weight: up to 2 points)
  if (price !== null && vwap !== null) {
    if (price > vwap) up += 1;
    if (price < vwap) down += 1;
  }

  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 1;
    if (vwapSlope < 0) down += 1;
  }

  const rawUp = up / (up + down);
  return { upScore: up, downScore: down, rawUp };
}

export function applyTimeAwareness5m(rawUp, remainingMinutes, windowMinutes = 5) {
  // Quadratic decay — preserves signal longer in early phase,
  // decays aggressively only in final minute.
  const ratio = clamp(remainingMinutes / windowMinutes, 0, 1);
  const timeDecay = Math.pow(ratio, 0.6);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
