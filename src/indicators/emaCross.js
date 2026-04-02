// Fast EMA crossover for 5m mode.
// Replaces MACD(12,26,9) which is too slow for a 5-minute window.

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function computeEmaCross(closes, fastPeriod = 3, slowPeriod = 8) {
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  if (fast === null || slow === null) return null;

  // Previous values for crossover detection
  const prevFast = closes.length > 1 ? ema(closes.slice(0, -1), fastPeriod) : null;
  const prevSlow = closes.length > 1 ? ema(closes.slice(0, -1), slowPeriod) : null;

  const diff = fast - slow;
  const prevDiff = (prevFast !== null && prevSlow !== null) ? prevFast - prevSlow : null;

  let crossover = "NONE";
  if (prevDiff !== null) {
    if (prevDiff <= 0 && diff > 0) crossover = "BULLISH";
    else if (prevDiff >= 0 && diff < 0) crossover = "BEARISH";
  }

  return {
    fast,
    slow,
    diff,
    prevDiff,
    crossover,
    bullish: diff > 0,
    expanding: prevDiff !== null ? Math.abs(diff) > Math.abs(prevDiff) : false
  };
}
