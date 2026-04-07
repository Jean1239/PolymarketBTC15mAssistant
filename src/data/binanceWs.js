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

const STALE_MS = 30_000;  // force reconnect if no message in 30s
const CHECK_MS = 10_000;

export function startBinanceTradeStream({ symbol = CONFIG.symbol, onUpdate } = {}) {
  let ws = null;
  let closed = false;
  let reconnectMs = 500;
  let lastPrice = null;
  let lastTs = null;
  let lastMessageAt = 0;
  let watchdog = null;

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
        if (p === null) return;
        lastPrice = p;
        lastTs = Date.now();
        if (typeof onUpdate === "function") onUpdate({ price: lastPrice, ts: lastTs });
      } catch {
        return;
      }
    });

    const scheduleReconnect = () => {
      if (closed) return;
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
      try {
        ws?.terminate();
      } catch {
        // ignore
      }
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
    close() {
      closed = true;
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}
