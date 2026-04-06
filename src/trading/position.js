import { AssetType } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { CONFIG } from "../config.js";

const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e Polygon
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const POLYGON_NETWORK = ethers.Network.from(137);

let _cachedProvider = null;

async function getPolygonProvider() {
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
export function evaluateExit({ position, modelUp, modelDown, currentMarketPrice, timeLeftMin, takeProfitPct, stopLossPct, signalFlipMinProb }) {
  if (!position.active || currentMarketPrice == null) {
    return { shouldSell: false, reason: null, urgency: null };
  }

  const currentValue = position.shares * currentMarketPrice;
  const pnlUsdc = currentValue - position.invested;
  const roiPct = (pnlUsdc / position.invested) * 100;

  const oppositeProb = (modelUp != null && modelDown != null)
    ? (position.side === "UP" ? modelDown : modelUp)
    : null;
  const modelConfirmsReversal = oppositeProb != null && oppositeProb >= signalFlipMinProb;

  // 1. Take profit — só recomenda se o modelo também aponta reversão
  if (roiPct >= takeProfitPct && modelConfirmsReversal) {
    const urgency = oppositeProb >= 0.65 ? "HIGH" : "MEDIUM";
    return { shouldSell: true, reason: "TAKE_PROFIT", urgency, roiPct };
  }

  // 2. Stop loss — só recomenda se o modelo também aponta reversão
  if (roiPct <= -stopLossPct && modelConfirmsReversal) {
    const urgency = oppositeProb >= 0.65 ? "HIGH" : "MEDIUM";
    return { shouldSell: true, reason: "STOP_LOSS", urgency, roiPct };
  }

  // 3. Sinal invertido com força suficiente, independente do ROI
  if (modelConfirmsReversal) {
    const urgency = oppositeProb >= 0.65 ? "HIGH" : "MEDIUM";
    return { shouldSell: true, reason: "SIGNAL_FLIPPED", urgency, roiPct };
  }

  // 4. Pouco tempo + perdendo — só aplica se a entrada foi cara (>= 50¢)
  // Posições baratas já têm o risco precificado; vale segurar até a resolução
  const entryWasCheap = position.entryPrice < 0.50;
  if (timeLeftMin != null && timeLeftMin < 1.5 && roiPct < -5 && !entryWasCheap) {
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

export async function fetchUsdcBalance(funderAddress) {
  const provider = await getPolygonProvider();
  const usdc = new ethers.Contract(USDC_E, ERC20_ABI, provider);
  const raw = await usdc.balanceOf(funderAddress);
  return Number(raw) / 1e6; // USDC.e tem 6 decimais
}
