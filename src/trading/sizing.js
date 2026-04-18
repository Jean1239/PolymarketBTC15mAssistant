/**
 * High-conviction position sizing helper.
 *
 * When the chosen side's model probability is above `minProb` AND the entry
 * price falls inside [entryMin, entryMax], the trade amount is multiplied.
 * The target zone is the "cheap-but-confident" bucket: low enough price to
 * give a ≥2× payoff on win, high enough that the model conviction is strong.
 *
 * Returns the base amount unchanged when the feature is disabled
 * (multiplier ≤ 1) or when any required input is missing.
 */
export function computeTradeAmount({ baseAmount, side, entryPrice, modelUp, modelDown, config }) {
  const multiplier = config?.highConvictionMultiplier ?? 1;
  if (multiplier <= 1 || !Number.isFinite(entryPrice)) return baseAmount;

  const minProb = config?.highConvictionMinProb ?? 0.70;
  const entryMin = config?.highConvictionEntryMin ?? 0.45;
  const entryMax = config?.highConvictionEntryMax ?? 0.50;

  const sideProb = side === "UP" ? modelUp : modelDown;
  if (sideProb == null) return baseAmount;

  const inEntryRange = entryPrice >= entryMin && entryPrice <= entryMax;
  const highConv = sideProb >= minProb;
  return (inEntryRange && highConv) ? baseAmount * multiplier : baseAmount;
}
