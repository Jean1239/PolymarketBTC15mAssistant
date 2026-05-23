import { Side, OrderType } from "@polymarket/clob-client-v2";
import fs from "node:fs";
import * as paths from "../paths.js";

function logOrder(action, data) {
  try {
    fs.appendFileSync(paths.tradeOrdersLog,
      `${new Date().toISOString()} [${action}] ${JSON.stringify(data)}\n`);
  } catch { /* ignore */ }
}

export async function buyMarketOrder({ client, tokenId, amount, price }) {
  try {
    const userOrder = {
      tokenID: tokenId,
      amount,
      side: Side.BUY,
    };
    if (price != null && price > 0 && price < 1) {
      userOrder.price = price;
    }
    logOrder("BUY_REQ", userOrder);
    const order = await client.createAndPostMarketOrder(userOrder, undefined, OrderType.FAK);
    logOrder("BUY_RES", order);

    if (order?.error || order?.errorMsg) {
      const reason = order.error || order.errorMsg;
      return { ok: false, error: reason, order };
    }
    return { ok: true, order };
  } catch (err) {
    logOrder("BUY_ERR", { error: err?.message ?? String(err) });
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function sellMarketOrder({ client, tokenId, amount, price }) {
  try {
    const userOrder = {
      tokenID: tokenId,
      amount,
      side: Side.SELL,
    };
    if (price != null && price > 0 && price < 1) {
      userOrder.price = price;
    }
    logOrder("SELL_REQ", userOrder);
    const order = await client.createAndPostMarketOrder(userOrder, undefined, OrderType.FAK);
    logOrder("SELL_RES", order);

    if (order?.error || order?.errorMsg) {
      const reason = order.error || order.errorMsg;
      return { ok: false, error: reason, order };
    }
    return { ok: true, order };
  } catch (err) {
    logOrder("SELL_ERR", { error: err?.message ?? String(err) });
    return { ok: false, error: err?.message ?? String(err) };
  }
}
