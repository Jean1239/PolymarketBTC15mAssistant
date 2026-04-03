import { Side } from "@polymarket/clob-client";

export async function buyMarketOrder({ client, tokenId, amount }) {
  try {
    const order = await client.createAndPostMarketOrder({
      tokenID: tokenId,
      amount,
      side: Side.BUY,
    });
    return { ok: true, order };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function sellMarketOrder({ client, tokenId, amount }) {
  try {
    const order = await client.createAndPostMarketOrder({
      tokenID: tokenId,
      amount,
      side: Side.SELL,
    });
    return { ok: true, order };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
