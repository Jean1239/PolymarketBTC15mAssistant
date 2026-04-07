import { clamp } from "../utils.js";

export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
  } = inputs;

  let up = 1;
  let down = 1;

  // VWAP position — weight 1 (reduced from 2: too laggy over 240 candles)
  if (price !== null && vwap !== null) {
    if (price > vwap) up += 1;
    if (price < vwap) down += 1;
  }

  // VWAP slope — weight 1 (reduced from 2)
  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 1;
    if (vwapSlope < 0) down += 1;
  }

  // RSI — weight 2
  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) up += 2;
    if (rsi < 45 && rsiSlope < 0) down += 2;
  }

  // MACD — weight 2 (expanding histogram) + 1 (line direction)
  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 2;
    if (expandingRed) down += 2;

    if (macd.macd > 0) up += 1;
    if (macd.macd < 0) down += 1;
  }

  // Heiken Ashi — weight 1
  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 2) up += 1;
    if (heikenColor === "red" && heikenCount >= 2) down += 1;
  }

  // ── Conflict detection ────────────────────────────────────────────────
  // Count non-VWAP indicator directions. If the majority disagree with
  // the tentative scoring direction, flag as conflicted → decide() will
  // reject the trade instead of entering against the indicators.
  let indicatorUp = 0;
  let indicatorDown = 0;

  if (heikenColor === "green") indicatorUp += 1;
  if (heikenColor === "red") indicatorDown += 1;

  if (macd?.hist > 0) indicatorUp += 1;
  if (macd?.hist < 0) indicatorDown += 1;

  if (rsi !== null) {
    if (rsi > 50) indicatorUp += 1;
    if (rsi < 50) indicatorDown += 1;
  }

  const rawUp = up / (up + down);
  const tentativeSide = rawUp >= 0.5 ? "UP" : "DOWN";
  const conflicted =
    (tentativeSide === "DOWN" && indicatorUp >= 2 && indicatorDown <= 1) ||
    (tentativeSide === "UP" && indicatorDown >= 2 && indicatorUp <= 1);

  return { upScore: up, downScore: down, rawUp, conflicted };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
