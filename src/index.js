import { CONFIG } from "./config.js";
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
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import fs from "node:fs";
import path from "node:path";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import {
  ANSI, renderScreen, buildScreen,
  colorPriceLine, formatSignedDelta, formatNumberDisplay,
  colorByNarrative, formatNarrativeValue, narrativeFromSign,
  narrativeFromSlope, formatProbPct, fmtTimeLeft,
  safeFileSlug, priceToBeatFromPolymarketMarket, setStatusMessage
} from "./display.js";
import { initTradingClient } from "./trading/client.js";
import { buyMarketOrder, sellMarketOrder } from "./trading/orders.js";
import { getPosition, recordBuy, recordSell, resetIfMarketChanged, fetchPositionBalance, fetchUsdcBalance, evaluateExit } from "./trading/position.js";

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

const dumpedMarkets = new Set();

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
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
  const market = await resolveCurrentBtc15mMarket();

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
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
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

async function main() {
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
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
  let pendingAction = null; // { type: "buy" | "sell" } waiting Y/N confirmation
  let lastPoly = null;
  let lastRec = null;

  let stdinError = null;
  try {
    if (!process.stdin.isTTY) throw new Error("stdin não é TTY — rode com: node src/index.js");
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
  let usdcBalance = null;
  let usdcBalanceError = null;
  let usdcLastFetchMs = 0;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };
  let priceToBeatFetching = false; // guard against concurrent historical fetches

  // Trade outcome tracking (per-market)
  let tradeState = { slug: null, side: null, entryMarketPrice: null, priceToBeat: null, lastChainlinkPrice: null, hasSignal: false };
  let runningStats = { wins: 0, losses: 0, totalPnl: 0 };
  let recentOutcomes = []; // { slug, side, won, pnl, ts }[]
  let closedTrades = []; // { side, entryPrice, exitPrice, pnl, roi, ts }[]

  const header = [
    "timestamp",
    "entry_minute",
    "time_left_min",
    "regime",
    "signal",
    "model_up",
    "model_down",
    "mkt_up",
    "mkt_down",
    "edge_up",
    "edge_down",
    "recommendation",
    "outcome",
    "pnl"
  ];

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = binanceStream.getLast();
    const wsPrice = wsTick?.price ?? null;

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

      const [klines1m, klines5m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchKlines({ interval: "5m", limit: 200 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const sub = closes.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      const scored = scoreDirection({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

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
            const book = side === "UP" ? poly.orderbook.up : poly.orderbook.down;
            // Usa bestAsk + margem para garantir o match; cai no mid-price se não houver book
            const rawAsk = book?.bestAsk ?? (side === "UP" ? marketUp : marketDown);
            const priceNum = rawAsk != null ? Math.min(rawAsk + 0.02, 0.97) : 0.5;
            const entryRef = rawAsk ?? priceNum;
            setStatusMessage(`Comprando ${side}...`);
            const result = await buyMarketOrder({ client: trading.client, tokenId, amount: trading.tradeAmount, price: priceNum });
            if (result.ok) {
              const balance = await fetchPositionBalance(trading.client, tokenId);
              const shares = balance > 0 ? balance : trading.tradeAmount / entryRef;
              recordBuy({ side, tokenId, shares, entryPrice: entryRef, invested: trading.tradeAmount, marketSlug: marketSlugNow, orderId: result.order?.orderID });
              const orderId = result.order?.orderID ?? result.order?.id ?? "-";
              const balanceStr = balance > 0 ? `shares: ${balance.toFixed(2)}` : "saldo 0 (ordem não preenchida?)";
              setStatusMessage(`COMPROU ${side} @ ${(entryRef * 100).toFixed(1)}¢ | $${trading.tradeAmount} | ${balanceStr} | ID: ${String(orderId).slice(0, 12)}`, 8000);
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
            const sellBook = pos.side === "UP" ? poly.orderbook.up : poly.orderbook.down;
            const rawBid = sellBook?.bestBid ?? (pos.side === "UP" ? marketUp : marketDown);
            const sellPriceNum = rawBid != null ? Math.max(rawBid - 0.02, 0.03) : 0.5;
            // Usa saldo real on-chain para evitar erro de saldo insuficiente
            const actualShares = await fetchPositionBalance(trading.client, pos.tokenId);
            const sharesToSell = actualShares > 0 ? actualShares : pos.shares;
            const result = await sellMarketOrder({ client: trading.client, tokenId: pos.tokenId, amount: sharesToSell, price: sellPriceNum });
            if (result.ok) {
              const priceNum = rawBid ?? sellPriceNum;
              const pnl = (sharesToSell * priceNum) - pos.invested;
              const roi = (pnl / pos.invested) * 100;
              const sign = pnl >= 0 ? "+" : "";
              setStatusMessage(`VENDEU ${pos.side} | P&L: ${sign}$${pnl.toFixed(2)}`, 8000);
              closedTrades.unshift({ side: pos.side, entryPrice: pos.entryPrice, exitPrice: priceNum, pnl, roi, ts: Date.now() });
              if (closedTrades.length > 10) closedTrades.pop();
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

      // --- USDC balance fetch (every 30s) ---
      if (trading.tradingEnabled && Date.now() - usdcLastFetchMs > 30_000) {
        usdcLastFetchMs = Date.now();
        fetchUsdcBalance(trading.balanceAddress).then((bal) => {
          usdcBalance = bal;
          usdcBalanceError = null;
        }).catch((err) => {
          usdcBalanceError = err?.message ? err.message.slice(0, 40) : "erro";
        });
      }

      // --- Display data ---
      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }
      if (priceToBeatState.slug && priceToBeatState.value === null && poly.ok && poly.market) {
        const fromMarket = priceToBeatFromPolymarketMarket(poly.market);
        if (fromMarket !== null) {
          priceToBeatState = { slug: priceToBeatState.slug, value: fromMarket, setAtMs: Date.now(), source: "market" };
        }
      }
      if (priceToBeatState.slug && priceToBeatState.value === null && !priceToBeatFetching) {
        const nowMs = Date.now();
        const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
        if (okToLatch) {
          const lateMs = marketStartMs !== null ? nowMs - marketStartMs : 0;
          if (lateMs > 30_000 && marketStartMs !== null) {
            // App started late — fetch historical Chainlink price at market open
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
          appendCsvRow("./logs/signals.csv", header, [
            new Date().toISOString(), "SETTLED", "0", tradeState.slug,
            `${tradeState.side}:${won ? "WIN" : "LOSS"}`, "", "", "", "", "", "",
            `${won ? "WIN" : "LOSS"}:${tradeState.side}`, won ? "WIN" : "LOSS", pnl.toFixed(4)
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

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try { fs.mkdirSync("./logs", { recursive: true }); fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8"); } catch { /* ignore */ }
        }
      }

      // Indicator formatting
      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";
      const macdLabel = macd === null ? "-" : macd.hist < 0 ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (exp)" : "bearish") : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (exp)" : "bullish");
      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;
      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);
      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "\u2193" : rsiSlope !== null && rsiSlope > 0 ? "\u2191" : "";
      const delta1Narr = narrativeFromSign(delta1m);
      const delta3Narr = narrativeFromSign(delta3m);

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;

      // Confirm hint
      const shortcutsHint = trading.tradingEnabled && !stdinError ? `${ANSI.dim}[B]${ANSI.reset} Comprar  ${ANSI.dim}[S]${ANSI.reset} Vender  ${ANSI.dim}[Q]${ANSI.reset} Sair` : `${ANSI.dim}[Q]${ANSI.reset} Sair`;
      const confirmHint = (() => {
        if (!pendingAction) return null;
        if (pendingAction.type === "buy") {
          const side = rec.action === "ENTER" ? rec.side : (pLong >= pShort ? "UP" : "DOWN");
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

      const timeColor = timeLeftMin >= 10 ? ANSI.green : timeLeftMin >= 5 ? ANSI.yellow : ANSI.red;
      const liquidity = poly.ok ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null) : null;
      const recColor = rec.action === "ENTER" ? ANSI.green : ANSI.gray;
      const recLabel = rec.action === "ENTER" ? `\u25BA ${rec.side === "UP" ? "BUY UP" : "BUY DOWN"}  [${rec.phase}\u00B7${rec.strength}]` : `NO TRADE  [${rec.phase}]`;

      // Chainlink display
      const clLine = colorPriceLine({ label: "", price: currentPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" });
      const ptbDelta = (currentPrice !== null && priceToBeat !== null) ? currentPrice - priceToBeat : null;
      const ptbStr = ptbDelta === null ? "" : ` (${ptbDelta > 0 ? ANSI.green + "+" : ptbDelta < 0 ? ANSI.red : ANSI.gray}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset})`;

      const pos = getPosition();
      const posPrice = pos.active ? (pos.side === "UP" ? marketUp : marketDown) : null;
      const currentMktPrice = posPrice != null ? posPrice : null;
      const exitEval = evaluateExit({
        position: pos, modelUp: pLong, modelDown: pShort,
        currentMarketPrice: currentMktPrice, timeLeftMin,
        takeProfitPct: CONFIG.trading.takeProfitPct,
        stopLossPct: CONFIG.trading.stopLossPct,
        signalFlipMinProb: CONFIG.trading.signalFlipMinProb,
      });

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      renderScreen(buildScreen({
        title: poly.ok ? (poly.market?.question ?? "-") : "-",
        modeTag: null,
        marketSlug,
        tradingEnabled: trading.tradingEnabled,
        initError: trading.initError,
        tradeAmount: trading.tradeAmount,
        usdcBalance,
        usdcBalanceError,
        confirmHint,
        shortcutsHint,
        binanceSpot: `${colorPriceLine({ label: "", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" })}`,
        chainlinkLine: `${clLine}${ptbStr}`,
        priceToBeat,
        intervalLine: null,
        marketUpStr: marketUp != null ? `${(marketUp * 100).toFixed(1)}\u00A2` : "-",
        marketDownStr: marketDown != null ? `${(marketDown * 100).toFixed(1)}\u00A2` : "-",
        timeLeftMin,
        timeColor,
        liquidity,
        indicators: [
          { label: "Heiken Ashi", value: colorByNarrative(`${consec.color ?? "-"} x${consec.count}`, haNarrative) },
          { label: "RSI", value: colorByNarrative(`${formatNumber(rsiNow, 1)} ${rsiArrow}`, rsiNarrative) },
          { label: "MACD", value: colorByNarrative(macdLabel, macdNarrative) },
          { label: "\u0394 1/3 min", value: `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narr)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narr)}` },
          { label: "VWAP", value: colorByNarrative(`${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) ${vwapSlopeLabel}`, vwapNarrative) },
        ],
        predictValue: `${ANSI.green}LONG ${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT ${formatProbPct(pShort, 0)}${ANSI.reset}`,
        recLine: `${recColor}${recLabel}${ANSI.reset}`,
        position: pos,
        currentMktPrice,
        exitEval,
        closedTrades,
        runningStats,
        recentOutcomes,
      }));

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      appendCsvRow("./logs/signals.csv", header, [
        new Date().toISOString(),
        timing.elapsedMinutes.toFixed(3),
        timeLeftMin.toFixed(3),
        regimeInfo.regime,
        signal,
        timeAware.adjustedUp,
        timeAware.adjustedDown,
        marketUp,
        marketDown,
        edge.edgeUp,
        edge.edgeDown,
        rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE",
        "", // outcome — preenchido na row SETTLED
        ""  // pnl    — preenchido na row SETTLED
      ]);
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
