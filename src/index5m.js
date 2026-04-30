import { CONFIG } from "./config5m.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import { createMarketResolver, fetchPolymarketSnapshot } from "./data/polymarket.js";
import { startBinanceOfiStream } from "./data/binanceWsOfi.js";
import { computeVwapSeries } from "./indicators/vwap.js";
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
  colorPriceLine, formatSignedDelta,
  colorByNarrative, narrativeFromSign,
  narrativeFromSlope, formatProbPct, fmtEtHHMM,
  safeFileSlug, setStatusMessage
} from "./display.js";
import { initTradingClient } from "./trading/client.js";
import { fetchUsdcBalance, evaluateExit, resetIfMarketChanged, getPosition } from "./trading/position.js";
import { setupKeyboard } from "./trading/keyboard.js";
import { processActionQueue } from "./trading/executor.js";
import { createPriceLatch } from "./trading/priceLatch.js";
import { createTradeTracker } from "./trading/tracker.js";
import { createDryRunSimulator5m } from "./dryRun.js";
import { redeemSettledPositions } from "./trading/redeem.js";
import { notifyStart, notifyDailySummary } from "./notify.js";

applyGlobalProxyFromEnv();

function ofiLabel(ofi) {
  if (!ofi || ofi.total === 0) return "-";
  const pct  = (ofi.ofi * 100).toFixed(0);
  const sign = ofi.ofi > 0 ? "+" : "";
  return `${sign}${pct}%`;
}

function ofiNarrative(ofi) {
  if (!ofi || ofi.total === 0) return "NEUTRAL";
  if (ofi.ofi >  0.05) return "LONG";
  if (ofi.ofi < -0.05) return "SHORT";
  return "NEUTRAL";
}

const CSV_PATH = "./logs/signals_5m.csv";
const CSV_HEADER = [
  "timestamp", "entry_minute", "time_left_min",
  "ofi_30s", "ofi_1m", "ofi_2m",
  "roc1", "roc3", "ema_cross", "rsi", "signal",
  "model_up", "model_down", "mkt_up", "mkt_down",
  "edge_up", "edge_down", "recommendation", "outcome", "pnl",
];

async function main() {
  const ofiStream            = startBinanceOfiStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream      = startChainlinkPriceStream({});

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

  const dumpedMarkets = new Set();
  notifyStart("5m");

  const dryRun = createDryRunSimulator5m("./logs/dryrun_5m.csv", CONFIG.trading);
  process.on("exit", () => dryRun.flushNow());

  // Late-start guard: skip entering positions on markets the bot didn't see from open
  const BOT_START_MS = Date.now();
  const LATE_START_GRACE_MS = 90_000; // 90s grace window

  let signalCooldown = { side: null, ts: 0, slug: null };
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

    const wsTick            = ofiStream.getLast();
    const wsPrice           = wsTick?.price ?? null;
    const ofiData           = ofiStream.getOfi();
    const polymarketWsTick  = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;
    const chainlinkWsTick   = chainlinkStream.getLast();
    const chainlinkWsPrice  = chainlinkWsTick?.price ?? null;

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
        fetchPolymarketSnapshot(resolveMarket, CONFIG.polymarket),
      ]);

      const settlementMs      = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
      const timeLeftMin       = settlementLeftMin ?? timing.remainingMinutes;

      // ── Indicators ────────────────────────────────────────────────────────
      const vwapCandles = klines1m.slice(-CONFIG.vwapCandleWindow);
      const allCloses   = klines1m.map((c) => c.close);

      const vwapSeries = computeVwapSeries(vwapCandles);
      const vwapNow    = vwapSeries[vwapSeries.length - 1];
      const lookback   = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope  = vwapSeries.length >= lookback
        ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback
        : null;
      const vwapDist   = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;
      const rsiNow = computeRsi(allCloses, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < allCloses.length; i++) {
        const r = computeRsi(allCloses.slice(0, i + 1), CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiSlope = slopeLast(rsiSeries, 3);

      const emaCross      = computeEmaCross(allCloses, CONFIG.emaCrossFast, CONFIG.emaCrossSlow);
      const ha            = computeHeikenAshi(klines1m.slice(-10));
      const consec        = countConsecutive(ha);
      const momentum      = computeMomentum(klines1m);
      const momentumScore = scoreMomentum(momentum);
      const orderFlowScore = scoreOrderFlow(ofiData);

      // ── Signal ────────────────────────────────────────────────────────────
      const scored = scoreDirection5m({
        orderFlow: orderFlowScore, momentumScore, emaCross,
        rsi: rsiNow, rsiSlope,
        heikenColor: consec.color, heikenCount: consec.count,
        price: lastPrice, vwap: vwapNow, vwapSlope,
      });

      const timeAware  = applyTimeAwareness5m(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);
      const marketUp   = poly.ok ? poly.prices.up   : null;
      const marketDown = poly.ok ? poly.prices.down  : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });
      const ofi1mVal = ofiData.ofi1m?.ofi ?? null;
      let rec = decide5m({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, heikenColor: consec.color, ofi1m: ofi1mVal });

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
          .catch(() => {});
      }
      if (conditionIdNow) prevConditionId = conditionIdNow;
      prevMarketSlug = marketSlugNow || prevMarketSlug;


      // ── Signal cooldown (prevent flip-flop) ───────────────────────────────
      if (rec.action === "ENTER") {
        if (signalCooldown.slug !== marketSlugNow) {
          signalCooldown = { side: null, ts: 0, slug: marketSlugNow };
        }
        if (signalCooldown.side !== null && signalCooldown.side !== rec.side && Date.now() - signalCooldown.ts < 30_000) {
          rec = { action: "NO_TRADE", side: null, phase: rec.phase, reason: "cooldown" };
        }
        if (rec.action === "ENTER") {
          signalCooldown = { side: rec.side, ts: Date.now(), slug: marketSlugNow };
        }
      }
      resetIfMarketChanged(marketSlugNow);

      // ── Derived display values ─────────────────────────────────────────────
      const spotPrice    = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug   = poly.ok ? String(poly.market?.slug ?? "") : "";
      const settlementMs5m = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;

      const priceToBeat = priceLatch.update({ marketSlug, currentPrice, marketStartMs: marketStartMsNow, market: poly.market ?? null });

      await processActionQueue(keyboard.actionQueue, { trading, poly, rec, timeAware, marketSlugNow, btcPrice: currentPrice, priceToBeat, botLabel: "5m", sawMarketStart });

      if (trading.tradingEnabled && Date.now() - usdcLastFetchMs > 30_000) {
        usdcLastFetchMs = Date.now();
        fetchUsdcBalance(trading.balanceAddress)
          .then((bal) => { usdcBalance = bal; usdcBalanceError = null; })
          .catch((err) => { usdcBalanceError = err?.message ? err.message.slice(0, 40) : "erro"; });
      }

      const settled = await tracker.update({ marketSlug, rec, marketUp, marketDown, currentPrice, priceToBeat });
      if (settled) {
        const { slug, side, won, pnl } = settled;
        appendCsvRow(CSV_PATH, CSV_HEADER, [
          new Date().toISOString(), "SETTLED", "0", "", "", "", "", "", "", "", "",
          `${side}:${won ? "WIN" : "LOSS"}`, "", "", "", "", "",
          `${won ? "WIN" : "LOSS"}:${side}`, won ? "WIN" : "LOSS", pnl.toFixed(4),
        ]);
      }

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
      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose  = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m    = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m    = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const pLong  = timeAware?.adjustedUp   ?? null;
      const pShort = timeAware?.adjustedDown ?? null;

      const ofi30Narrative = ofiNarrative(ofiData.ofi30s);
      const ofi1Narrative  = ofiNarrative(ofiData.ofi1m);
      const ofi2Narrative  = ofiNarrative(ofiData.ofi2m);
      const ofiValue = `30s:${colorByNarrative(ofiLabel(ofiData.ofi30s), ofi30Narrative)} | 1m:${colorByNarrative(ofiLabel(ofiData.ofi1m), ofi1Narrative)} | 2m:${colorByNarrative(ofiLabel(ofiData.ofi2m), ofi2Narrative)}`;

      const emaLabel = emaCross === null ? "-"
        : emaCross.crossover !== "NONE"
          ? `${emaCross.crossover} (${emaCross.expanding ? "expanding" : "flat"})`
          : emaCross.bullish
            ? `bullish${emaCross.expanding ? " (expanding)" : ""}`
            : `bearish${emaCross.expanding ? " (expanding)" : ""}`;
      const emaNarrative = emaCross === null ? "NEUTRAL" : emaCross.bullish ? "LONG" : "SHORT";

      const momLabel = momentum === null ? "-" : (() => {
        const r1  = momentum.roc1 !== null ? `${(momentum.roc1 * 100).toFixed(3)}%` : "-";
        const r3  = momentum.roc3 !== null ? `${(momentum.roc3 * 100).toFixed(3)}%` : "-";
        const acc = momentum.accel !== null
          ? (momentum.accel > 0 ? " \u2191accel" : momentum.accel < 0 ? " \u2193decel" : "")
          : "";
        return `1m:${r1} | 3m:${r3}${acc}`;
      })();
      const momNarrative  = momentum?.roc1 != null ? narrativeFromSign(momentum.roc1) : "NEUTRAL";
      const rsiArrow      = rsiSlope !== null && rsiSlope < 0 ? "\u2193" : rsiSlope !== null && rsiSlope > 0 ? "\u2191" : "";
      const rsiNarrative  = narrativeFromSlope(rsiSlope);
      const haNarrative   = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";
      const vwapNarrative = narrativeFromSign(vwapDist);
      const delta1Narr    = narrativeFromSign(delta1m);
      const delta3Narr    = narrativeFromSign(delta3m);

      const signal   = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";
      const recColor = !sawMarketStart ? ANSI.yellow : rec.action === "ENTER" ? ANSI.green : ANSI.gray;
      const recLabel = !sawMarketStart
        ? `AGUARD. PRÓX. MERCADO  [late start]`
        : rec.action === "ENTER"
          ? `\u25BA ${rec.side === "UP" ? "BUY UP" : "BUY DOWN"}  [${rec.phase}\u00B7${rec.strength}]`
          : `NO TRADE  [${rec.phase}]`;

      const isNextMarket = marketStartMsNow !== null && marketStartMsNow > Date.now();
      const timeColor    = isNextMarket ? ANSI.yellow : timeLeftMin >= 3 ? ANSI.green : timeLeftMin >= 1.5 ? ANSI.yellow : ANSI.red;
      const liquidity    = poly.ok ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null) : null;

      const clLine   = colorPriceLine({ label: "", price: currentPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" });
      const ptbDelta = currentPrice !== null && priceToBeat !== null ? currentPrice - priceToBeat : null;
      const ptbStr   = ptbDelta === null ? ""
        : ` (${ptbDelta > 0 ? ANSI.green + "+" : ptbDelta < 0 ? ANSI.red + "-" : ANSI.gray}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset})`;

      const shortcutsHint = trading.tradingEnabled && !keyboard.stdinError
        ? `${ANSI.dim}[B]${ANSI.reset} Comprar  ${ANSI.dim}[S]${ANSI.reset} Vender  ${ANSI.dim}[Q]${ANSI.reset} Sair`
        : `${ANSI.dim}[Q]${ANSI.reset} Sair`;
      const confirmHint = keyboard.getConfirmHint({ rec, timeAware, marketUp, marketDown, tradeAmount: trading.tradeAmount });

      const intervalLine = (marketStartMsNow !== null && settlementMs5m !== null)
        ? kv("Intervalo:", `${isNextMarket ? ANSI.yellow : ""}${fmtEtHHMM(marketStartMsNow)} \u2192 ${fmtEtHHMM(settlementMs5m)} ET${isNextMarket ? ANSI.reset : ""}`)
        : null;

      const simStats = dryRun.getStats();

      // Position and exit eval: real when live, simulated otherwise
      let displayPos, displayCurrentMktPrice, displayExitEval;
      const baseExitEvalArgs = {
        takeProfitPct: CONFIG.trading.takeProfitPct,
        stopLossPct: CONFIG.trading.stopLossPct,
        signalFlipMinProb: CONFIG.trading.signalFlipMinProb,
        stopLossMinProb: CONFIG.trading.stopLossMinProb,
        stopLossMinDurationS: CONFIG.trading.stopLossMinDurationS,
        flipConfirmTicks: CONFIG.trading.flipConfirmTicks,
        btcPrice: currentPrice, priceToBeat,
        ptbSafeMarginUsd: CONFIG.trading.ptbSafeMarginUsd,
        disableStopLoss: CONFIG.trading.disableStopLoss ?? false,
        disableSignalFlip: CONFIG.trading.disableSignalFlip ?? false,
        disableTimeDecay: CONFIG.trading.disableTimeDecay ?? false,
        timeDecayMinLeftMin: CONFIG.trading.timeDecayMinLeftMin ?? 2.5,
        timeDecayMinLossPct: CONFIG.trading.timeDecayMinLossPct ?? 15,
      };
      if (liveTrading) {
        displayPos = getPosition();
        displayCurrentMktPrice = displayPos.active ? (displayPos.side === "UP" ? marketUp : marketDown) : null;
        displayExitEval = evaluateExit({
          ...baseExitEvalArgs,
          position: displayPos, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
          currentMarketPrice: displayCurrentMktPrice, timeLeftMin,
          flipConfirmCount,
        });
        flipConfirmCount = displayPos.active ? (displayExitEval.flipConfirmCount ?? 0) : 0;
      } else {
        displayPos = simStats.position;
        displayCurrentMktPrice = displayPos.active ? (displayPos.side === "UP" ? marketUp : marketDown) : null;
        displayExitEval = evaluateExit({
          ...baseExitEvalArgs,
          position: displayPos, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
          currentMarketPrice: displayCurrentMktPrice, timeLeftMin,
          flipConfirmCount: 0,
          flipConfirmTicks: 1,
        });
      }

      const modeTag = isNextMarket ? `${ANSI.yellow}[5m] [PROXIMO]${ANSI.reset}` : `${ANSI.yellow}[5m]${ANSI.reset}`;

      renderScreen(buildScreen({
        title: poly.ok ? (poly.market?.question ?? "-") : "-",
        modeTag,
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
        intervalLine,
        marketUpStr:   marketUp   != null ? `${(marketUp   * 100).toFixed(1)}\u00A2` : "-",
        marketDownStr: marketDown != null ? `${(marketDown * 100).toFixed(1)}\u00A2` : "-",
        timeLeftMin,
        timeColor,
        liquidity,
        indicators: [
          { label: "Order Flow",    value: ofiValue },
          { label: "Momentum",      value: colorByNarrative(momLabel, momNarrative) },
          { label: "EMA Cross",     value: colorByNarrative(emaLabel, emaNarrative) },
          { label: "RSI",           value: colorByNarrative(`${formatNumber(rsiNow, 1)} ${rsiArrow}`, rsiNarrative) },
          { label: "Heiken Ashi",   value: colorByNarrative(`${consec.color ?? "-"} x${consec.count}`, haNarrative) },
          { label: "VWAP",          value: colorByNarrative(`${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) ${vwapSlopeLabel}`, vwapNarrative) },
          { label: "\u0394 1/3 min", value: `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narr)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narr)}` },
        ],
        predictValue: `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`,
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
        ofiData.ofi30s?.ofi?.toFixed(3) ?? "",
        ofiData.ofi1m?.ofi?.toFixed(3)  ?? "",
        ofiData.ofi2m?.ofi?.toFixed(3)  ?? "",
        momentum?.roc1?.toFixed(6) ?? "",
        momentum?.roc3?.toFixed(6) ?? "",
        emaCross?.crossover ?? "",
        rsiNow?.toFixed(1)  ?? "",
        signal,
        timeAware.adjustedUp,
        timeAware.adjustedDown,
        marketUp,
        marketDown,
        edge.edgeUp,
        edge.edgeDown,
        rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE",
        "", // outcome
        "", // pnl
      ]);

      // ── Dry-run paper-trading simulator ────────────────────────────────────
      {
        await dryRun.tick({
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
            marketUp   !== null ? marketUp.toFixed(4)   : "",
            marketDown !== null ? marketDown.toFixed(4)  : "",
            signal,
            timeAware.adjustedUp   !== null ? timeAware.adjustedUp.toFixed(4)   : "",
            timeAware.adjustedDown !== null ? timeAware.adjustedDown.toFixed(4)  : "",
            edge.edgeUp   !== null ? edge.edgeUp.toFixed(4)   : "",
            edge.edgeDown !== null ? edge.edgeDown.toFixed(4)  : "",
            rec.action === "ENTER" ? `${rec.side}:${rec.phase}:${rec.strength}` : "NO_TRADE",
            ofiData.ofi30s?.ofi !== undefined ? ofiData.ofi30s.ofi.toFixed(3) : "",
            ofiData.ofi1m?.ofi  !== undefined ? ofiData.ofi1m.ofi.toFixed(3)  : "",
            ofiData.ofi2m?.ofi  !== undefined ? ofiData.ofi2m.ofi.toFixed(3)  : "",
            momentum?.roc1 !== null && momentum?.roc1 !== undefined ? momentum.roc1.toFixed(6) : "",
            momentum?.roc3 !== null && momentum?.roc3 !== undefined ? momentum.roc3.toFixed(6) : "",
            emaCross?.crossover ?? "",
            rsiNow !== null ? rsiNow.toFixed(1) : "",
            consec.color ?? "",
            consec.count,
            vwapNow  !== null ? vwapNow.toFixed(0)          : "",
            vwapDist !== null ? (vwapDist * 100).toFixed(4) : "",
            vwapSlope !== null ? vwapSlope.toFixed(6)        : "",
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
      notifyDailySummary("5m", dryRun.getStats());
      lastDaySummaryEt = todayEt;
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
