// Enhanced Binance WebSocket trade stream that tracks Order Flow Imbalance (OFI).
// Accumulates buy vs sell volume in rolling time windows (30s, 1m, 2m).

import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function buildWsUrl(symbol) {
  const s = String(symbol || "").toLowerCase();
  return `wss://stream.binance.com:9443/ws/${s}@trade`;
}

const STALE_MS = 30_000;
const CHECK_MS = 10_000;

export function startBinanceOfiStream({ symbol = CONFIG.symbol } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let lastPrice = null;
  let lastTs = null;
  let lastMessageAt = 0;
  let watchdog = null;

  // Ring buffer of recent trades: { price, qty, isBuyerMaker, ts }
  const trades = [];
  const MAX_BUFFER_AGE_MS = 150_000; // keep 2.5 min of trades

  function pruneOld() {
    const cutoff = Date.now() - MAX_BUFFER_AGE_MS;
    while (trades.length > 0 && trades[0].ts < cutoff) {
      trades.shift();
    }
  }

  function computeOfi(windowMs) {
    const cutoff = Date.now() - windowMs;
    let buyVol = 0;
    let sellVol = 0;
    for (let i = trades.length - 1; i >= 0; i--) {
      const t = trades[i];
      if (t.ts < cutoff) break;
      // isBuyerMaker=true means the buyer placed a limit order and the seller
      // hit it with a market order → the trade is a sell (taker sells).
      if (t.isBuyerMaker) {
        sellVol += t.qty;
      } else {
        buyVol += t.qty;
      }
    }
    const total = buyVol + sellVol;
    return {
      buyVol,
      sellVol,
      total,
      ofi: total > 0 ? (buyVol - sellVol) / total : 0
    };
  }

  const connect = () => {
    if (closed) return;
    if (watchdog) { clearInterval(watchdog); watchdog = null; }

    const url = buildWsUrl(symbol);
    ws = new WebSocket(url, { agent: wsAgentForUrl(url) });

    ws.on("open", () => {
      reconnectMs = 500;
      lastMessageAt = Date.now();
      watchdog = setInterval(() => {
        if (Date.now() - lastMessageAt > STALE_MS) scheduleReconnect();
      }, CHECK_MS);
    });

    ws.on("message", (buf) => {
      lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(buf.toString());
        const p = toNumber(msg.p);
        const q = toNumber(msg.q);
        if (p === null || q === null) return;

        lastPrice = p;
        lastTs = Date.now();

        trades.push({
          price: p,
          qty: q * p, // store in USD terms for volume comparisons
          isBuyerMaker: msg.m === true,
          ts: lastTs
        });

        // Prune periodically (every ~500 trades)
        if (trades.length % 500 === 0) pruneOld();
      } catch {
        return;
      }
    });

    const scheduleReconnect = () => {
      if (closed) return;
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
      try { ws?.terminate(); } catch { /* ignore */ }
      ws = null;
      const wait = reconnectMs;
      reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
      setTimeout(connect, wait);
    };

    ws.on("close", scheduleReconnect);
    ws.on("error", scheduleReconnect);
  };

  connect();

  return {
    getLast() {
      return { price: lastPrice, ts: lastTs };
    },
    getOfi() {
      pruneOld();
      return {
        ofi30s: computeOfi(30_000),
        ofi1m: computeOfi(60_000),
        ofi2m: computeOfi(120_000)
      };
    },
    getTradeCount() {
      return trades.length;
    },
    close() {
      closed = true;
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
    }
  };
}
