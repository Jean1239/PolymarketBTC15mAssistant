/**
 * Polymarket taker-fee model.
 *
 * Fee formula (from https://docs.polymarket.com/trading/fees):
 *   fee_usdc = shares * feeRate * price * (1 - price)
 *
 * Fees are charged only on taker fills. All FAK/FOK market orders are taker;
 * the bot uses FAK exclusively. Settlement redemptions (CTF.redeemPositions)
 * are fee-free, so SETTLED_WIN / SETTLED_LOSS exits pay no exit fee.
 *
 * Fee rate depends on market category. BTC 15m / 5m markets are "Crypto"
 * (0.07 = 7%). The default below matches that; override per-market by
 * reading `getClobMarketInfo(conditionId).fd.r` when the SDK exposes it.
 */

export const FEE_RATE = {
  Crypto: 0.07,
  Sports: 0.03,
  Finance: 0.04,
  Politics: 0.04,
  Mentions: 0.04,
  Tech: 0.04,
  Economics: 0.05,
  Culture: 0.05,
  Weather: 0.05,
  Other: 0.05,
  Geopolitics: 0.0,
};

export const DEFAULT_FEE_RATE = FEE_RATE.Crypto;

/**
 * Taker fee in USDC for a fill of `shares` at `price`.
 *
 * @param {number} shares       Number of shares filled.
 * @param {number} price        Fill price in [0, 1].
 * @param {number} [feeRate]    Override the fee rate. Defaults to Crypto (0.07).
 * @returns {number} Fee in USDC. Always ≥ 0.
 */
export function takerFee(shares, price, feeRate = DEFAULT_FEE_RATE) {
  if (!shares || shares <= 0) return 0;
  if (price == null || price <= 0 || price >= 1) return 0;
  const fee = shares * feeRate * price * (1 - price);
  // Polymarket rounds fees to 5 decimals (smallest = 0.00001 USDC).
  return Math.max(0, Math.round(fee * 1e5) / 1e5);
}

/**
 * Fee as a fraction of trade value (USDC per USDC traded).
 *
 *   trade_value = shares * price
 *   fee         = shares * feeRate * price * (1 - price)
 *   fee/value   = feeRate * (1 - price)
 *
 * Useful for back-of-envelope ROI corrections.
 *
 * @param {number} price        Fill price in [0, 1].
 * @param {number} [feeRate]    Override the fee rate. Defaults to Crypto.
 * @returns {number} Fee as fraction of trade value (e.g. 0.0175 at p=0.50).
 */
export function feeFractionOfTradeValue(price, feeRate = DEFAULT_FEE_RATE) {
  if (price == null || price <= 0 || price >= 1) return 0;
  return feeRate * (1 - price);
}

/**
 * Edge adjustment in *probability space* for a BUY at market price `p`.
 *
 * On entry the bot pays `feeRate * p * (1 - p)` USDC per share (= per $1 of
 * potential payoff). Expected net payoff of a winning position:
 *
 *   E[payoff] = modelProb * 1  −  p  −  feeRate * p * (1 − p)
 *
 * For the trade to be break-even we need modelProb ≥ p + feeRate * p * (1−p),
 * i.e. `edge_required ≥ feeRate * p * (1 − p)` on top of the strategic
 * threshold. Settlement redemption is fee-free, so this is a *one-way* fee
 * adjustment — exits to settlement don't add a second fee. (For exits via
 * market sell, the dry-run sim already nets the sell fee from PnL.)
 *
 * @param {number} price        Best-side market price in [0, 1].
 * @param {number} [feeRate]    Override the fee rate. Defaults to Crypto.
 * @returns {number} Probability-space edge adjustment.
 */
export function edgeAdjustmentForEntry(price, feeRate = DEFAULT_FEE_RATE) {
  if (price == null || price <= 0 || price >= 1) return 0;
  return feeRate * price * (1 - price);
}
