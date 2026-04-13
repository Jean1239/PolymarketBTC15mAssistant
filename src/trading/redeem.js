/**
 * Redeems settled Polymarket conditional tokens back to USDC.
 *
 * After a binary market resolves, winning tokens are redeemable for $1 each and
 * losing tokens for $0. Neither is credited automatically — the CTF contract must
 * be called explicitly. Without this, won USDC stays locked in unredeemed tokens
 * and the bot's CLOB balance never recovers.
 *
 * Redeeming both index sets ([1, 2]) is safe: the CTF contract pays out only for
 * tokens actually held; redeeming losing tokens costs a tiny amount of gas and
 * returns nothing.
 */

import { ethers } from "ethers";
import fs from "node:fs";
import { CONFIG } from "../config.js";

const POLYGON_NETWORK = ethers.Network.from(137);
const CTF_ADDRESS     = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // ConditionalTokens (Polygon)
const USDC_E_ADDRESS  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ZERO_BYTES32    = "0x" + "00".repeat(32);

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
];

function logRedeem(msg) {
  try {
    fs.appendFileSync("./logs/trade_orders.log",
      `${new Date().toISOString()} [REDEEM] ${msg}\n`);
  } catch { /* ignore */ }
}

async function _getProvider() {
  const rpcs = [
    ...(CONFIG.chainlink.polygonRpcUrls ?? []),
    CONFIG.chainlink.polygonRpcUrl,
    "https://polygon-bor-rpc.publicnode.com",
    "https://rpc.ankr.com/polygon",
  ].map(s => String(s || "").trim()).filter(Boolean);

  for (const rpc of rpcs) {
    const p = new ethers.JsonRpcProvider(rpc, POLYGON_NETWORK, { staticNetwork: POLYGON_NETWORK });
    try {
      await Promise.race([
        p.getBlockNumber(),
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 3000)),
      ]);
      return p;
    } catch {
      p.destroy();
    }
  }
  throw new Error("Nenhum RPC Polygon disponível para redemption");
}

/**
 * Redeems all positions for a settled market.
 *
 * @param {{ wallet: import("ethers").Wallet, conditionId: string, marketSlug?: string }} params
 * @returns {Promise<{ ok: boolean, txHash?: string, error?: string }>}
 */
export async function redeemSettledPositions({ wallet, conditionId, marketSlug = "" }) {
  if (!wallet || !conditionId) {
    return { ok: false, error: "missing wallet or conditionId" };
  }

  logRedeem(`Iniciando redemption slug=${marketSlug} conditionId=${conditionId}`);

  try {
    const provider    = await _getProvider();
    const connected   = wallet.connect(provider);
    const ctf         = new ethers.Contract(CTF_ADDRESS, CTF_ABI, connected);

    // Redeem both outcomes: indexSet 1 = outcome 0 (Down/No), indexSet 2 = outcome 1 (Up/Yes)
    const tx = await ctf.redeemPositions(USDC_E_ADDRESS, ZERO_BYTES32, conditionId, [1, 2]);
    logRedeem(`Tx enviada: ${tx.hash} — aguardando confirmação...`);

    const receipt = await tx.wait();
    logRedeem(`Redemption confirmada: ${tx.hash} bloco=${receipt.blockNumber}`);
    provider.destroy();
    return { ok: true, txHash: tx.hash };
  } catch (err) {
    const msg = err?.message ?? String(err);
    logRedeem(`Erro no redemption: ${msg}`);
    return { ok: false, error: msg };
  }
}
