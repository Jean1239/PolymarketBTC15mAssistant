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

// Avalia se a posição aberta deve ser encerrada.
// Retorna { shouldSell, reason, urgency } onde urgency é "HIGH" | "MEDIUM" | null
export function evaluateExit({ position, modelUp, modelDown, currentMarketPrice, timeLeftMin, takeProfitPct, stopLossPct, signalFlipMinProb }) {
  if (!position.active || currentMarketPrice == null) {
    return { shouldSell: false, reason: null, urgency: null };
  }

  const currentValue = position.shares * currentMarketPrice;
  const pnlUsdc = currentValue - position.invested;
  const roiPct = (pnlUsdc / position.invested) * 100;

  // 1. Take profit
  if (roiPct >= takeProfitPct) {
    return { shouldSell: true, reason: "TAKE_PROFIT", urgency: "MEDIUM", roiPct };
  }

  // 2. Stop loss
  if (roiPct <= -stopLossPct) {
    return { shouldSell: true, reason: "STOP_LOSS", urgency: "HIGH", roiPct };
  }

  // 3. Sinal invertido — modelo agora favorece o lado oposto com confiança
  if (modelUp != null && modelDown != null) {
    const oppositeProb = position.side === "UP" ? modelDown : modelUp;
    if (oppositeProb >= signalFlipMinProb) {
      const urgency = oppositeProb >= 0.65 ? "HIGH" : "MEDIUM";
      return { shouldSell: true, reason: "SIGNAL_FLIPPED", urgency, roiPct };
    }
  }

  // 4. Pouco tempo + perdendo — reduz exposição
  if (timeLeftMin != null && timeLeftMin < 1.5 && roiPct < -5) {
    return { shouldSell: true, reason: "TIME_DECAY", urgency: "MEDIUM", roiPct };
  }

  return { shouldSell: false, reason: null, urgency: null, roiPct };
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
