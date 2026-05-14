import fs from "node:fs";
import { clamp } from "../utils.js";
import { setStatusMessage } from "../display.js";
import { buyMarketOrder, sellMarketOrder } from "./orders.js";
import { getPosition, recordBuy, recordSell, fetchPositionBalance } from "./position.js";
import { notifyTrade } from "../notify.js";

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
 * btcVsPtb, cooldown). The only extra check here is slippage: if the live
 * bestAsk drifted too far from the price the sim decided on, abort.
 *
 * @returns {Promise<{ok: true, executedPrice: number, shares: number} | {ok: false, error: string}>}
 */
export async function executeRealBuy({ trading, poly, side, simDecisionPrice, slippageTolerancePct, marketSlug, botLabel = "bot", onTrade = null }) {
  if (!trading.tradingEnabled || !poly.ok) {
    return { ok: false, error: "trading disabled or poly snapshot not ok" };
  }
  if (getPosition().active) {
    return { ok: false, error: "position already open" };
  }

  const book = side === "UP" ? poly.orderbook.up : poly.orderbook.down;
  const bestAsk = book?.bestAsk ?? null;

  const slip = checkSlippage({ livePrice: bestAsk, simDecisionPrice, slippageTolerancePct });
  if (!slip.ok) {
    const msg = `BUY ${side} skipped — ${slip.error} (sim=${simDecisionPrice} live=${slip.livePrice})`;
    setStatusMessage(msg, 5000);
    logTrade(msg);
    return { ok: false, error: slip.error };
  }

  const priceNum = clamp(bestAsk + 0.02, 0, 0.97);
  const invested = trading.tradeAmount;
  const tokenId = side === "UP" ? poly.tokens.upTokenId : poly.tokens.downTokenId;

  setStatusMessage(`Comprando ${side} (sim)...`);
  logTrade(`BUY ${side} attempting @ ${(bestAsk * 100).toFixed(1)}¢ (sim=${(simDecisionPrice * 100).toFixed(1)}¢) $${invested}`);

  const result = await buyMarketOrder({ client: trading.client, tokenId, amount: invested, price: priceNum });
  if (!result.ok) {
    const errMsg = `Erro na compra: ${result.error}`;
    setStatusMessage(errMsg, 15000);
    logError(`BUY ${side} ${errMsg}`);
    return { ok: false, error: result.error };
  }

  const balance = await fetchPositionBalance(trading.client, tokenId);
  const shares = balance > 0 ? balance : invested / bestAsk;
  recordBuy({ side, tokenId, shares, entryPrice: bestAsk, invested, marketSlug, orderId: result.order?.orderID });

  const orderId = result.order?.orderID ?? result.order?.id ?? "-";
  setStatusMessage(`COMPROU ${side} @ ${(bestAsk * 100).toFixed(1)}¢ | $${invested} | shares: ${shares.toFixed(2)} | ID: ${String(orderId).slice(0, 12)}`, 8000);
  logTrade(`BUY ${side} filled price=${bestAsk} invested=${invested} shares=${shares} orderId=${orderId}`);
  notifyTrade({ bot: botLabel, isLive: true, action: "BUY", side, market: marketSlug, entryPrice: bestAsk, invested });

  onTrade?.({
    action: "BUY", side, marketSlug,
    entryPrice: bestAsk, invested, shares,
    timestamp: Date.now(),
  });

  return { ok: true, executedPrice: bestAsk, shares };
}

/**
 * Place a real SELL in response to a sim SELL decision.
 *
 * @returns {Promise<{ok: true, executedPrice: number, pnl: number, roi: number} | {ok: false, error: string}>}
 */
export async function executeRealSell({ trading, poly, simDecisionPrice, slippageTolerancePct, exitReason = "SIM_EXIT", marketSlug, botLabel = "bot", onTrade = null }) {
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

  const sellPriceNum = clamp(bestBid - 0.02, 0.03, 1);
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

  const exitPrice = bestBid;
  const pnl = (sharesToSell * exitPrice) - pos.invested;
  const roi = (pnl / pos.invested) * 100;
  const sign = pnl >= 0 ? "+" : "";
  setStatusMessage(`VENDEU ${pos.side} (${exitReason}) | P&L: ${sign}$${pnl.toFixed(2)}`, 8000);
  logTrade(`SELL ${pos.side} filled price=${exitPrice} pnl=${pnl.toFixed(4)} roi=${roi.toFixed(2)}% reason=${exitReason}`);
  notifyTrade({ bot: botLabel, isLive: true, action: "SELL", side: pos.side, market: marketSlug, entryPrice: pos.entryPrice, exitPrice, roi, pnl, reason: exitReason });

  onTrade?.({
    action: "SELL", side: pos.side, marketSlug,
    entryPrice: pos.entryPrice, exitPrice, invested: pos.invested,
    shares: sharesToSell, pnl, roi, exitReason,
    entryTimestamp: pos.timestamp, timestamp: Date.now(),
  });

  recordSell();
  return { ok: true, executedPrice: exitPrice, pnl, roi };
}
