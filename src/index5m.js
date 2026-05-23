import * as paths from "./paths.js";
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
import { fetchCollateralBalance, evaluateExit, resetIfMarketChanged, getPosition } from "./trading/position.js";
import { executeRealBuy, executeRealSell } from "./trading/executor.js";
import { createPriceLatch } from "./trading/priceLatch.js";
import { createTradeTracker } from "./trading/tracker.js";
import { createDryRunSimulator5m } from "./dryRun.js";
import { runPipeline5m } from "./backtest/pipeline5m.js";
import { ensureStrategyVersion } from "./strategy/registry.js";
import { createRedemptionWorker } from "./trading/redeem.js";
import { createRealTradeLogger } from "./trading/realTradeLog.js";
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

const CSV_PATH = paths.signals5m;
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

  const executionMode = CONFIG.executionMode;
  let trading = { client: null, tradingEnabled: false, tradeAmount: 0, initError: null };

  if (executionMode === "real") {
    if (!process.env.POLYMARKET_PRIVATE_KEY) {
      console.error("[startup] EXECUTION_MODE=real requires POLYMARKET_PRIVATE_KEY. Exiting.");
      process.exit(1);
    }
    try {
      trading = await initTradingClient(CONFIG);
    } catch (err) {
      console.error("[startup] EXECUTION_MODE=real init failed:", err?.message ?? String(err));
      process.exit(1);
    }
    if (!trading.tradingEnabled) {
      console.error("[startup] EXECUTION_MODE=real but trading client refused to enable:", trading.initError);
      process.exit(1);
    }
  }
  // paper mode: trading stays { tradingEnabled: false } — sim is the decision engine only

  const resolveMarket = createMarketResolver(CONFIG.polymarket, CONFIG.pollIntervalMs);
  const priceLatch    = createPriceLatch();
  const tracker       = createTradeTracker();

  const dumpedMarkets = new Set();
  notifyStart("5m");

  const strategyVersion = ensureStrategyVersion(CONFIG.trading, {
    registryPath: paths.strategyVersions5m,
    source: "auto",
  });
  if (strategyVersion.created) {
    console.error(`[strategy] new version detected: ${strategyVersion.label} (${strategyVersion.hash})`);
  }
  const tickCsvPath = executionMode === "real" ? paths.ticks5m : paths.dryrun5m;
  const dryRun = createDryRunSimulator5m(
    tickCsvPath,
    CONFIG.trading,
    {
      configHash: strategyVersion.hash,
      disableTradesJournal: executionMode === "real",
    },
  );
  process.on("exit", () => dryRun.flushNow());

  const realTradeLog = createRealTradeLogger(paths.real5mTrades, { configHash: strategyVersion.hash });
  const redemptionWorker = createRedemptionWorker();

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
  let prevUpTokenId        = null;
  let prevDownTokenId      = null;
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

      // Resolvido uma vez por tick: entradas do pipeline puro (gate de alinhamento BTC).
      const btcPriceForTick = chainlink?.price ?? null;
      const slugForTick = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMsForTick = poly.ok && poly.market?.eventStartTime
        ? new Date(poly.market.eventStartTime).getTime()
        : null;
      const priceToBeatForTick = priceLatch.update({
        marketSlug: slugForTick,
        currentPrice: btcPriceForTick,
        marketStartMs: marketStartMsForTick,
        market: poly.market ?? null,
      });

      // ── Pipeline (compartilhado com o backtest) ───────────────────────────
      const pipelineConfig = {
        vwapCandleWindow: CONFIG.vwapCandleWindow,
        vwapSlopeLookbackMinutes: CONFIG.vwapSlopeLookbackMinutes,
        rsiPeriod: CONFIG.rsiPeriod,
        emaCrossFast: CONFIG.emaCrossFast,
        emaCrossSlow: CONFIG.emaCrossSlow,
        candleWindowMinutes: CONFIG.candleWindowMinutes,
        trading: {
          feeRate: CONFIG.trading.feeRate,
          entryMinTimeLeftMin: CONFIG.trading.entryMinTimeLeftMin,
          requireBtcAlignment: CONFIG.trading.requireBtcAlignment,
        },
      };
      const marketUp   = poly.ok ? poly.prices.up   : null;
      const marketDown = poly.ok ? poly.prices.down  : null;

      const pipeline = runPipeline5m(
        {
          klines1m, ofiData, lastPrice, timeLeftMin,
          marketUp, marketDown,
          btcPrice: btcPriceForTick, priceToBeat: priceToBeatForTick,
        },
        pipelineConfig,
      );

      let rec          = pipeline.rec;
      const timeAware  = pipeline.timeAware;
      const edge       = pipeline.edge;

      const rsiNow    = pipeline.indicators.rsi;
      const rsiSlope  = pipeline.indicators.rsiSlope;
      const emaCross  = pipeline.indicators.emaCross;
      const momentum  = pipeline.indicators.momentum;
      const vwapNow   = pipeline.indicators.vwap;
      const vwapSlope = pipeline.indicators.vwapSlope;
      const vwapDist  = pipeline.indicators.vwapDistPct;
      const consec    = { color: pipeline.indicators.haColor, count: pipeline.indicators.haCount };

      // Backtest Fase 1: trace de ground-truth para o golden test.
      if (process.env.BACKTEST_TRACE === "1") {
        try {
          const _traceLine = JSON.stringify({
            ctx: {
              klines1m, ofiData, lastPrice, timeLeftMin,
              marketUp, marketDown,
              btcPrice: btcPriceForTick, priceToBeat: priceToBeatForTick,
            },
            result: {
              rec,
              modelUp: timeAware.adjustedUp,
              modelDown: timeAware.adjustedDown,
              edgeUp: edge.edgeUp,
              edgeDown: edge.edgeDown,
            },
          });
          fs.appendFileSync(paths.pipelineTrace, _traceLine + "\n");
        } catch { /* trace é best-effort */ }
      }

      // ── Trading ───────────────────────────────────────────────────────────
      const marketSlugNow   = poly.ok ? String(poly.market?.slug ?? "") : "";
      const conditionIdNow  = poly.ok ? (poly.market?.conditionId ?? null) : null;
      const marketStartMsNow = poly.ok && poly.market?.eventStartTime
        ? new Date(poly.market.eventStartTime).getTime()
        : null;
      // Bot must have been running within LATE_START_GRACE_MS of market open to enter
      const sawMarketStart  = marketStartMsNow === null || BOT_START_MS <= marketStartMsNow + LATE_START_GRACE_MS;

      // On market change: schedule a redemption for the prior market. The
      // worker waits ~30s for the UMA oracle to report payouts before its
      // first on-chain call, then retries with backoff if needed and skips
      // silently when the wallet holds no outcome tokens.
      // Skipped entirely for Polymarket-managed wallets (default) — they auto-
      // redeem on Polymarket's side; calling CTF directly from the EOA wastes
      // POL on a no-op tx because tokens sit in the smart wallet.
      const autoRedeemActive = trading.tradingEnabled && !CONFIG.trading.disableAutoRedeem;
      if (marketSlugNow && marketSlugNow !== prevMarketSlug && prevConditionId && autoRedeemActive) {
        redemptionWorker.enqueue({
          conditionId: prevConditionId,
          slug: prevMarketSlug,
          holderAddress: trading.balanceAddress,
          upTokenId: prevUpTokenId,
          downTokenId: prevDownTokenId,
        });
      }
      if (conditionIdNow) prevConditionId = conditionIdNow;
      if (poly.ok && poly.tokens) {
        prevUpTokenId = poly.tokens.upTokenId ?? prevUpTokenId;
        prevDownTokenId = poly.tokens.downTokenId ?? prevDownTokenId;
      }
      prevMarketSlug = marketSlugNow || prevMarketSlug;

      // Each tick, give the redemption worker a chance to fire any due retries.
      if (autoRedeemActive) {
        redemptionWorker.processPending({ wallet: trading.wallet }).catch(() => {});
      }


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

      if (trading.tradingEnabled && Date.now() - usdcLastFetchMs > 30_000) {
        usdcLastFetchMs = Date.now();
        fetchCollateralBalance(trading.balanceAddress)
          .then((bal) => { usdcBalance = bal; usdcBalanceError = null; })
          .catch((err) => { usdcBalanceError = err?.message ? err.message.slice(0, 40) : "erro"; });
      }

      const settled = await tracker.update({ marketSlug, rec, marketUp, marketDown, currentPrice, priceToBeat });
      if (settled) {
        const { slug, side, won, pnl } = settled;
        if (executionMode === "paper") {
          appendCsvRow(CSV_PATH, CSV_HEADER, [
            new Date().toISOString(), "SETTLED", "0", "", "", "", "", "", "", "", "",
            `${side}:${won ? "WIN" : "LOSS"}`, "", "", "", "", "",
            `${won ? "WIN" : "LOSS"}:${side}`, won ? "WIN" : "LOSS", pnl.toFixed(4),
          ]);
        }

        // If we hold a real position that settled with this market, close the
        // real-trade journal entry with the on-chain resolution payout.
        const pendingReal = realTradeLog.getPending();
        if (pendingReal && pendingReal.marketSlug === settled.slug && settled.winner) {
          const realWon = pendingReal.side === settled.winner;
          const exitPrice = realWon ? 1.0 : 0.0;
          const exitValue = (pendingReal.shares ?? 0) * exitPrice;
          const realPnl = exitValue - (pendingReal.invested ?? 0);
          const realRoi = pendingReal.invested ? (realPnl / pendingReal.invested) * 100 : 0;
          realTradeLog.recordExit({
            exitPrice, pnl: realPnl, roi: realRoi,
            exitReason: realWon ? "SETTLED_WIN" : "SETTLED_LOSS",
          });
        }
      }

      if (poly.ok && poly.market && priceToBeat === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync(paths.LOG_ROOT, { recursive: true });
            fs.writeFileSync(path.join(paths.LOG_ROOT, `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
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
        disableTakeProfit: CONFIG.trading.disableTakeProfit ?? true,
        disableStopLoss: CONFIG.trading.disableStopLoss ?? false,
        disableSignalFlip: CONFIG.trading.disableSignalFlip ?? false,
        disableTimeDecay: CONFIG.trading.disableTimeDecay ?? true,
        timeDecayMinLeftMin: CONFIG.trading.timeDecayMinLeftMin ?? 2.5,
        timeDecayMinLossPct: CONFIG.trading.timeDecayMinLossPct ?? 15,
        feeRate: CONFIG.trading.feeRate ?? 0,
      };
      if (executionMode === "real") {
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
        liveTrading: executionMode === "real",
        tradingEnabled: trading.tradingEnabled,
        initError: trading.initError,
        tradeAmount: CONFIG.trading.tradeAmount,
        usdcBalance: executionMode === "real" ? usdcBalance : null,
        usdcBalanceError: executionMode === "real" ? usdcBalanceError : null,
        confirmHint: null,
        shortcutsHint: null,
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

      if (executionMode === "paper") {
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
      }

      // ── Dry-run paper-trading simulator (drives real trade dispatch) ────
      {
        const simResult = await dryRun.tick({
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

        // ── Mirror the sim's decision on the real exchange ────────────
        // Real orders only fire when the sim itself decided to BUY/SELL.
        // The sim already enforced all entry/exit gates; the executor adds
        // a slippage check (live price vs the sim's decision price).
        if (trading.tradingEnabled && simResult) {
          if (simResult.action === "BUY") {
            await executeRealBuy({
              trading, poly,
              side: simResult.side,
              simDecisionPrice: simResult.decisionPrice,
              takerBuffer: CONFIG.trading.takerBuffer,
              entryMaxMarketPrice: CONFIG.trading.entryMaxMarketPrice,
              marketSlug: simResult.marketSlug,
              botLabel: "5m",
              onTrade: ({ entryPrice, invested, shares, timestamp, txHash }) => {
                realTradeLog.recordEntry({
                  side: simResult.side,
                  marketSlug: simResult.marketSlug,
                  entryPrice, invested, shares, timestamp,
                  ptbAtEntry: priceToBeat,
                  btcAtEntry: currentPrice,
                  marketUpAtEntry: marketUp,
                  marketDownAtEntry: marketDown,
                  txHash,
                  feeRate: CONFIG.trading.feeRate,
                });
              },
            });
          } else if (simResult.action === "SELL") {
            await executeRealSell({
              trading, poly,
              simDecisionPrice: simResult.decisionPrice,
              slippageTolerancePct: CONFIG.trading.slippageTolerancePct,
              takerBuffer: CONFIG.trading.takerBuffer,
              exitReason: simResult.exitReason ?? "SIM_EXIT",
              marketSlug: simResult.marketSlug,
              botLabel: "5m",
              onTrade: ({ exitPrice, pnl, roi, exitReason, timestamp, txHash }) => {
                realTradeLog.recordExit({ exitPrice, pnl, roi, exitReason, timestamp, txHash });
              },
            });
          }
        }
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
