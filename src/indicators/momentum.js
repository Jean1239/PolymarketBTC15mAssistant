// Price momentum indicators for 5m mode.
// Rate of change and acceleration over short windows.

export function computeMomentum(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;

  const last = candles[candles.length - 1];
  const closes = candles.map(c => c.close);

  // Rate of change over last 1 candle (1m)
  const roc1 = candles.length >= 2
    ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]
    : null;

  // Rate of change over last 3 candles (3m)
  const roc3 = candles.length >= 4
    ? (closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]
    : null;

  // Acceleration: change in roc1 over last 2 ticks
  let accel = null;
  if (candles.length >= 3) {
    const prevRoc1 = (closes[closes.length - 2] - closes[closes.length - 3]) / closes[closes.length - 3];
    accel = roc1 - prevRoc1;
  }

  // Volume surge: last candle vs average of previous 5
  let volumeSurge = null;
  if (candles.length >= 6) {
    const avgVol = candles.slice(-6, -1).reduce((a, c) => a + c.volume, 0) / 5;
    volumeSurge = avgVol > 0 ? last.volume / avgVol : null;
  }

  return {
    roc1,
    roc3,
    accel,
    volumeSurge,
    lastClose: last.close
  };
}

export function scoreMomentum(momentum) {
  if (!momentum) return { up: 0, down: 0 };

  let up = 0;
  let down = 0;

  // Rate of change signals
  if (momentum.roc1 !== null) {
    if (momentum.roc1 > 0.0003) up += 1;
    if (momentum.roc1 < -0.0003) down += 1;
    if (momentum.roc1 > 0.001) up += 1;
    if (momentum.roc1 < -0.001) down += 1;
  }

  if (momentum.roc3 !== null) {
    if (momentum.roc3 > 0.0005) up += 1;
    if (momentum.roc3 < -0.0005) down += 1;
  }

  // Acceleration — momentum building
  if (momentum.accel !== null) {
    if (momentum.accel > 0.0001 && momentum.roc1 > 0) up += 1;
    if (momentum.accel < -0.0001 && momentum.roc1 < 0) down += 1;
  }

  // Volume surge confirms direction
  if (momentum.volumeSurge !== null && momentum.volumeSurge > 1.5) {
    if (momentum.roc1 !== null && momentum.roc1 > 0) up += 1;
    if (momentum.roc1 !== null && momentum.roc1 < 0) down += 1;
  }

  return { up, down };
}
