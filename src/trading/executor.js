import fs from "node:fs";
import { clamp } from "../utils.js";
import { setStatusMessage } from "../display.js";
import { buyMarketOrder, sellMarketOrder } from "./orders.js";
import { getPosition, recordBuy, recordSell, fetchPositionBalance } from "./position.js";

function logError(msg) {
  try {
    fs.mkdirSync("./logs", { recursive: true });
    fs.appendFileSync("./logs/trade_errors.log", `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}

/**
 * Drains the action queue produced by setupKeyboard(), executing each buy/sell
 * against the Polymarket CLOB.
 *
 * @param {Array}  actionQueue  - mutated in place (items shifted out)
 * @param {object} ctx
 * @param {object} ctx.trading      - { client, tradingEnabled, tradeAmount }
 * @param {object} ctx.poly         - fetchPolymarketSnapshot() result
 * @param {object} ctx.rec          - decide() / decide5m() result
 * @param {object} ctx.timeAware    - applyTimeAwareness() result
 * @param {string} ctx.marketSlugNow
 * @param {Function} [ctx.onSold]   - called with { side, entryPrice, exitPrice, pnl, roi } after a sell
 */
export async function processActionQueue(actionQueue, { trading, poly, rec, timeAware, marketSlugNow, onSold }) {
  while (actionQueue.length && trading.tradingEnabled && poly.ok) {
    const action = actionQueue.shift();
    const marketUp = poly.prices.up;
    const marketDown = poly.prices.down;

    if (action.type === "buy") {
      const pos = getPosition();
      if (pos.active) {
        setStatusMessage("Já existe posição aberta");
        continue;
      }
      const side = rec.action === "ENTER"
        ? rec.side
        : (timeAware.adjustedUp >= timeAware.adjustedDown ? "UP" : "DOWN");
      const tokenId = side === "UP" ? poly.tokens.upTokenId : poly.tokens.downTokenId;
      const book = side === "UP" ? poly.orderbook.up : poly.orderbook.down;
      const rawAsk = book?.bestAsk ?? (side === "UP" ? marketUp : marketDown);
      const priceNum = rawAsk != null ? clamp(rawAsk + 0.02, 0, 0.97) : 0.5;
      const entryRef = rawAsk ?? priceNum;

      setStatusMessage(`Comprando ${side}...`);
      const result = await buyMarketOrder({ client: trading.client, tokenId, amount: trading.tradeAmount, price: priceNum });
      if (result.ok) {
        const balance = await fetchPositionBalance(trading.client, tokenId);
        const shares = balance > 0 ? balance : trading.tradeAmount / entryRef;
        recordBuy({ side, tokenId, shares, entryPrice: entryRef, invested: trading.tradeAmount, marketSlug: marketSlugNow, orderId: result.order?.orderID });
        const orderId = result.order?.orderID ?? result.order?.id ?? "-";
        const balanceStr = balance > 0 ? `shares: ${balance.toFixed(2)}` : "saldo 0 (ordem não preenchida?)";
        setStatusMessage(`COMPROU ${side} @ ${(entryRef * 100).toFixed(1)}¢ | $${trading.tradeAmount} | ${balanceStr} | ID: ${String(orderId).slice(0, 12)}`, 8000);
      } else {
        const errMsg = `Erro na compra: ${result.error}`;
        setStatusMessage(errMsg, 15000);
        logError(`BUY ${side} ${errMsg}`);
      }
    } else if (action.type === "sell") {
      const pos = getPosition();
      if (!pos.active) {
        setStatusMessage("Nenhuma posição para vender");
        continue;
      }
      setStatusMessage(`Vendendo ${pos.side}...`);
      const sellBook = pos.side === "UP" ? poly.orderbook.up : poly.orderbook.down;
      const rawBid = sellBook?.bestBid ?? (pos.side === "UP" ? marketUp : marketDown);
      const sellPriceNum = rawBid != null ? clamp(rawBid - 0.02, 0.03, 1) : 0.5;
      const actualShares = await fetchPositionBalance(trading.client, pos.tokenId);
      const sharesToSell = actualShares > 0 ? actualShares : pos.shares;

      const result = await sellMarketOrder({ client: trading.client, tokenId: pos.tokenId, amount: sharesToSell, price: sellPriceNum });
      if (result.ok) {
        const exitPrice = rawBid ?? sellPriceNum;
        const pnl = (sharesToSell * exitPrice) - pos.invested;
        const roi = (pnl / pos.invested) * 100;
        const sign = pnl >= 0 ? "+" : "";
        setStatusMessage(`VENDEU ${pos.side} | P&L: ${sign}$${pnl.toFixed(2)}`, 8000);
        recordSell();
        onSold?.({ side: pos.side, entryPrice: pos.entryPrice, exitPrice, pnl, roi });
      } else {
        const errMsg = `Erro na venda: ${result.error}`;
        setStatusMessage(errMsg, 15000);
        logError(`SELL ${pos.side} ${errMsg}`);
      }
    }
  }
}
