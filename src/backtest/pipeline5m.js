import { computeVwapSeries } from "../indicators/vwap.js";
import { computeRsi, slopeLast } from "../indicators/rsi.js";
import { computeHeikenAshi, countConsecutive } from "../indicators/heikenAshi.js";
import { computeEmaCross } from "../indicators/emaCross.js";
import { scoreOrderFlow } from "../indicators/orderFlow.js";
import { computeMomentum, scoreMomentum } from "../indicators/momentum.js";
import { scoreDirection5m, applyTimeAwareness5m } from "../engines/probability5m.js";
import { computeEdge, decide5m } from "../engines/edge5m.js";

/**
 * Pipeline puro per-tick do bot 5m. Sem I/O, sem rede.
 * @param {object} ctx   - TickContext: dados do tick (live ou replay)
 *   {Array}  klines1m   - candles OHLCV 1m da Binance
 *   {object} ofiData    - estado do order-flow (saída de ofiStream.getOfi())
 *   {number} lastPrice  - último preço spot Binance
 *   {number} timeLeftMin
 *   {number|null} marketUp, marketDown - preços Polymarket
 *   {number|null} btcPrice  - preço Chainlink BTC/USD
 *   {number|null} priceToBeat
 * @param {object} config - subconjunto de CONFIG (ver index5m.js)
 *   campos: vwapCandleWindow, vwapSlopeLookbackMinutes, rsiPeriod,
 *           emaCrossFast, emaCrossSlow, candleWindowMinutes,
 *           trading: { feeRate, entryMinTimeLeftMin, requireBtcAlignment }
 * @returns {object} TickResult
 */
export function runPipeline5m(ctx, config) {
  const { klines1m, ofiData, lastPrice, timeLeftMin, marketUp, marketDown,
          btcPrice, priceToBeat } = ctx;

  // ── Indicadores ──
  const vwapCandles = klines1m.slice(-config.vwapCandleWindow);
  const allCloses   = klines1m.map((c) => c.close);

  const vwapSeries = computeVwapSeries(vwapCandles);
  const vwapNow    = vwapSeries[vwapSeries.length - 1];
  const lookback   = config.vwapSlopeLookbackMinutes;
  const vwapSlope  = vwapSeries.length >= lookback
    ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback
    : null;
  const vwapDist   = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

  const rsiNow = computeRsi(allCloses, config.rsiPeriod);
  const rsiSeries = [];
  for (let i = 0; i < allCloses.length; i++) {
    const r = computeRsi(allCloses.slice(0, i + 1), config.rsiPeriod);
    if (r !== null) rsiSeries.push(r);
  }
  const rsiSlope = slopeLast(rsiSeries, 3);

  const emaCross       = computeEmaCross(allCloses, config.emaCrossFast, config.emaCrossSlow);
  const ha             = computeHeikenAshi(klines1m.slice(-10));
  const consec         = countConsecutive(ha);
  const momentum       = computeMomentum(klines1m);
  const momentumScore  = scoreMomentum(momentum);
  const orderFlowScore = scoreOrderFlow(ofiData);

  // ── Sinal ──
  const scored = scoreDirection5m({
    orderFlow: orderFlowScore, momentumScore, emaCross,
    rsi: rsiNow, rsiSlope,
    heikenColor: consec.color, heikenCount: consec.count,
    price: lastPrice, vwap: vwapNow, vwapSlope,
  });

  const timeAware = applyTimeAwareness5m(scored.rawUp, timeLeftMin, config.candleWindowMinutes);
  const edge = computeEdge({
    modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
    marketYes: marketUp, marketNo: marketDown,
  });
  const ofi1mVal = ofiData.ofi1m?.ofi ?? null;

  let rec = decide5m({
    remainingMinutes: timeLeftMin,
    edgeUp: edge.edgeUp, edgeDown: edge.edgeDown,
    modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown,
    marketUp, marketDown,
    heikenColor: consec.color, ofi1m: ofi1mVal,
    feeRate: config.trading.feeRate,
    minTimeLeftMin: config.trading.entryMinTimeLeftMin,
  });

  // ── Gate de alinhamento BTC ──
  if (rec.action === "ENTER" && config.trading.requireBtcAlignment
      && btcPrice !== null && priceToBeat !== null) {
    const btcVsPtb = btcPrice - priceToBeat;
    const againstUp   = rec.side === "UP"   && btcVsPtb < 0;
    const againstDown = rec.side === "DOWN" && btcVsPtb > 0;
    if (againstUp || againstDown) {
      rec = { action: "NO_TRADE", side: null, phase: rec.phase, reason: "side_against_btc" };
    }
  }

  return {
    rec,
    modelUp: timeAware.adjustedUp,
    modelDown: timeAware.adjustedDown,
    edgeUp: edge.edgeUp,
    edgeDown: edge.edgeDown,
    scored,
    timeAware,
    edge,
    indicators: {
      rsi: rsiNow, rsiSlope, emaCross,
      haColor: consec.color, haCount: consec.count,
      vwap: vwapNow, vwapDistPct: vwapDist, vwapSlope,
      momentum, momentumScore, orderFlowScore, ofi1m: ofi1mVal,
    },
  };
}
