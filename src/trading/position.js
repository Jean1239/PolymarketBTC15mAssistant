import { AssetType } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { CONFIG } from "../config.js";

const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e Polygon
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const POLYGON_NETWORK = ethers.Network.from(137);

let _cachedProvider = null;
let _providerInitPromise = null;

async function getPolygonProvider() {
  if (_cachedProvider) return _cachedProvider;
  if (_providerInitPromise) return _providerInitPromise;
  _providerInitPromise = _initProvider().finally(() => { _providerInitPromise = null; });
  return _providerInitPromise;
}

async function _initProvider() {
  if (_cachedProvider) return _cachedProvider;

  const rpcs = [
    ...(CONFIG.chainlink.polygonRpcUrls ?? []),
    CONFIG.chainlink.polygonRpcUrl,
    "https://polygon-bor-rpc.publicnode.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com",
  ].map(s => String(s || "").trim()).filter(Boolean);

  for (const rpc of rpcs) {
    // staticNetwork=true evita auto-detecção (e os logs de retry) no ethers v6
    const p = new ethers.JsonRpcProvider(rpc, POLYGON_NETWORK, { staticNetwork: POLYGON_NETWORK });
    try {
      await Promise.race([
        p.getBlockNumber(),
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 3000)),
      ]);
      _cachedProvider = p;
      return p;
    } catch {
      p.destroy();
    }
  }
  throw new Error("Nenhum RPC Polygon disponível");
}

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
export function evaluateExit({ position, modelUp, modelDown, currentMarketPrice, timeLeftMin, takeProfitPct, stopLossPct, signalFlipMinProb, stopLossMinProb = null, stopLossMinDurationS = 0, flipConfirmCount = 0, flipConfirmTicks = 1, btcPrice = null, priceToBeat = null, ptbSafeMarginUsd = 30, disableStopLoss = false, disableSignalFlip = false, disableTimeDecay = false, timeDecayMinLeftMin = 1.5, timeDecayMinLossPct = 5 }) {
  if (!position.active || currentMarketPrice == null) {
    return { shouldSell: false, reason: null, urgency: null, flipConfirmCount: 0 };
  }

  const currentValue = position.shares * currentMarketPrice;
  const pnlUsdc = currentValue - position.invested;
  const roiPct = (pnlUsdc / position.invested) * 100;

  const oppositeProb = (modelUp != null && modelDown != null)
    ? (position.side === "UP" ? modelDown : modelUp)
    : null;
  const modelConfirmsReversal = oppositeProb != null && oppositeProb >= signalFlipMinProb;

  // PTB safety guard: if BTC is safely on the winning side of the price-to-beat,
  // suppress SL/SIGNAL_FLIP/TIME_DECAY exits — the position is likely to settle as a win.
  const ptbMargin = (btcPrice != null && priceToBeat != null)
    ? (position.side === "UP" ? btcPrice - priceToBeat : priceToBeat - btcPrice)
    : null;
  const ptbSafe = ptbMargin !== null && ptbMargin >= ptbSafeMarginUsd;

  // Effective minimum prob for stop-loss (may be stricter than signalFlipMinProb)
  const slMinProb = stopLossMinProb ?? signalFlipMinProb;
  const slConfirmed = oppositeProb != null && oppositeProb >= slMinProb;
  const positionAgeS = position.timestamp ? (Date.now() - position.timestamp) / 1000 : Infinity;
  const slAgedEnough = positionAgeS >= stopLossMinDurationS;

  // 1. Take profit — só recomenda se o modelo também aponta reversão
  if (roiPct >= takeProfitPct && modelConfirmsReversal) {
    const urgency = oppositeProb >= 0.65 ? "HIGH" : "MEDIUM";
    return { shouldSell: true, reason: "TAKE_PROFIT", urgency, roiPct, flipConfirmCount: 0 };
  }

  // 2. Stop loss — suprimido se PTB seguro ou desabilitado por config
  if (!ptbSafe && !disableStopLoss && roiPct <= -stopLossPct && slConfirmed && slAgedEnough) {
    const urgency = oppositeProb >= 0.65 ? "HIGH" : "MEDIUM";
    return { shouldSell: true, reason: "STOP_LOSS", urgency, roiPct, flipConfirmCount: 0 };
  }

  // 3. Sinal invertido — suprimido se PTB seguro ou desabilitado; requer N ticks consecutivos
  if (!ptbSafe && !disableSignalFlip && modelConfirmsReversal) {
    const newCount = flipConfirmCount + 1;
    if (newCount >= flipConfirmTicks) {
      const urgency = oppositeProb >= 0.65 ? "HIGH" : "MEDIUM";
      return { shouldSell: true, reason: "SIGNAL_FLIPPED", urgency, roiPct, flipConfirmCount: newCount };
    }
    return { shouldSell: false, reason: null, urgency: null, roiPct, flipConfirmCount: newCount };
  }

  // 4. Pouco tempo + perdendo — suprimido se PTB seguro, desabilitado por config, ou entrada barata (< 50¢)
  const entryWasCheap = position.entryPrice < 0.50;
  if (!ptbSafe && !disableTimeDecay && timeLeftMin != null && timeLeftMin < timeDecayMinLeftMin && roiPct < -timeDecayMinLossPct && !entryWasCheap) {
    return { shouldSell: true, reason: "TIME_DECAY", urgency: "MEDIUM", roiPct, flipConfirmCount: 0 };
  }

  return { shouldSell: false, reason: null, urgency: null, roiPct, flipConfirmCount: 0 };
}

export async function fetchPositionBalance(client, tokenId) {
  try {
    const res = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    // getBalanceAllowance returns raw token units (6 decimals); convert to shares
    return Number(res?.balance ?? 0) / 1e6;
  } catch {
    return 0;
  }
}

export async function fetchUsdcBalance(funderAddress) {
  const provider = await getPolygonProvider();
  const usdc = new ethers.Contract(USDC_E, ERC20_ABI, provider);
  const raw = await usdc.balanceOf(funderAddress);
  return Number(raw) / 1e6; // USDC.e tem 6 decimais
}
