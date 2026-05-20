import fs from "node:fs";
import { clamp } from "../utils.js";
import { setStatusMessage } from "../display.js";
import { buyMarketOrder, sellMarketOrder } from "./orders.js";
import { getPosition, recordBuy, recordSell, fetchPositionBalance } from "./position.js";
import { notifyTrade } from "../notify.js";

/**
 * Parse the OrderResponse returned by `createAndPostMarketOrder`. Returns the
 * actual collateral and shares moved, plus an `avgFillPrice` computed from
 * them. CLOB V2 reports `makingAmount` / `takingAmount` as decimal strings
 * already in human units (e.g. "0.999999" for ≈ $1, "1.886791" for ≈ 1.89
 * shares), so we just parse them as floats — no further scaling.
 *
 * For a BUY the maker side contributes pUSD and the taker (us) receives
 * shares, so `makingAmount` is the collateral we paid and `takingAmount`
 * is the shares we received. For a SELL the roles invert.
 *
 * `order.success === true` with zero amounts indicates a no-fill (e.g. an
 * FAK order that never matched at the limit price).
 */
function parseFillFromOrder(order, side) {
  const success = order?.success === true;
  const status = order?.status ?? null;
  const errorMsg = order?.errorMsg ?? null;

  const makingAmount = order?.makingAmount ? Number(order.makingAmount) : 0;
  const takingAmount = order?.takingAmount ? Number(order.takingAmount) : 0;

  let collateral, shares;
  if (side === "BUY") {
    collateral = makingAmount;
    shares = takingAmount;
  } else {
    shares = makingAmount;
    collateral = takingAmount;
  }

  const filled = shares > 0 && collateral > 0;
  const avgFillPrice = filled ? collateral / shares : null;

  return { success, status, errorMsg, collateral, shares, avgFillPrice, filled };
}

function logTrade(msg) {
  try {
    fs.mkdirSync("./logs", { recursive: true });
    fs.appendFileSync("./logs/trade_orders.log", `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}

function logError(msg) {
  try {
    fs.mkdirSync("./logs", { recursive: true });
    fs.appendFileSync("./logs/trade_errors.log", `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}

/**
 * Check if the live bestAsk/bestBid has drifted too far from the price the
 * simulator used to decide on the trade. Protects against entering at a
 * materially worse price than the analysis assumed.
 *
 * @returns {{ok: true, livePrice: number} | {ok: false, error: string, livePrice: number|null, drift: number|null}}
 */
function checkSlippage({ livePrice, simDecisionPrice, slippageTolerancePct }) {
  if (livePrice == null || simDecisionPrice == null || simDecisionPrice === 0) {
    return { ok: false, error: "missing price for slippage check", livePrice, drift: null };
  }
  const drift = Math.abs(livePrice - simDecisionPrice) / simDecisionPrice;
  if (drift > slippageTolerancePct) {
    return { ok: false, error: `slippage ${(drift * 100).toFixed(2)}% > ${(slippageTolerancePct * 100).toFixed(2)}%`, livePrice, drift };
  }
  return { ok: true, livePrice };
}

/**
 * Place a real BUY in response to a sim BUY decision.
 *
 * The simulator already enforced all entry gates (price range, blocked hours,
 * btcVsPtb, cooldown). No BUY-side slippage check: the FAK limit `bestAsk +
 * takerBuffer` itself caps the worst realized fill, and an explicit slippage
 * guard was filtering out exactly the favorable book moves that correlate
 * with winners (dry-run vs real comparison on 2026-05-14/15 showed 26 skips
 * with +$7.26 of forgone dry PnL).
 *
 * SELL still uses the slippage guard via executeRealSell.
 *
 * @returns {Promise<{ok: true, executedPrice: number, shares: number} | {ok: false, error: string}>}
 */
export async function executeRealBuy({ trading, poly, side, simDecisionPrice, takerBuffer = 0.05, entryMaxMarketPrice = null, marketSlug, botLabel = "bot", onTrade = null }) {
  if (!trading.tradingEnabled || !poly.ok) {
    return { ok: false, error: "trading disabled or poly snapshot not ok" };
  }
  if (getPosition().active) {
    return { ok: false, error: "position already open" };
  }

  const book = side === "UP" ? poly.orderbook.up : poly.orderbook.down;
  const bestAsk = book?.bestAsk ?? null;
  if (bestAsk == null) {
    const msg = `BUY ${side} skipped — no bestAsk in book`;
    setStatusMessage(msg, 5000);
    logTrade(msg);
    return { ok: false, error: "no bestAsk" };
  }

  // Limit = simDecisionPrice + takerBuffer. Anchoring to the sim's decision
  // price (not the live bestAsk) means the cap doesn't age between snapshot
  // and order-send: if the book ran above the cap before our order landed,
  // the FAK kills correctly because filling there would be -EV at the
  // probability the sim used. CLOB still matches at the lowest available ask
  // ≤ limit, so a normal book at simDecisionPrice fills at that price.
  const priceNum = clamp(simDecisionPrice + takerBuffer, 0, 0.97);
  const tokenId = side === "UP" ? poly.tokens.upTokenId : poly.tokens.downTokenId;

  // Pre-flight price-band cap. The sim approved entry only when simDecisionPrice
  // sits inside [entryMin, entryMax]; if our local view of that price somehow
  // exceeds entryMax (sim/exec drift, stale snapshot, etc.) abort. We compare
  // simDecisionPrice itself rather than the limit — the buffer is a slippage
  // tolerance for the FAK to find a fill if the book ran a few cents, not part
  // of the entry band. With entryMax 0.52 + buffer 0.05 the previous check
  // (limit > entryMax) made every 5m signal unreachable. CLOB still matches at
  // the lowest ask ≤ limit, so a normal book fills at simDecisionPrice; partial
  // fills above the band remain logged below as belt-and-suspenders.
  if (entryMaxMarketPrice != null && simDecisionPrice > entryMaxMarketPrice) {
    const msg = `BUY ${side} skipped — sim ${(simDecisionPrice * 100).toFixed(1)}¢ > entryMax ${(entryMaxMarketPrice * 100).toFixed(1)}¢`;
    setStatusMessage(msg, 5000);
    logTrade(msg);
    return { ok: false, error: "sim above entryMax" };
  }

  setStatusMessage(`Comprando ${side} (sim)...`);
  logTrade(`BUY ${side} attempting limit=${(priceNum * 100).toFixed(1)}¢ (sim=${(simDecisionPrice * 100).toFixed(1)}¢ live=${(bestAsk * 100).toFixed(1)}¢) $${trading.tradeAmount}`);

  const result = await buyMarketOrder({ client: trading.client, tokenId, amount: trading.tradeAmount, price: priceNum });
  if (!result.ok) {
    const errMsg = `Erro na compra: ${result.error}`;
    setStatusMessage(errMsg, 15000);
    logError(`BUY ${side} ${errMsg}`);
    return { ok: false, error: result.error };
  }

  const fill = parseFillFromOrder(result.order, "BUY");
  const orderId = result.order?.orderID ?? result.order?.id ?? "-";

  if (!fill.success || !fill.filled) {
    const reason = fill.errorMsg || fill.status || "no fill";
    const msg = `BUY ${side} not filled — ${reason} (status=${fill.status}, shares=${fill.shares})`;
    setStatusMessage(msg, 8000);
    logTrade(`${msg} orderId=${orderId}`);
    return { ok: false, error: reason };
  }

  // Cross-check with on-chain balance: the order response reports the matched
  // amounts, but the authoritative figure is the wallet's actual share balance.
  // Use on-chain only when it materially differs from the order response (e.g.
  // a prior partial position exists), otherwise trust the response so the
  // avgFillPrice we just computed stays consistent with shares.
  const chainBalance = await fetchPositionBalance(trading.client, tokenId);
  const shares = chainBalance > 0 ? chainBalance : fill.shares;
  const investedActual = fill.collateral;
  const entryPrice = fill.avgFillPrice;
  // CLOB V2 reports `transactionsHashes` (plural) — there can be multiple if
  // the FAK matched across several maker orders. Use the first as the primary
  // anchor for /activity lookups; the full list is logged for audit.
  const txHash = Array.isArray(result.order?.transactionsHashes) && result.order.transactionsHashes.length > 0
    ? result.order.transactionsHashes[0]
    : null;

  recordBuy({ side, tokenId, shares, entryPrice, invested: investedActual, marketSlug, orderId });

  const partialTag = Math.abs(investedActual - trading.tradeAmount) > 0.01 ? ` [PARTIAL: $${investedActual.toFixed(2)}/$${trading.tradeAmount}]` : "";
  setStatusMessage(`COMPROU ${side} @ ${(entryPrice * 100).toFixed(1)}¢ | $${investedActual.toFixed(2)}${partialTag} | shares: ${shares.toFixed(2)} | ID: ${String(orderId).slice(0, 12)}`, 8000);
  logTrade(`BUY ${side} filled avgPrice=${entryPrice.toFixed(4)} collateral=${investedActual.toFixed(4)} shares=${shares.toFixed(4)} status=${fill.status} orderId=${orderId}`);
  // Belt-and-suspenders: the pre-flight cap above already prevents posting a
  // limit > entryMax, but a partial fill could still report an avgFillPrice
  // outside the band (e.g. if the order matched across multiple ask levels
  // before the kill). Surface that drift so it's not silent in the log.
  if (entryMaxMarketPrice != null && entryPrice > entryMaxMarketPrice) {
    logTrade(`BUY ${side} fill above band — avgPrice=${(entryPrice * 100).toFixed(1)}¢ > entryMax ${(entryMaxMarketPrice * 100).toFixed(1)}¢`);
  }
  notifyTrade({ bot: botLabel, isLive: true, action: "BUY", side, market: marketSlug, entryPrice, invested: investedActual });

  onTrade?.({
    action: "BUY", side, marketSlug,
    entryPrice, invested: investedActual, shares,
    txHash,
    timestamp: Date.now(),
  });

  return { ok: true, executedPrice: entryPrice, shares };
}

/**
 * Place a real SELL in response to a sim SELL decision.
 *
 * @returns {Promise<{ok: true, executedPrice: number, pnl: number, roi: number} | {ok: false, error: string}>}
 */
export async function executeRealSell({ trading, poly, simDecisionPrice, slippageTolerancePct, takerBuffer = 0.05, exitReason = "SIM_EXIT", marketSlug, botLabel = "bot", onTrade = null }) {
  if (!trading.tradingEnabled || !poly.ok) {
    return { ok: false, error: "trading disabled or poly snapshot not ok" };
  }
  const pos = getPosition();
  if (!pos.active) {
    return { ok: false, error: "no open position" };
  }

  const book = pos.side === "UP" ? poly.orderbook.up : poly.orderbook.down;
  const bestBid = book?.bestBid ?? null;

  const slip = checkSlippage({ livePrice: bestBid, simDecisionPrice, slippageTolerancePct });
  if (!slip.ok) {
    const msg = `SELL ${pos.side} skipped — ${slip.error} (sim=${simDecisionPrice} live=${slip.livePrice})`;
    setStatusMessage(msg, 5000);
    logTrade(msg);
    return { ok: false, error: slip.error };
  }

  const sellPriceNum = clamp(bestBid - takerBuffer, 0.03, 1);
  // Always re-read on-chain shares before selling: in-memory pos.shares may be
  // stale if the previous buy partial-filled and we never refreshed.
  const actualShares = await fetchPositionBalance(trading.client, pos.tokenId);
  const sharesToSell = actualShares > 0 ? actualShares : pos.shares;

  setStatusMessage(`Vendendo ${pos.side} (${exitReason})...`);
  logTrade(`SELL ${pos.side} attempting @ ${(bestBid * 100).toFixed(1)}¢ reason=${exitReason} shares=${sharesToSell}`);

  const result = await sellMarketOrder({ client: trading.client, tokenId: pos.tokenId, amount: sharesToSell, price: sellPriceNum });
  if (!result.ok) {
    const errMsg = `Erro na venda: ${result.error}`;
    setStatusMessage(errMsg, 15000);
    logError(`SELL ${pos.side} ${errMsg}`);
    return { ok: false, error: result.error };
  }

  const fill = parseFillFromOrder(result.order, "SELL");
  const orderId = result.order?.orderID ?? result.order?.id ?? "-";

  if (!fill.success || !fill.filled) {
    const reason = fill.errorMsg || fill.status || "no fill";
    const msg = `SELL ${pos.side} not filled — ${reason} (status=${fill.status})`;
    setStatusMessage(msg, 8000);
    logTrade(`${msg} orderId=${orderId}`);
    return { ok: false, error: reason };
  }

  const exitPrice = fill.avgFillPrice;
  const collateralReceived = fill.collateral;
  const sharesSold = fill.shares;
  const pnl = collateralReceived - pos.invested;
  const roi = pos.invested > 0 ? (pnl / pos.invested) * 100 : 0;
  const sign = pnl >= 0 ? "+" : "";
  const txHash = Array.isArray(result.order?.transactionsHashes) && result.order.transactionsHashes.length > 0
    ? result.order.transactionsHashes[0]
    : null;

  // Verify how much of the position remains on-chain after the fill. If the
  // FAK only partially matched, leftover shares stay on-chain and will redeem
  // at settlement; surface that in the log so it's not silent.
  const remaining = await fetchPositionBalance(trading.client, pos.tokenId);
  const partialTag = remaining > 0.01 ? ` [PARTIAL: ${sharesSold.toFixed(2)} sold, ${remaining.toFixed(2)} left]` : "";

  setStatusMessage(`VENDEU ${pos.side} (${exitReason}) | P&L: ${sign}$${pnl.toFixed(2)}${partialTag}`, 8000);
  logTrade(`SELL ${pos.side} filled avgPrice=${exitPrice.toFixed(4)} collateral=${collateralReceived.toFixed(4)} shares=${sharesSold.toFixed(4)} remaining=${remaining.toFixed(4)} pnl=${pnl.toFixed(4)} roi=${roi.toFixed(2)}% reason=${exitReason} orderId=${orderId}`);
  notifyTrade({ bot: botLabel, isLive: true, action: "SELL", side: pos.side, market: marketSlug, entryPrice: pos.entryPrice, exitPrice, roi, pnl, reason: exitReason });

  onTrade?.({
    action: "SELL", side: pos.side, marketSlug,
    entryPrice: pos.entryPrice, exitPrice, invested: pos.invested,
    shares: sharesSold, pnl, roi, exitReason,
    txHash,
    entryTimestamp: pos.timestamp, timestamp: Date.now(),
  });

  // Always clear in-memory position after a sell. Any leftover shares from a
  // partial fill stay on-chain and will redeem at settlement via redeem.js —
  // we already logged the partial above so the variance is visible.
  recordSell();
  return { ok: true, executedPrice: exitPrice, pnl, roi, partial: remaining > 0.01 };
}
