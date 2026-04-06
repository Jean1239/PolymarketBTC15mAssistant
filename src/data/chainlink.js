import { ethers } from "ethers";
import { CONFIG } from "../config.js";

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function getRoundData(uint80 _roundId) view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)"
];

const iface = new ethers.Interface(AGGREGATOR_ABI);

let preferredRpcUrl = null;

let cachedDecimals = null;
let cachedResult = { price: null, updatedAt: null, source: "chainlink" };
let cachedFetchedAtMs = 0;
const MIN_FETCH_INTERVAL_MS = 2_000;
const RPC_TIMEOUT_MS = 1_500;

function getRpcCandidates() {
  const fromList = Array.isArray(CONFIG.chainlink.polygonRpcUrls) ? CONFIG.chainlink.polygonRpcUrls : [];
  const single = CONFIG.chainlink.polygonRpcUrl ? [CONFIG.chainlink.polygonRpcUrl] : [];
  const defaults = [
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com"
  ];

  const all = [...fromList, ...single, ...defaults].map((s) => String(s).trim()).filter(Boolean);
  return Array.from(new Set(all));
}

function getOrderedRpcs() {
  const rpcs = getRpcCandidates();
  const pref = preferredRpcUrl;
  if (pref && rpcs.includes(pref)) {
    return [pref, ...rpcs.filter((x) => x !== pref)];
  }
  return rpcs;
}

async function jsonRpcRequest(rpcUrl, method, params) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`rpc_http_${res.status}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`rpc_error_${data.error.code}`);
    }
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

async function ethCall(rpcUrl, to, data) {
  return await jsonRpcRequest(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

async function fetchDecimals(rpcUrl, aggregator) {
  const data = iface.encodeFunctionData("decimals", []);
  const result = await ethCall(rpcUrl, aggregator, data);
  const [dec] = iface.decodeFunctionResult("decimals", result);
  return Number(dec);
}

async function fetchLatestRoundData(rpcUrl, aggregator) {
  const data = iface.encodeFunctionData("latestRoundData", []);
  const result = await ethCall(rpcUrl, aggregator, data);
  const decoded = iface.decodeFunctionResult("latestRoundData", result);
  return {
    roundId: decoded[0],
    answer: decoded[1],
    updatedAt: decoded[3]
  };
}

async function fetchRoundData(rpcUrl, aggregator, roundId) {
  const data = iface.encodeFunctionData("getRoundData", [roundId]);
  const result = await ethCall(rpcUrl, aggregator, data);
  const decoded = iface.decodeFunctionResult("getRoundData", result);
  return {
    roundId: decoded[0],
    answer: decoded[1],
    updatedAt: decoded[3]
  };
}

// Finds the Chainlink round whose updatedAt is the first one >= targetTimeSec.
// Uses binary search over the aggregator-level round index embedded in the roundId.
async function findRoundAtTimestamp(rpcUrl, aggregator, targetTimeSec) {
  const latest = await fetchLatestRoundData(rpcUrl, aggregator);
  const latestId = BigInt(latest.roundId);
  const PHASE_MASK = BigInt("0xFFFFFFFFFFFFFFFF");
  const phaseId = latestId >> BigInt(64);
  const latestAggRound = latestId & PHASE_MASK;

  // Binary search for the earliest round with updatedAt >= targetTimeSec
  let lo = BigInt(1);
  let hi = latestAggRound;
  let result = latest;

  while (lo <= hi) {
    const mid = (lo + hi) / BigInt(2);
    const roundId = (phaseId << BigInt(64)) | mid;
    try {
      const rd = await fetchRoundData(rpcUrl, aggregator, roundId);
      const updatedAt = Number(rd.updatedAt);
      if (updatedAt === 0) { lo = mid + BigInt(1); continue; }
      if (updatedAt >= targetTimeSec) {
        result = rd;
        hi = mid - BigInt(1);
      } else {
        lo = mid + BigInt(1);
      }
    } catch {
      lo = mid + BigInt(1);
    }
  }
  return result;
}

// Returns the Chainlink BTC/USD price at (or just after) a given Unix timestamp in ms.
export async function fetchChainlinkPriceAtMs(targetMs) {
  if (!CONFIG.chainlink.btcUsdAggregator) return null;
  const targetSec = Math.floor(targetMs / 1000);
  const rpcs = getOrderedRpcs();
  if (rpcs.length === 0) return null;

  const aggregator = CONFIG.chainlink.btcUsdAggregator;
  for (const rpc of rpcs) {
    try {
      if (cachedDecimals === null) {
        cachedDecimals = await fetchDecimals(rpc, aggregator);
      }
      const round = await findRoundAtTimestamp(rpc, aggregator, targetSec);
      const scale = 10 ** Number(cachedDecimals);
      return Number(round.answer) / scale;
    } catch {
      cachedDecimals = null;
      continue;
    }
  }
  return null;
}

export async function fetchChainlinkBtcUsd() {
  if ((!CONFIG.chainlink.polygonRpcUrl && (!CONFIG.chainlink.polygonRpcUrls || CONFIG.chainlink.polygonRpcUrls.length === 0)) || !CONFIG.chainlink.btcUsdAggregator) {
    return { price: null, updatedAt: null, source: "missing_config" };
  }

  const now = Date.now();
  if (cachedFetchedAtMs && now - cachedFetchedAtMs < MIN_FETCH_INTERVAL_MS) {
    return cachedResult;
  }

  const rpcs = getOrderedRpcs();
  if (rpcs.length === 0) return { price: null, updatedAt: null, source: "missing_config" };

  const aggregator = CONFIG.chainlink.btcUsdAggregator;

  for (const rpc of rpcs) {
    preferredRpcUrl = rpc;
    try {
      if (cachedDecimals === null) {
        cachedDecimals = await fetchDecimals(rpc, aggregator);
      }

      const round = await fetchLatestRoundData(rpc, aggregator);
      const answer = Number(round.answer);
      const scale = 10 ** Number(cachedDecimals);
      const price = answer / scale;

      cachedResult = {
        price,
        updatedAt: Number(round.updatedAt) * 1000,
        source: "chainlink"
      };
      cachedFetchedAtMs = now;
      preferredRpcUrl = rpc;
      return cachedResult;
    } catch {
      cachedDecimals = null;
      continue;
    }
  }

  return cachedResult;
}
