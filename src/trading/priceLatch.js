import { fetchChainlinkPriceAtMs } from "../data/chainlink.js";
import { priceToBeatFromPolymarketMarket } from "../display.js";

/**
 * Stateful manager that latches the Chainlink BTC/USD price at the moment a
 * new market opens. This is the "price to beat" shown on the display.
 *
 * Strategy (in priority order):
 *   1. Read the reference price embedded in the Polymarket market object.
 *   2. If the app started late (>30s after open), fetch the historical
 *      Chainlink price at the exact open timestamp.
 *   3. Otherwise latch the live Chainlink price on the first tick.
 *
 * Usage:
 *   const latch = createPriceLatch();
 *   // inside the poll loop:
 *   const priceToBeat = latch.update({ marketSlug, currentPrice, marketStartMs, market });
 */
export function createPriceLatch() {
  let state = { slug: null, value: null, setAtMs: null, source: null };
  let fetching = false;

  /**
   * @param {string}      marketSlug
   * @param {number|null} currentPrice   - live Chainlink price this tick
   * @param {number|null} marketStartMs  - market open timestamp (ms)
   * @param {object|null} market         - raw Polymarket market object
   * @returns {number|null} latched price, or null if not yet available
   */
  function update({ marketSlug, currentPrice, marketStartMs, market }) {
    // Reset when the market slug changes
    if (marketSlug && state.slug !== marketSlug) {
      state = { slug: marketSlug, value: null, setAtMs: null, source: null };
    }

    // 1. Try reading reference price from the market object itself
    if (state.slug && state.value === null && market) {
      const fromMarket = priceToBeatFromPolymarketMarket(market);
      if (fromMarket !== null) {
        state = { slug: state.slug, value: fromMarket, setAtMs: Date.now(), source: "market" };
        return state.value;
      }
    }

    // 2 & 3. Latch from Chainlink
    if (state.slug && state.value === null && !fetching) {
      const nowMs = Date.now();
      const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
      if (!okToLatch) return null;

      const lateMs = marketStartMs !== null ? nowMs - marketStartMs : 0;
      if (lateMs > 30_000 && marketStartMs !== null) {
        // App started late — fetch historical price at the open
        fetching = true;
        const slugAtFetch = state.slug;
        fetchChainlinkPriceAtMs(marketStartMs).then((p) => {
          if (state.slug !== slugAtFetch || state.value !== null) return;
          if (p !== null) {
            state = { slug: slugAtFetch, value: p, setAtMs: marketStartMs, source: "chainlink_historical" };
          } else if (currentPrice !== null) {
            state = { slug: slugAtFetch, value: Number(currentPrice), setAtMs: nowMs, source: "chainlink_latch" };
          }
        }).catch(() => { /* ignore — will retry next tick */ })
          .finally(() => { fetching = false; });
      } else if (currentPrice !== null) {
        state = { slug: state.slug, value: Number(currentPrice), setAtMs: nowMs, source: "chainlink_latch" };
      }
    }

    return state.slug === marketSlug ? state.value : null;
  }

  return { update };
}
