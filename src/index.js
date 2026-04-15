import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import { createMarketResolver, fetchPolymarketSnapshot } from "./data/polymarket.js";
import { computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, slopeLast } from "./indicators/rsi.js";
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
  colorPriceLine, formatSignedDelta,
  colorByNarrative, narrativeFromSign,
  narrativeFromSlope, formatProbPct,
  safeFileSlug, setStatusMessage
} from "./display.js";
import { initTradingClient } from "./trading/client.js";
import { fetchUsdcBalance, evaluateExit, resetIfMarketChanged, getPosition } from "./trading/position.js";
import { setupKeyboard } from "./trading/keyboard.js";
import { processActionQueue } from "./trading/executor.js";
import { createPriceLatch } from "./trading/priceLatch.js";
import { createTradeTracker } from "./trading/tracker.js";
import { createDryRunSimulator15m } from "./dryRun.js";
import { redeemSettledPositions } from "./trading/redeem.js";
import { notifyStart, notifyDailySummary } from "./notify.js";

applyGlobalProxyFromEnv();

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur  = closes[i]     - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

const CSV_PATH = "./logs/signals.csv";
const CSV_HEADER = [
  "timestamp", "entry_minute", "time_left_min",
  "regime", "signal",
  "model_up", "model_down", "mkt_up", "mkt_down",
  "edge_up", "edge_down", "recommendation", "outcome", "pnl",
];

async function main() {
  const binanceStream       = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream     = startChainlinkPriceStream({});

  const liveTrading = CONFIG.trading.liveTradingEnabled;

  let trading = { client: null, tradingEnabled: false, tradeAmount: 0, initError: null };
  try {
    trading = await initTradingClient(CONFIG);
  } catch (err) {
    trading.initError = err?.message ?? String(err);
  }
  // Override: only allow real orders when POLYMARKET_LIVE_TRADING=true
  if (!liveTrading) trading.tradingEnabled = false;

  const resolveMarket = createMarketResolver(CONFIG.polymarket, CONFIG.pollIntervalMs);
  const keyboard      = setupKeyboard({ tradingEnabled: trading.tradingEnabled });
  const priceLatch    = createPriceLatch();
  const tracker       = createTradeTracker();

  notifyStart("15m");

  const dumpedMarkets = new Set();
  const dryRun = createDryRunSimulator15m("./logs/dryrun_15m.csv", CONFIG.trading);
  process.on("exit", () => dryRun.flushNow());

  // Late-start guard: skip entering positions on markets the bot didn't see from open
  const BOT_START_MS = Date.now();
  const LATE_START_GRACE_MS = 90_000; // 90s grace window

  let prevSpotPrice    = null;
  let prevCurrentPrice = null;
  let usdcBalance      = null;
  let usdcBalanceError = null;
  let usdcLastFetchMs  = 0;
  let flipConfirmCount = 0;
  let prevMarketSlug       = "";
  let prevConditionId      = null;
  let lastDaySummaryEt     = new Date().toLocaleDateString("sv", { timeZone: "America/New_York" });

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick           = binanceStream.getLast();
    const wsPrice          = wsTick?.price ?? null;
    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;
    const chainlinkWsTick  = chainlinkStream.getLast();
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
        fetchPolymarketSnapshot(resolveMarket, CONFIG.polymarket),
      ]);

      const settlementMs     = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const timeLeftMin      = settlementLeftMin ?? timing.remainingMinutes;

      // ── Indicators ────────────────────────────────────────────────────────
      const candles = klines1m;
      const closes  = candles.map((c) => c.close);

      const vwapSeries = computeVwapSeries(candles);
      const vwapNow    = vwapSeries[vwapSeries.length - 1];
      const lookback   = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope  = vwapSeries.length >= lookback
        ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback
        : null;
      const vwapDist   = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;
      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const r = computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd   = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
      const ha     = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount  = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent    = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg       = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      // ── Signal ────────────────────────────────────────────────────────────
      const regimeInfo = detectRegime({ price: lastPrice, vwap: vwapNow, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg });

      const scored = scoreDirection({
        price: lastPrice, vwap: vwapNow, vwapSlope,
        rsi: rsiNow, rsiSlope, macd,
        heikenColor: consec.color, heikenCount: consec.count,
      });

      const timeAware  = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);
      const marketUp   = poly.ok ? poly.prices.up   : null;
      const marketDown = poly.ok ? poly.prices.down  : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });
      const rec  = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, conflicted: scored.conflicted });

      // ── Trading ───────────────────────────────────────────────────────────
      const marketSlugNow   = poly.ok ? String(poly.market?.slug ?? "") : "";
      const conditionIdNow  = poly.ok ? (poly.market?.conditionId ?? null) : null;
      const marketStartMsNow = poly.ok && poly.market?.eventStartTime
        ? new Date(poly.market.eventStartTime).getTime()
        : null;
      // Bot must have been running within LATE_START_GRACE_MS of market open to enter
      const sawMarketStart  = marketStartMsNow === null || BOT_START_MS <= marketStartMsNow + LATE_START_GRACE_MS;

      // On market change: redeem any settled tokens from the previous market
      if (marketSlugNow && marketSlugNow !== prevMarketSlug && prevConditionId && trading.tradingEnabled) {
        redeemSettledPositions({ wallet: trading.wallet, conditionId: prevConditionId, marketSlug: prevMarketSlug })
          .catch(() => {}); // fire-and-forget; errors are logged inside redeemSettledPositions
      }
      if (conditionIdNow) prevConditionId = conditionIdNow;
      prevMarketSlug = marketSlugNow || prevMarketSlug;

      resetIfMarketChanged(marketSlugNow);

      await processActionQueue(keyboard.actionQueue, { trading, poly, rec, timeAware, marketSlugNow, botLabel: "15m", sawMarketStart });

      if (trading.tradingEnabled && Date.now() - usdcLastFetchMs > 30_000) {
        usdcLastFetchMs = Date.now();
        fetchUsdcBalance(trading.balanceAddress)
          .then((bal) => { usdcBalance = bal; usdcBalanceError = null; })
          .catch((err) => { usdcBalanceError = err?.message ? err.message.slice(0, 40) : "erro"; });
      }

      // ── Derived display values ─────────────────────────────────────────────
      const spotPrice    = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug   = poly.ok ? String(poly.market?.slug ?? "") : "";

      const priceToBeat = priceLatch.update({ marketSlug, currentPrice, marketStartMs: marketStartMsNow, market: poly.market ?? null });

      const settled = tracker.update({ marketSlug, rec, marketUp, marketDown, currentPrice, priceToBeat });
      if (settled) {
        const { slug, side, won, pnl } = settled;
        appendCsvRow(CSV_PATH, CSV_HEADER, [
          new Date().toISOString(), "SETTLED", "0", slug,
          `${side}:${won ? "WIN" : "LOSS"}`, "", "", "", "", "", "",
          `${won ? "WIN" : "LOSS"}:${side}`, won ? "WIN" : "LOSS", pnl.toFixed(4),
        ]);
      }

      // Dump raw market JSON once per new slug (for debugging)
      if (poly.ok && poly.market && priceToBeat === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch { /* ignore */ }
        }
      }

      // ── Display ───────────────────────────────────────────────────────────
      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";
      const macdLabel = macd === null ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (exp)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (exp)" : "bullish");
      const lastCandle  = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose   = lastCandle?.close ?? null;
      const close1mAgo  = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo  = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m     = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m     = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;
      const haNarrative  = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);
      const rsiArrow      = rsiSlope !== null && rsiSlope < 0 ? "\u2193" : rsiSlope !== null && rsiSlope > 0 ? "\u2191" : "";
      const delta1Narr    = narrativeFromSign(delta1m);
      const delta3Narr    = narrativeFromSign(delta3m);

      const pLong  = timeAware?.adjustedUp   ?? null;
      const pShort = timeAware?.adjustedDown ?? null;

      const shortcutsHint = trading.tradingEnabled && !keyboard.stdinError
        ? `${ANSI.dim}[B]${ANSI.reset} Comprar  ${ANSI.dim}[S]${ANSI.reset} Vender  ${ANSI.dim}[Q]${ANSI.reset} Sair`
        : `${ANSI.dim}[Q]${ANSI.reset} Sair`;
      const confirmHint = keyboard.getConfirmHint({ rec, timeAware, marketUp, marketDown, tradeAmount: trading.tradeAmount });

      const timeColor  = timeLeftMin >= 10 ? ANSI.green : timeLeftMin >= 5 ? ANSI.yellow : ANSI.red;
      const liquidity  = poly.ok ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null) : null;
      const recColor   = !sawMarketStart ? ANSI.yellow : rec.action === "ENTER" ? ANSI.green : ANSI.gray;
      const recLabel   = !sawMarketStart
        ? `AGUARD. PRÓX. MERCADO  [late start]`
        : rec.action === "ENTER"
          ? `\u25BA ${rec.side === "UP" ? "BUY UP" : "BUY DOWN"}  [${rec.phase}\u00B7${rec.strength}]`
          : `NO TRADE  [${rec.phase}]`;

      const clLine  = colorPriceLine({ label: "", price: currentPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" });
      const ptbDelta = currentPrice !== null && priceToBeat !== null ? currentPrice - priceToBeat : null;
      const ptbStr   = ptbDelta === null ? ""
        : ` (${ptbDelta > 0 ? ANSI.green + "+" : ptbDelta < 0 ? ANSI.red + "-" : ANSI.gray}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset})`;

      const simStats = dryRun.getStats();

      // Position and exit eval: real when live, simulated otherwise
      let displayPos, displayCurrentMktPrice, displayExitEval;
      if (liveTrading) {
        displayPos = getPosition();
        displayCurrentMktPrice = displayPos.active ? (displayPos.side === "UP" ? marketUp : marketDown) : null;
        displayExitEval = evaluateExit({
          position: displayPos, modelUp: pLong, modelDown: pShort,
          currentMarketPrice: displayCurrentMktPrice, timeLeftMin,
          takeProfitPct: CONFIG.trading.takeProfitPct,
          stopLossPct: CONFIG.trading.stopLossPct,
          signalFlipMinProb: CONFIG.trading.signalFlipMinProb,
          stopLossMinProb: CONFIG.trading.stopLossMinProb,
          stopLossMinDurationS: CONFIG.trading.stopLossMinDurationS,
          flipConfirmCount,
          flipConfirmTicks: CONFIG.trading.flipConfirmTicks,
        });
        flipConfirmCount = displayPos.active ? (displayExitEval.flipConfirmCount ?? 0) : 0;
      } else {
        displayPos = simStats.position;
        displayCurrentMktPrice = displayPos.active ? (displayPos.side === "UP" ? marketUp : marketDown) : null;
        displayExitEval = evaluateExit({
          position: displayPos, modelUp: pLong, modelDown: pShort,
          currentMarketPrice: displayCurrentMktPrice, timeLeftMin,
          takeProfitPct: CONFIG.trading.takeProfitPct,
          stopLossPct: CONFIG.trading.stopLossPct,
          signalFlipMinProb: CONFIG.trading.signalFlipMinProb,
          stopLossMinProb: CONFIG.trading.stopLossMinProb,
          stopLossMinDurationS: CONFIG.trading.stopLossMinDurationS,
          flipConfirmCount: 0,
          flipConfirmTicks: 1,
        });
      }

      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      renderScreen(buildScreen({
        title: poly.ok ? (poly.market?.question ?? "-") : "-",
        modeTag: null,
        marketSlug,
        liveTrading,
        tradingEnabled: trading.tradingEnabled,
        initError: trading.initError,
        tradeAmount: CONFIG.trading.tradeAmount,
        usdcBalance: liveTrading ? usdcBalance : null,
        usdcBalanceError: liveTrading ? usdcBalanceError : null,
        confirmHint,
        shortcutsHint,
        binanceSpot: `${colorPriceLine({ label: "", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" })}`,
        chainlinkLine: `${clLine}${ptbStr}`,
        priceToBeat,
        intervalLine: null,
        marketUpStr:   marketUp   != null ? `${(marketUp   * 100).toFixed(1)}\u00A2` : "-",
        marketDownStr: marketDown != null ? `${(marketDown * 100).toFixed(1)}\u00A2` : "-",
        timeLeftMin,
        timeColor,
        liquidity,
        indicators: [
          { label: "Heiken Ashi", value: colorByNarrative(`${consec.color ?? "-"} x${consec.count}`, haNarrative) },
          { label: "RSI",         value: colorByNarrative(`${formatNumber(rsiNow, 1)} ${rsiArrow}`, rsiNarrative) },
          { label: "MACD",        value: colorByNarrative(macdLabel, macdNarrative) },
          { label: "\u0394 1/3 min", value: `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narr)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narr)}` },
          { label: "VWAP",        value: colorByNarrative(`${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) ${vwapSlopeLabel}`, vwapNarrative) },
        ],
        predictValue: `${ANSI.green}LONG ${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT ${formatProbPct(pShort, 0)}${ANSI.reset}`,
        recLine: `${recColor}${recLabel}${ANSI.reset}`,
        position: displayPos,
        currentMktPrice: displayCurrentMktPrice,
        exitEval: displayExitEval,
        closedTrades: simStats.recentTrades,
        runningStats: { wins: simStats.wins, losses: simStats.losses, totalPnl: simStats.cumulativePnl },
        recentOutcomes: [],
      }));

      prevSpotPrice    = spotPrice    ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;

      appendCsvRow(CSV_PATH, CSV_HEADER, [
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
        "", // outcome — filled in the SETTLED row
        "", // pnl     — filled in the SETTLED row
      ]);

      // ── Dry-run paper-trading simulator ────────────────────────────────────
      {
        const macdHistVal = macd?.hist ?? null;
        dryRun.tick({
          slug: marketSlugNow,
          priceToBeat,
          btcPrice: currentPrice,
          rec,
          modelUp: timeAware.adjustedUp,
          modelDown: timeAware.adjustedDown,
          marketUp,
          marketDown,
          timeLeftMin,
          sawMarketStart,
          dataValues: [
            new Date().toISOString(),
            marketSlugNow,
            timeLeftMin !== null ? timeLeftMin.toFixed(3) : "",
            currentPrice !== null ? currentPrice.toFixed(2) : "",
            marketUp  !== null ? marketUp.toFixed(4)  : "",
            marketDown !== null ? marketDown.toFixed(4) : "",
            regimeInfo.regime,
            signal,
            timeAware.adjustedUp  !== null ? timeAware.adjustedUp.toFixed(4)  : "",
            timeAware.adjustedDown !== null ? timeAware.adjustedDown.toFixed(4) : "",
            edge.edgeUp   !== null ? edge.edgeUp.toFixed(4)   : "",
            edge.edgeDown !== null ? edge.edgeDown.toFixed(4)  : "",
            rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE",
            rsiNow   !== null ? rsiNow.toFixed(1)   : "",
            rsiSlope !== null ? rsiSlope.toFixed(4)  : "",
            macdHistVal !== null ? macdHistVal.toFixed(6) : "",
            macdLabel,
            consec.color ?? "",
            consec.count,
            vwapNow  !== null ? vwapNow.toFixed(0)   : "",
            vwapDist !== null ? (vwapDist * 100).toFixed(4) : "",
            vwapSlope !== null ? vwapSlope.toFixed(6) : "",
          ],
        });
      }
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    // Daily summary — fires once at the first tick of each new ET day
    const todayEt = new Date().toLocaleDateString("sv", { timeZone: "America/New_York" });
    if (todayEt !== lastDaySummaryEt) {
      notifyDailySummary("15m", dryRun.getStats());
      lastDaySummaryEt = todayEt;
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
