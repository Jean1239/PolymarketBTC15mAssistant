import { Side } from "@polymarket/clob-client";
import fs from "node:fs";

function logOrder(action, data) {
  try {
    fs.mkdirSync("./logs", { recursive: true });
    fs.appendFileSync("./logs/trade_orders.log",
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
    const order = await client.createAndPostMarketOrder(userOrder);
    logOrder("BUY_RES", order);

    // Check if the order was actually accepted/matched
    const success = order && !order.error && !order.errorMsg && order.success !== false && order.status !== "DEAD";
    if (!success) {
      const reason = order?.error || order?.errorMsg || order?.status || "ordem não preenchida (FOK rejeitada)";
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
    const order = await client.createAndPostMarketOrder(userOrder);
    logOrder("SELL_RES", order);

    const success = order && !order.error && !order.errorMsg && order.success !== false && order.status !== "DEAD";
    if (!success) {
      const reason = order?.error || order?.errorMsg || order?.status || "ordem não preenchida (FOK rejeitada)";
      return { ok: false, error: reason, order };
    }
    return { ok: true, order };
  } catch (err) {
    logOrder("SELL_ERR", { error: err?.message ?? String(err) });
    return { ok: false, error: err?.message ?? String(err) };
  }
}
