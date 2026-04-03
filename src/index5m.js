import { CONFIG } from "./config5m.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
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
  ANSI, screenWidth, sepLine, renderScreen, centerText,
  kv, colorPriceLine, formatSignedDelta,
  colorByNarrative, formatNarrativeValue, narrativeFromSign,
  narrativeFromSlope, formatProbPct, fmtEtTime, fmtEtHHMM, getBtcSession, fmtTimeLeft,
  safeFileSlug, priceToBeatFromPolymarketMarket,
  setStatusMessage, formatPositionLines
} from "./display.js";
import { initTradingClient } from "./trading/client.js";
import { buyMarketOrder, sellMarketOrder } from "./trading/orders.js";
import { getPosition, recordBuy, recordSell, computeROI, resetIfMarketChanged, fetchPositionBalance } from "./trading/position.js";

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
  let trading = { client: null, tradingEnabled: false, tradeAmount: 0 };
  try {
    trading = await initTradingClient(CONFIG);
  } catch { /* trading stays disabled */ }

  const actionQueue = [];
  let lastPoly = null;
  let lastRec = null;

  if (trading.tradingEnabled) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key) => {
      const ch = key.toString().toLowerCase();
      if (ch === "b") actionQueue.push({ type: "buy" });
      else if (ch === "s") actionQueue.push({ type: "sell" });
      else if (ch === "q" || key[0] === 0x03) process.exit(0);
    });
  }

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };

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
            const priceNum = mktPrice != null ? mktPrice / 100 : 0.5;
            setStatusMessage(`Comprando ${side}...`);
            const result = await buyMarketOrder({ client: trading.client, tokenId, amount: trading.tradeAmount });
            if (result.ok) {
              const shares = trading.tradeAmount / priceNum;
              recordBuy({ side, tokenId, shares, entryPrice: priceNum, invested: trading.tradeAmount, marketSlug: marketSlugNow, orderId: result.order?.orderID });
              const balance = await fetchPositionBalance(trading.client, tokenId);
              if (balance > 0) recordBuy({ side, tokenId, shares: balance, entryPrice: priceNum, invested: trading.tradeAmount, marketSlug: marketSlugNow, orderId: result.order?.orderID });
              setStatusMessage(`COMPROU ${side} @ ${(priceNum * 100).toFixed(1)}¢ | $${trading.tradeAmount}`);
            } else {
              setStatusMessage(`Erro: ${result.error}`);
            }
          }
        } else if (action.type === "sell") {
          const pos = getPosition();
          if (!pos.active) {
            setStatusMessage("Nenhuma posição para vender");
          } else {
            setStatusMessage(`Vendendo ${pos.side}...`);
            const result = await sellMarketOrder({ client: trading.client, tokenId: pos.tokenId, amount: pos.shares });
            if (result.ok) {
              const mktPrice = pos.side === "UP" ? marketUp : marketDown;
              const priceNum = mktPrice != null ? mktPrice / 100 : 0.5;
              const pnl = (pos.shares * priceNum) - pos.invested;
              const sign = pnl >= 0 ? "+" : "";
              setStatusMessage(`VENDEU ${pos.side} | P&L: ${sign}$${pnl.toFixed(2)}`);
              recordSell();
            } else {
              setStatusMessage(`Erro: ${result.error}`);
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

      // RSI
      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "\u2193" : rsiSlope !== null && rsiSlope > 0 ? "\u2191" : "-";
      const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
      const rsiNarrative = narrativeFromSlope(rsiSlope);

      // HA
      const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";

      // VWAP
      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";
      const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
      const vwapNarrative = narrativeFromSign(vwapDist);

      // Delta
      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      const deltaValue = `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narrative)}`;

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      const recColor = rec.action === "ENTER" ? ANSI.green : ANSI.gray;
      const recLabel = rec.action === "ENTER"
        ? `\u25BA ${rec.side === "UP" ? "BUY UP" : "BUY DOWN"}  [${rec.phase} \u00B7 ${rec.strength}]`
        : `NO TRADE  [${rec.phase}]`;
      const recLine = `${recColor}${recLabel}${ANSI.reset}`;

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }
      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
        const nowMs = Date.now();
        const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (okToLatch) {
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
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
          if (won) runningStats.wins += 1;
          else runningStats.losses += 1;
          runningStats.totalPnl += pnl;
          recentOutcomes.unshift({ slug: tradeState.slug, side: tradeState.side, won, pnl, ts: new Date().toISOString() });
          if (recentOutcomes.length > 10) recentOutcomes.pop();
          appendCsvRow("./logs/signals_5m.csv", header, [
            new Date().toISOString(), "SETTLED", "0", "", "", "", "", "", "", "", "",
            `${tradeState.side}:${won ? "WIN" : "LOSS"}`, "", "", "", "", "",
            `${won ? "WIN" : "LOSS"}:${tradeState.side}`,
            won ? "WIN" : "LOSS",
            pnl.toFixed(4)
          ]);
        }
        tradeState = { slug: marketSlug, side: null, entryMarketPrice: null, priceToBeat: null, lastChainlinkPrice: currentPrice, hasSignal: false };
      } else if (tradeState.slug === null || tradeState.slug === "") {
        tradeState.slug = marketSlug;
      }

      if (!tradeState.hasSignal && rec.action === "ENTER" && marketSlug) {
        tradeState.side = rec.side;
        tradeState.entryMarketPrice = rec.side === "UP" ? marketUp : marketDown;
        tradeState.hasSignal = true;
      }
      if (currentPrice !== null) tradeState.lastChainlinkPrice = currentPrice;
      if (priceToBeat !== null) tradeState.priceToBeat = priceToBeat;

      // Price to beat display
      const currentPriceBaseLine = colorPriceLine({ label: "CURRENT PRICE", price: currentPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" });
      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat : null;
      const ptbDeltaColor = ptbDelta === null ? ANSI.gray : ptbDelta > 0 ? ANSI.green : ptbDelta < 0 ? ANSI.red : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch { /* ignore */ }
        }
      }

      const binanceSpotBaseLine = colorPriceLine({ label: "BTC (Binance)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
        ? (() => {
          const diffUsd = spotPrice - currentPrice;
          const diffPct = (diffUsd / currentPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const binanceSpotValue = (binanceSpotBaseLine + diffLine).split(": ")[1] ?? (binanceSpotBaseLine + diffLine);
      const binanceSpotKvLine = kv("BTC (Binance):", binanceSpotValue);

      const isNextMarket = marketStartMs !== null && marketStartMs > Date.now();
      const modeTag = isNextMarket ? `${ANSI.yellow}[5m MODE]${ANSI.reset} ${ANSI.yellow}[PRÓXIMO MERCADO]${ANSI.reset}` : `${ANSI.yellow}[5m MODE]${ANSI.reset}`;
      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-");
      const intervalLabel = isNextMarket ? "Próx. intervalo:" : "Interval:";
      const intervalLine = (marketStartMs !== null && settlementMs !== null)
        ? kv(intervalLabel, `${isNextMarket ? ANSI.yellow : ""}${fmtEtHHMM(marketStartMs)} → ${fmtEtHHMM(settlementMs)} ET${isNextMarket ? ANSI.reset : ""}`)
        : null;

      const timeColor = isNextMarket
        ? ANSI.yellow
        : timeLeftMin >= 3 ? ANSI.green : timeLeftMin >= 1.5 ? ANSI.yellow : ANSI.red;
      const startsInMin = isNextMarket && marketStartMs !== null ? (marketStartMs - Date.now()) / 60_000 : null;

      const polyTimeLeftColor = settlementLeftMin !== null
        ? (settlementLeftMin >= 3 ? ANSI.green : settlementLeftMin >= 1.5 ? ANSI.yellow : ANSI.red)
        : ANSI.reset;

      const liquidity = poly.ok ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null) : null;

      const lines = [
        `${modeTag} ${titleLine}`,
        marketLine,
        intervalLine,
        isNextMarket && startsInMin !== null
          ? kv("Inicia em:", `${ANSI.yellow}${fmtTimeLeft(startsInMin)}${ANSI.reset}`)
          : kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        kv("ORDER FLOW:", ofiValue),
        kv("Momentum:", formatNarrativeValue("", momLabel, momNarrative).slice(2)),
        kv("EMA Cross:", formatNarrativeValue("", emaLabel, emaNarrative).slice(2)),
        kv("RSI:", formatNarrativeValue("", rsiValue, rsiNarrative).slice(2)),
        kv("Heiken Ashi:", formatNarrativeValue("", heikenValue, haNarrative).slice(2)),
        kv("VWAP:", formatNarrativeValue("", vwapValue, vwapNarrative).slice(2)),
        kv("Delta 1/3:", deltaValue),
        "",
        kv("TA Predict:", predictValue),
        kv("Recommendation:", recLine),
        "",
        sepLine(),
        "",
        kv("POLYMARKET:", polyHeaderValue),
        liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
        settlementLeftMin !== null ? kv("Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("PRICE TO BEAT: ", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT: ", `${ANSI.gray}-${ANSI.reset}`),
        currentPriceLine,
        "",
        sepLine(),
        "",
        binanceSpotKvLine,
        "",
        sepLine(),
        "",
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        (() => {
          const total = runningStats.wins + runningStats.losses;
          const winRateStr = total > 0 ? `${((runningStats.wins / total) * 100).toFixed(0)}%` : "-";
          const pnlColor = runningStats.totalPnl > 0 ? ANSI.green : runningStats.totalPnl < 0 ? ANSI.red : ANSI.gray;
          const pnlSign = runningStats.totalPnl > 0 ? "+" : "";
          return `${ANSI.white}TRADE HISTORY${ANSI.reset}  W:${ANSI.green}${runningStats.wins}${ANSI.reset} L:${ANSI.red}${runningStats.losses}${ANSI.reset}  Win Rate:${ANSI.white}${winRateStr}${ANSI.reset}  P&L:${pnlColor}${pnlSign}${runningStats.totalPnl.toFixed(2)} USDC${ANSI.reset}`;
        })(),
        ...recentOutcomes.slice(0, 5).map((o, i) => {
          const color = o.won ? ANSI.green : ANSI.red;
          const label = o.won ? "WIN" : "LOSS";
          const pnlSign = o.pnl > 0 ? "+" : "";
          return `${ANSI.gray}  ${i + 1}.${ANSI.reset} ${color}${label}${ANSI.reset} ${ANSI.dim}${o.side}${ANSI.reset}  ${color}${pnlSign}${o.pnl.toFixed(2)} USDC${ANSI.reset}  ${ANSI.gray}${o.slug.slice(0, 40)}${ANSI.reset}`;
        }),
        ...(() => {
          const pos = getPosition();
          const posPrice = pos.active
            ? (pos.side === "UP" ? marketUp : marketDown)
            : null;
          const currentMktPrice = posPrice != null ? posPrice / 100 : null;
          return formatPositionLines({ position: pos, currentMarketPrice: currentMktPrice, tradingEnabled: trading.tradingEnabled });
        })(),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
      ].filter(x => x !== null);

      renderScreen(lines.join("\n") + "\n");

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
