import { AssetType } from "@polymarket/clob-client";

let position = {
  active: false,
  side: null,
  tokenId: null,
  shares: 0,
  entryPrice: 0,
  invested: 0,
  marketSlug: null,
  orderId: null,
  timestamp: null,
};

export function getPosition() {
  return { ...position };
}

export function recordBuy({ side, tokenId, shares, entryPrice, invested, marketSlug, orderId }) {
  position = {
    active: true,
    side,
    tokenId,
    shares,
    entryPrice,
    invested,
    marketSlug,
    orderId: orderId ?? null,
    timestamp: Date.now(),
  };
}

export function recordSell() {
  position = {
    active: false,
    side: null,
    tokenId: null,
    shares: 0,
    entryPrice: 0,
    invested: 0,
    marketSlug: null,
    orderId: null,
    timestamp: null,
  };
}

export function computeROI(currentPrice) {
  if (!position.active || !position.shares || !position.invested) {
    return { currentValue: 0, roi: 0, pnlUsdc: 0 };
  }
  const currentValue = position.shares * currentPrice;
  const pnlUsdc = currentValue - position.invested;
  const roi = (pnlUsdc / position.invested) * 100;
  return { currentValue, roi, pnlUsdc };
}

export function resetIfMarketChanged(currentSlug) {
  if (position.active && position.marketSlug && position.marketSlug !== currentSlug) {
    recordSell();
    return true;
  }
  return false;
}

export async function fetchPositionBalance(client, tokenId) {
  try {
    const res = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    return Number(res?.balance ?? 0);
  } catch {
    return 0;
  }
}
