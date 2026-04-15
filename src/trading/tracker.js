/**
 * Per-market signal outcome tracker.
 *
 * Tracks which direction the model recommended when entering a market, then
 * computes win/loss when the market slug changes (i.e. the market settled).
 *
 * The settled result is returned from update() so the caller can write it to
 * the CSV in whatever format the app requires.
 *
 * Usage:
 *   const tracker = createTradeTracker();
 *   // inside the poll loop:
 *   const settled = await tracker.update({ marketSlug, rec, marketUp, marketDown, currentPrice, priceToBeat });
 *   if (settled) appendCsvRow(..., buildSettledRow(settled));
 */
import { fetchMarketOutcome } from "../data/polymarket.js";

export function createTradeTracker() {
  let tradeState = {
    slug: null,
    side: null,
    entryMarketPrice: null,
    priceToBeat: null,
    lastChainlinkPrice: null,
    hasSignal: false,
  };
  let runningStats = { wins: 0, losses: 0, totalPnl: 0 };
  let recentOutcomes = []; // { slug, side, won, pnl, ts }[]

  /**
   * @param {object}      ctx
   * @param {string}      ctx.marketSlug
   * @param {object}      ctx.rec          - decide() result
   * @param {number|null} ctx.marketUp
   * @param {number|null} ctx.marketDown
   * @param {number|null} ctx.currentPrice - live Chainlink price
   * @param {number|null} ctx.priceToBeat
   *
   * @returns {Promise<{ slug, side, won, pnl, ts } | null>}  settled outcome, or null
   */
  async function update({ marketSlug, rec, marketUp, marketDown, currentPrice, priceToBeat }) {
    let settled = null;

    if (tradeState.slug !== null && tradeState.slug !== "" && marketSlug !== tradeState.slug) {
      // Market changed — evaluate the previous market's outcome
      if (tradeState.hasSignal) {
        // Prefer definitive outcome from Polymarket API (outcomePrices); fall back to ptb
        let winner = await fetchMarketOutcome(tradeState.slug).catch(() => null);
        if (winner === null && tradeState.priceToBeat !== null && tradeState.lastChainlinkPrice !== null) {
          winner = tradeState.lastChainlinkPrice > tradeState.priceToBeat ? "UP" : "DOWN";
        }
        if (winner !== null) {
          const won = tradeState.side === winner;
          const ep = tradeState.entryMarketPrice ?? 0.5;
          const pnl = won ? (1 / ep) - 1 : -1;
          if (won) runningStats.wins += 1; else runningStats.losses += 1;
          runningStats.totalPnl += pnl;
          const outcome = { slug: tradeState.slug, side: tradeState.side, won, pnl, ts: new Date().toISOString() };
          recentOutcomes.unshift(outcome);
          if (recentOutcomes.length > 10) recentOutcomes.pop();
          settled = outcome;
        }
      }
      tradeState = {
        slug: marketSlug,
        side: null,
        entryMarketPrice: null,
        priceToBeat: null,
        lastChainlinkPrice: currentPrice,
        hasSignal: false,
      };
    } else if (tradeState.slug === null || tradeState.slug === "") {
      tradeState.slug = marketSlug;
    }

    // Latch the first signal for this market
    if (!tradeState.hasSignal && rec.action === "ENTER" && marketSlug) {
      tradeState.side = rec.side;
      tradeState.entryMarketPrice = rec.side === "UP" ? marketUp : marketDown;
      tradeState.hasSignal = true;
    }

    if (currentPrice !== null) tradeState.lastChainlinkPrice = currentPrice;
    if (priceToBeat !== null) tradeState.priceToBeat = priceToBeat;

    return settled;
  }

  return {
    update,
    getStats: () => ({ ...runningStats }),
    getRecentOutcomes: () => recentOutcomes,
  };
}
