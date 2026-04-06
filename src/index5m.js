import { CONFIG } from "./config5m.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd, fetchChainlinkPriceAtMs } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { startBinanceOfiStream } from "./data/binanceWsOfi.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, slopeLast } from "./indicators/rsi.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { computeEmaCross } from "./indicators/emaCross.js";
import { scoreOrderFlow } from "./indicators/orderFlow.js";
import { computeMomentum, scoreMomentum } from "./indicators/momentum.js";
import { scoreDirection5m, applyTimeAwareness5m } from "./engines/probability5m.js";
import { computeEdge, decide5m } from "./engines/edge5m.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import fs from "node:fs";
import path from "node:path";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import {
  ANSI, renderScreen, buildScreen, kv,
  colorPriceLine, formatSignedDelta, formatNumberDisplay,
  colorByNarrative, formatNarrativeValue, narrativeFromSign,
  narrativeFromSlope, formatProbPct, fmtEtHHMM, fmtTimeLeft,
  safeFileSlug, priceToBeatFromPolymarketMarket,
  setStatusMessage
} from "./display.js";
import { initTradingClient } from "./trading/client.js";
import { buyMarketOrder, sellMarketOrder } from "./trading/orders.js";
import { getPosition, recordBuy, recordSell, computeROI, resetIfMarketChanged, fetchPositionBalance, evaluateExit } from "./trading/position.js";

applyGlobalProxyFromEnv();

const dumpedMarkets = new Set();

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return { ok: false, reason: "missing_token_ids", market, outcomes, clobTokenIds, outcomePrices };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

function ofiLabel(ofi) {
  if (!ofi || ofi.total === 0) return "-";
  const pct = (ofi.ofi * 100).toFixed(0);
  const sign = ofi.ofi > 0 ? "+" : "";
  return `${sign}${pct}%`;
}

function ofiNarrative(ofi) {
  if (!ofi || ofi.total === 0) return "NEUTRAL";
  if (ofi.ofi > 0.05) return "LONG";
  if (ofi.ofi < -0.05) return "SHORT";
  return "NEUTRAL";
}

async function main() {
  const ofiStream = startBinanceOfiStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  // --- Trading setup ---
  let trading = { client: null, tradingEnabled: false, tradeAmount: 0, initError: null };
  try {
    trading = await initTradingClient(CONFIG);
  } catch (err) {
    trading.initError = err?.message ?? String(err);
  }

  const actionQueue = [];
  let pendingAction = null;
  let lastPoly = null;
  let lastRec = null;

  let stdinError = null;
  try {
    if (!process.stdin.isTTY) throw new Error("stdin não é TTY — rode com: node src/index5m.js");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key) => {
      const ch = key.toString().toLowerCase();
      if (trading.tradingEnabled) {
        if (pendingAction !== null) {
          if (ch === "y") { actionQueue.push({ ...pendingAction }); pendingAction = null; }
          else if (ch === "n" || key[0] === 0x1b) { pendingAction = null; }
        } else {
          if (ch === "b") pendingAction = { type: "buy" };
          else if (ch === "s") pendingAction = { type: "sell" };
        }
      }
      if (ch === "q" || key[0] === 0x03) process.exit(0);
    });
  } catch (err) {
    stdinError = err?.message ?? String(err);
  }

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };
  let priceToBeatFetching = false;

  let tradeState = { slug: null, side: null, entryMarketPrice: null, priceToBeat: null, lastChainlinkPrice: null, hasSignal: false };
  let runningStats = { wins: 0, losses: 0, totalPnl: 0 };
  let recentOutcomes = [];

  const header = [
    "timestamp", "entry_minute", "time_left_min", "ofi_30s", "ofi_1m", "ofi_2m",
    "roc1", "roc3", "ema_cross", "rsi", "signal",
    "model_up", "model_down", "mkt_up", "mkt_down",
    "edge_up", "edge_down", "recommendation", "outcome", "pnl"
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = ofiStream.getLast();
    const wsPrice = wsTick?.price ?? null;
    const ofiData = ofiStream.getOfi();

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;
    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 60 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      // Use only last N candles for short VWAP
      const vwapCandles = klines1m.slice(-CONFIG.vwapCandleWindow);
      const allCloses = klines1m.map(c => c.close);
      const vwapCloses = vwapCandles.map(c => c.close);

      const vwap = computeSessionVwap(vwapCandles);
      const vwapSeries = computeVwapSeries(vwapCandles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      // RSI with shorter period
      const rsiNow = computeRsi(allCloses, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < allCloses.length; i++) {
        const sub = allCloses.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiSlope = slopeLast(rsiSeries, 3);

      // EMA crossover
      const emaCross = computeEmaCross(allCloses, CONFIG.emaCrossFast, CONFIG.emaCrossSlow);

      // Heiken Ashi on recent candles
      const ha = computeHeikenAshi(klines1m.slice(-10));
      const consec = countConsecutive(ha);

      // Momentum
      const momentum = computeMomentum(klines1m);
      const momentumScore = scoreMomentum(momentum);

      // Order flow
      const orderFlowScore = scoreOrderFlow(ofiData);

      // Score direction (5m model)
      const scored = scoreDirection5m({
        orderFlow: orderFlowScore,
        momentumScore,
        emaCross,
        rsi: rsiNow,
        rsiSlope,
        heikenColor: consec.color,
        heikenCount: consec.count,
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope
      });

      const timeAware = applyTimeAwareness5m(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const rec = decide5m({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

      // --- Trading actions ---
      lastPoly = poly;
      lastRec = rec;
      const marketSlugNow = poly.ok ? String(poly.market?.slug ?? "") : "";
      resetIfMarketChanged(marketSlugNow);

      while (actionQueue.length && trading.tradingEnabled && poly.ok) {
        const action = actionQueue.shift();
        if (action.type === "buy") {
          const pos = getPosition();
          if (pos.active) {
            setStatusMessage("Já existe posição aberta");
          } else {
            const side = rec.action === "ENTER" ? rec.side : (timeAware.adjustedUp >= timeAware.adjustedDown ? "UP" : "DOWN");
            const tokenId = side === "UP" ? poly.tokens.upTokenId : poly.tokens.downTokenId;
            const mktPrice = side === "UP" ? marketUp : marketDown;
            const priceNum = mktPrice != null ? mktPrice : 0.5;
            setStatusMessage(`Comprando ${side}...`);
            const result = await buyMarketOrder({ client: trading.client, tokenId, amount: trading.tradeAmount, price: priceNum });
            if (result.ok) {
              const balance = await fetchPositionBalance(trading.client, tokenId);
              const shares = balance > 0 ? balance : trading.tradeAmount / priceNum;
              recordBuy({ side, tokenId, shares, entryPrice: priceNum, invested: trading.tradeAmount, marketSlug: marketSlugNow, orderId: result.order?.orderID });
              const orderId = result.order?.orderID ?? result.order?.id ?? "-";
              const balanceStr = balance > 0 ? `shares: ${balance.toFixed(2)}` : "saldo 0 (ordem não preenchida?)";
              setStatusMessage(`COMPROU ${side} @ ${(priceNum * 100).toFixed(1)}¢ | $${trading.tradeAmount} | ${balanceStr} | ID: ${String(orderId).slice(0, 12)}`, 8000);
            } else {
              const errMsg = `Erro na compra: ${result.error}`;
              setStatusMessage(errMsg, 15000);
              fs.mkdirSync("./logs", { recursive: true });
              fs.appendFileSync("./logs/trade_errors.log", `${new Date().toISOString()} BUY ${side} ${errMsg}\n`);
            }
          }
        } else if (action.type === "sell") {
          const pos = getPosition();
          if (!pos.active) {
            setStatusMessage("Nenhuma posição para vender");
          } else {
            setStatusMessage(`Vendendo ${pos.side}...`);
            const sellMktPrice = pos.side === "UP" ? marketUp : marketDown;
            const sellPriceNum = sellMktPrice != null ? sellMktPrice : 0.5;
            const result = await sellMarketOrder({ client: trading.client, tokenId: pos.tokenId, amount: pos.shares, price: sellPriceNum });
            if (result.ok) {
              const mktPrice = pos.side === "UP" ? marketUp : marketDown;
              const priceNum = mktPrice != null ? mktPrice : 0.5;
              const pnl = (pos.shares * priceNum) - pos.invested;
              const sign = pnl >= 0 ? "+" : "";
              setStatusMessage(`VENDEU ${pos.side} | P&L: ${sign}$${pnl.toFixed(2)}`, 8000);
              recordSell();
            } else {
              const errMsg = `Erro na venda: ${result.error}`;
              setStatusMessage(errMsg, 15000);
              fs.mkdirSync("./logs", { recursive: true });
              fs.appendFileSync("./logs/trade_errors.log", `${new Date().toISOString()} SELL ${pos.side} ${errMsg}\n`);
            }
          }
        }
      }

      // --- Display ---
      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;
      const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;

      const marketUpStr = `${marketUp ?? "-"}${marketUp == null ? "" : "\u00A2"}`;
      const marketDownStr = `${marketDown ?? "-"}${marketDown == null ? "" : "\u00A2"}`;
      const polyHeaderValue = `${ANSI.green}\u2191 UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}\u2193 DOWN${ANSI.reset} ${marketDownStr}`;

      // OFI display
      const ofi30Narrative = ofiNarrative(ofiData.ofi30s);
      const ofi1Narrative = ofiNarrative(ofiData.ofi1m);
      const ofi2Narrative = ofiNarrative(ofiData.ofi2m);
      const ofiValue = `30s:${colorByNarrative(ofiLabel(ofiData.ofi30s), ofi30Narrative)} | 1m:${colorByNarrative(ofiLabel(ofiData.ofi1m), ofi1Narrative)} | 2m:${colorByNarrative(ofiLabel(ofiData.ofi2m), ofi2Narrative)}`;

      // EMA cross display
      const emaLabel = emaCross === null ? "-" : emaCross.crossover !== "NONE"
        ? `${emaCross.crossover} (${emaCross.expanding ? "expanding" : "flat"})`
        : emaCross.bullish
          ? `bullish${emaCross.expanding ? " (expanding)" : ""}`
          : `bearish${emaCross.expanding ? " (expanding)" : ""}`;
      const emaNarrative = emaCross === null ? "NEUTRAL" : emaCross.bullish ? "LONG" : "SHORT";

      // Momentum display
      const momLabel = momentum === null ? "-" : (() => {
        const r1 = momentum.roc1 !== null ? `${(momentum.roc1 * 100).toFixed(3)}%` : "-";
        const r3 = momentum.roc3 !== null ? `${(momentum.roc3 * 100).toFixed(3)}%` : "-";
        const acc = momentum.accel !== null ? (momentum.accel > 0 ? " \u2191accel" : momentum.accel < 0 ? " \u2193decel" : "") : "";
        return `1m:${r1} | 3m:${r3}${acc}`;
      })();
      const momNarrative = momentum?.roc1 != null ? narrativeFromSign(momentum.roc1) : "NEUTRAL";
      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "\u2193" : rsiSlope !== null && rsiSlope > 0 ? "\u2191" : "";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";
      const vwapNarrative = narrativeFromSign(vwapDist);
      const delta1Narr = narrativeFromSign(delta1m);
      const delta3Narr = narrativeFromSign(delta3m);

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";
      const recColor = rec.action === "ENTER" ? ANSI.green : ANSI.gray;
      const recLabel = rec.action === "ENTER" ? `\u25BA ${rec.side === "UP" ? "BUY UP" : "BUY DOWN"}  [${rec.phase}\u00B7${rec.strength}]` : `NO TRADE  [${rec.phase}]`;

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }
      if (priceToBeatState.slug && priceToBeatState.value === null && poly.ok && poly.market) {
        const fromMarket = priceToBeatFromPolymarketMarket(poly.market);
        if (fromMarket !== null) priceToBeatState = { slug: priceToBeatState.slug, value: fromMarket, setAtMs: Date.now(), source: "market" };
      }
      if (priceToBeatState.slug && priceToBeatState.value === null && !priceToBeatFetching) {
        const nowMs = Date.now();
        const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (okToLatch) {
          const lateMs = marketStartMs !== null ? nowMs - marketStartMs : 0;
          if (lateMs > 30_000 && marketStartMs !== null) {
            priceToBeatFetching = true;
            fetchChainlinkPriceAtMs(marketStartMs).then((p) => {
              if (p !== null && priceToBeatState.slug === marketSlug && priceToBeatState.value === null) {
                priceToBeatState = { slug: marketSlug, value: p, setAtMs: marketStartMs, source: "chainlink_historical" };
              } else if (p === null && currentPrice !== null && priceToBeatState.slug === marketSlug && priceToBeatState.value === null) {
                priceToBeatState = { slug: marketSlug, value: Number(currentPrice), setAtMs: nowMs, source: "chainlink_latch" };
              }
              priceToBeatFetching = false;
            }).catch(() => { priceToBeatFetching = false; });
          } else if (currentPrice !== null) {
            priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs, source: "chainlink_latch" };
          }
        }
      }
      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;

      // Trade outcome tracking
      if (tradeState.slug !== null && tradeState.slug !== "" && marketSlug !== tradeState.slug) {
        if (tradeState.hasSignal && tradeState.priceToBeat !== null && tradeState.lastChainlinkPrice !== null) {
          const winner = tradeState.lastChainlinkPrice > tradeState.priceToBeat ? "UP" : "DOWN";
          const won = tradeState.side === winner;
          const ep = tradeState.entryMarketPrice ?? 0.5;
          const pnl = won ? (1 / ep) - 1 : -1;
          if (won) runningStats.wins += 1; else runningStats.losses += 1;
          runningStats.totalPnl += pnl;
          recentOutcomes.unshift({ slug: tradeState.slug, side: tradeState.side, won, pnl, ts: new Date().toISOString() });
          if (recentOutcomes.length > 10) recentOutcomes.pop();
          appendCsvRow("./logs/signals_5m.csv", header, [
            new Date().toISOString(), "SETTLED", "0", "", "", "", "", "", "", "", "",
            `${tradeState.side}:${won ? "WIN" : "LOSS"}`, "", "", "", "", "",
            `${won ? "WIN" : "LOSS"}:${tradeState.side}`, won ? "WIN" : "LOSS", pnl.toFixed(4)
          ]);
        }
        tradeState = { slug: marketSlug, side: null, entryMarketPrice: null, priceToBeat: null, lastChainlinkPrice: currentPrice, hasSignal: false };
      } else if (tradeState.slug === null || tradeState.slug === "") { tradeState.slug = marketSlug; }
      if (!tradeState.hasSignal && rec.action === "ENTER" && marketSlug) { tradeState.side = rec.side; tradeState.entryMarketPrice = rec.side === "UP" ? marketUp : marketDown; tradeState.hasSignal = true; }
      if (currentPrice !== null) tradeState.lastChainlinkPrice = currentPrice;
      if (priceToBeat !== null) tradeState.priceToBeat = priceToBeat;

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try { fs.mkdirSync("./logs", { recursive: true }); fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8"); } catch { /* ignore */ }
        }
      }

      const isNextMarket = marketStartMs !== null && marketStartMs > Date.now();
      const timeColor = isNextMarket ? ANSI.yellow : timeLeftMin >= 3 ? ANSI.green : timeLeftMin >= 1.5 ? ANSI.yellow : ANSI.red;
      const liquidity = poly.ok ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null) : null;
      const settlementMs5m = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;

      const clLine = colorPriceLine({ label: "", price: currentPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" });
      const ptbDelta = (currentPrice !== null && priceToBeat !== null) ? currentPrice - priceToBeat : null;
      const ptbStr = ptbDelta === null ? "" : ` (${ptbDelta > 0 ? ANSI.green + "+" : ptbDelta < 0 ? ANSI.red : ANSI.gray}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset})`;

      const shortcutsHint = trading.tradingEnabled && !stdinError ? `${ANSI.dim}[B]${ANSI.reset} Comprar  ${ANSI.dim}[S]${ANSI.reset} Vender  ${ANSI.dim}[Q]${ANSI.reset} Sair` : `${ANSI.dim}[Q]${ANSI.reset} Sair`;
      const confirmHint = (() => {
        if (!pendingAction) return null;
        if (pendingAction.type === "buy") {
          const side = rec.action === "ENTER" ? rec.side : (timeAware.adjustedUp >= timeAware.adjustedDown ? "UP" : "DOWN");
          const sc = side === "UP" ? ANSI.green : ANSI.red;
          const mp = side === "UP" ? marketUp : marketDown;
          const ps = mp != null ? `@ ${(mp * 100).toFixed(1)}\u00A2` : "";
          return `${ANSI.yellow}\u26A1 BUY ${sc}${side}${ANSI.reset} ${ANSI.yellow}${ps} $${trading.tradeAmount}${ANSI.reset}  ${ANSI.white}[Y]${ANSI.reset} Sim  ${ANSI.white}[N]${ANSI.reset} Cancelar`;
        }
        if (pendingAction.type === "sell") {
          const pos = getPosition();
          if (!pos.active) return `${ANSI.gray}Sem posicao${ANSI.reset}  ${ANSI.white}[N]${ANSI.reset}`;
          const sc = pos.side === "UP" ? ANSI.green : ANSI.red;
          return `${ANSI.yellow}\u26A1 VENDER ${sc}${pos.side}${ANSI.reset} ${ANSI.yellow}${pos.shares.toFixed(2)} sh${ANSI.reset}  ${ANSI.white}[Y]${ANSI.reset} Sim  ${ANSI.white}[N]${ANSI.reset} Cancelar`;
        }
        return null;
      })();

      const intervalLine = (marketStartMs !== null && settlementMs5m !== null)
        ? kv("Intervalo:", `${isNextMarket ? ANSI.yellow : ""}${fmtEtHHMM(marketStartMs)} \u2192 ${fmtEtHHMM(settlementMs5m)} ET${isNextMarket ? ANSI.reset : ""}`)
        : null;

      const pos = getPosition();
      const posPrice = pos.active ? (pos.side === "UP" ? marketUp : marketDown) : null;
      const currentMktPrice = posPrice != null ? posPrice : null;
      const exitEval = evaluateExit({
        position: pos, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
        currentMarketPrice: currentMktPrice, timeLeftMin,
        takeProfitPct: CONFIG.trading.takeProfitPct,
        stopLossPct: CONFIG.trading.stopLossPct,
        signalFlipMinProb: CONFIG.trading.signalFlipMinProb,
      });

      const modeTag = isNextMarket ? `${ANSI.yellow}[5m] [PROXIMO]${ANSI.reset}` : `${ANSI.yellow}[5m]${ANSI.reset}`;

      renderScreen(buildScreen({
        title: poly.ok ? (poly.market?.question ?? "-") : "-",
        modeTag,
        marketSlug,
        tradingEnabled: trading.tradingEnabled,
        initError: trading.initError,
        tradeAmount: trading.tradeAmount,
        confirmHint,
        shortcutsHint,
        binanceSpot: `${colorPriceLine({ label: "", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" })}`,
        chainlinkLine: `${clLine}${ptbStr}`,
        priceToBeat,
        intervalLine,
        marketUpStr: marketUp != null ? `${(marketUp * 100).toFixed(1)}\u00A2` : "-",
        marketDownStr: marketDown != null ? `${(marketDown * 100).toFixed(1)}\u00A2` : "-",
        timeLeftMin,
        timeColor,
        liquidity,
        indicators: [
          { label: "Order Flow", value: ofiValue },
          { label: "Momentum", value: colorByNarrative(momLabel, momNarrative) },
          { label: "EMA Cross", value: colorByNarrative(emaLabel, emaNarrative) },
          { label: "RSI", value: colorByNarrative(`${formatNumber(rsiNow, 1)} ${rsiArrow}`, rsiNarrative) },
          { label: "Heiken Ashi", value: colorByNarrative(`${consec.color ?? "-"} x${consec.count}`, haNarrative) },
          { label: "VWAP", value: colorByNarrative(`${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) ${vwapSlopeLabel}`, vwapNarrative) },
          { label: "\u0394 1/3 min", value: `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narr)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narr)}` },
        ],
        predictValue,
        recLine: `${recColor}${recLabel}${ANSI.reset}`,
        position: pos,
        currentMktPrice,
        exitEval,
        closedTrades: [],
        runningStats,
        recentOutcomes,
      }));

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      appendCsvRow("./logs/signals_5m.csv", header, [
        new Date().toISOString(),
        timing.elapsedMinutes.toFixed(3),
        timeLeftMin.toFixed(3),
        ofiData.ofi30s?.ofi?.toFixed(3) ?? "",
        ofiData.ofi1m?.ofi?.toFixed(3) ?? "",
        ofiData.ofi2m?.ofi?.toFixed(3) ?? "",
        momentum?.roc1?.toFixed(6) ?? "",
        momentum?.roc3?.toFixed(6) ?? "",
        emaCross?.crossover ?? "",
        rsiNow?.toFixed(1) ?? "",
        signal,
        timeAware.adjustedUp,
        timeAware.adjustedDown,
        marketUp,
        marketDown,
        edge.edgeUp,
        edge.edgeDown,
        rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE",
        "",
        ""
      ]);
    } catch (err) {
      console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
