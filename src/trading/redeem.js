/**
 * Redeems settled Polymarket conditional tokens back to pUSD.
 *
 * After a binary market resolves, winning tokens are redeemable for $1 each and
 * losing tokens for $0. Neither is credited automatically — the CTF contract
 * must be called explicitly. The Polymarket UMA resolver reports the payout
 * on-chain ~30-90s after a 5m market closes; calling redeemPositions before
 * that returns "result for condition not received yet".
 *
 * This module exposes `createRedemptionWorker()` instead of a one-shot
 * function so callers can enqueue a settlement and the worker retries with
 * backoff until the oracle reports. Items where the wallet holds zero of both
 * outcome tokens are dropped silently (nothing to redeem, no log noise).
 *
 * Post-CLOB-V2 (2026-04-28): the collateral token is Polymarket's pUSD instead
 * of USDC.e. The ConditionalTokens contract address itself did not change.
 */

import { ethers } from "ethers";
import fs from "node:fs";
import { CONFIG } from "../config.js";

const POLYGON_NETWORK = ethers.Network.from(137);
const CTF_ADDRESS     = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // ConditionalTokens (Polygon)
const PUSD_ADDRESS    = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"; // Polymarket pUSD (V2 collateral)
const ZERO_BYTES32    = "0x" + "00".repeat(32);

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

// Backoff schedule for "result for condition not received yet" — Polymarket
// usually reports within ~90s, but UMA disputes can stretch much longer.
// After the last attempt the item is dropped; any leftover shares are still
// redeemable manually later via Polymarket's UI.
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1800_000];

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

function isOracleNotReady(errMsg) {
  return typeof errMsg === "string" && errMsg.includes("result for condition not received yet");
}

/**
 * Worker queue for delayed/retried redemptions. One instance per bot; the main
 * loop calls processPending() each tick and worker fires when items are due.
 */
export function createRedemptionWorker() {
  // Items: { conditionId, slug, holderAddress, upTokenId, downTokenId, attempt, nextRetryMs }
  const queue = [];
  let inflight = false;

  /**
   * Schedule a redemption attempt. Token IDs are required so the worker can
   * skip the on-chain call when the wallet holds zero of both outcomes.
   */
  function enqueue({ conditionId, slug, holderAddress, upTokenId, downTokenId }) {
    if (!conditionId || !holderAddress) return;
    // Dedupe: if already queued for the same conditionId, leave existing entry.
    if (queue.some((q) => q.conditionId === conditionId)) return;
    queue.push({
      conditionId, slug: slug ?? "", holderAddress,
      upTokenId: upTokenId ?? null, downTokenId: downTokenId ?? null,
      attempt: 0,
      // First attempt fires after RETRY_DELAYS_MS[0] (~30s) — gives the UMA
      // oracle time to report the payout before we even check.
      nextRetryMs: Date.now() + RETRY_DELAYS_MS[0],
    });
  }

  /**
   * Fire any redemptions whose retry time has elapsed. Fire-and-forget: never
   * blocks the caller for more than one item per tick.
   */
  async function processPending({ wallet }) {
    if (inflight || !wallet) return;
    const now = Date.now();
    const idx = queue.findIndex((q) => q.nextRetryMs <= now);
    if (idx < 0) return;

    const item = queue[idx];
    inflight = true;

    try {
      const provider = await _getProvider();
      const connected = wallet.connect(provider);
      const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, connected);

      // Skip silently when the wallet holds none of the outcome tokens for
      // this market — nothing to redeem, no need to spam logs.
      if (item.upTokenId && item.downTokenId) {
        const [upBal, downBal] = await Promise.all([
          ctf.balanceOf(item.holderAddress, item.upTokenId).catch(() => 0n),
          ctf.balanceOf(item.holderAddress, item.downTokenId).catch(() => 0n),
        ]);
        if (upBal === 0n && downBal === 0n) {
          queue.splice(idx, 1);
          provider.destroy();
          return;
        }
      }

      logRedeem(`Tentando redemption slug=${item.slug} conditionId=${item.conditionId} attempt=${item.attempt + 1}`);
      const tx = await ctf.redeemPositions(PUSD_ADDRESS, ZERO_BYTES32, item.conditionId, [1, 2]);
      const receipt = await tx.wait();
      logRedeem(`Redemption OK tx=${tx.hash} bloco=${receipt.blockNumber}`);
      queue.splice(idx, 1);
      provider.destroy();
    } catch (err) {
      const msg = err?.message ?? String(err);
      const oracleNotReady = isOracleNotReady(msg);
      item.attempt += 1;

      if (item.attempt >= RETRY_DELAYS_MS.length) {
        logRedeem(`Desistindo após ${item.attempt} tentativas slug=${item.slug}: ${msg.slice(0, 200)}`);
        queue.splice(idx, 1);
      } else {
        const delay = RETRY_DELAYS_MS[item.attempt];
        item.nextRetryMs = Date.now() + delay;
        const reason = oracleNotReady ? "oracle ainda não reportou" : msg.slice(0, 120);
        logRedeem(`Retry agendado em ${delay / 1000}s slug=${item.slug} (${reason})`);
      }
    } finally {
      inflight = false;
    }
  }

  return { enqueue, processPending, _peek: () => queue.slice() };
}

/**
 * Back-compat shim for callers that still want a one-shot redemption (no
 * retry, no balance check). New code should use createRedemptionWorker().
 */
export async function redeemSettledPositions({ wallet, conditionId, marketSlug = "" }) {
  if (!wallet || !conditionId) {
    return { ok: false, error: "missing wallet or conditionId" };
  }
  logRedeem(`Iniciando redemption (one-shot) slug=${marketSlug} conditionId=${conditionId}`);
  try {
    const provider = await _getProvider();
    const connected = wallet.connect(provider);
    const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, connected);
    const tx = await ctf.redeemPositions(PUSD_ADDRESS, ZERO_BYTES32, conditionId, [1, 2]);
    const receipt = await tx.wait();
    logRedeem(`Redemption confirmada: ${tx.hash} bloco=${receipt.blockNumber}`);
    provider.destroy();
    return { ok: true, txHash: tx.hash };
  } catch (err) {
    const msg = err?.message ?? String(err);
    logRedeem(`Erro no redemption (one-shot): ${msg.slice(0, 200)}`);
    return { ok: false, error: msg };
  }
}
