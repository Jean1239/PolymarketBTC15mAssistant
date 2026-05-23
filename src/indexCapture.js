import { CONFIG as CONFIG_15M } from "./config.js";
import { CONFIG as CONFIG_5M }  from "./config5m.js";
import { createMarketResolver, fetchPolymarketSnapshot } from "./data/polymarket.js";
import { createOrderbookCapture } from "./backtest/orderbookCapture.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { sleep } from "./utils.js";
import * as paths from "./paths.js";

applyGlobalProxyFromEnv();

async function main() {
  const resolver5m  = createMarketResolver(CONFIG_5M.polymarket,  CONFIG_5M.pollIntervalMs);
  const resolver15m = createMarketResolver(CONFIG_15M.polymarket, CONFIG_15M.pollIntervalMs);

  const cap5m  = createOrderbookCapture({
    dir: paths.CAPTURE_DIR, depthLevels: 10, retentionDays: 90, fileBase: "orderbook_5m",
  });
  const cap15m = createOrderbookCapture({
    dir: paths.CAPTURE_DIR, depthLevels: 10, retentionDays: 90, fileBase: "orderbook_15m",
  });

  const pollInterval = Math.min(CONFIG_5M.pollIntervalMs, CONFIG_15M.pollIntervalMs);

  console.error("[capture] starting — 5m + 15m orderbook capture");

  let alive = true;
  process.on("SIGINT",  () => { alive = false; });
  process.on("SIGTERM", () => { alive = false; });

  while (alive) {
    try {
      const [poly5m, poly15m] = await Promise.all([
        fetchPolymarketSnapshot(resolver5m,  CONFIG_5M.polymarket).catch(() => null),
        fetchPolymarketSnapshot(resolver15m, CONFIG_15M.polymarket).catch(() => null),
      ]);

      if (poly5m?.ok && poly5m.rawBook?.up && poly5m.rawBook?.down) {
        const slug = String(poly5m.market?.slug ?? "");
        const endMs = poly5m.market?.endDate ? new Date(poly5m.market.endDate).getTime() : null;
        const timeLeftMin = endMs ? (endMs - Date.now()) / 60_000 : null;
        try { cap5m.record({ slug, timeLeftMin, rawBook: poly5m.rawBook }); } catch {}
      }
      if (poly15m?.ok && poly15m.rawBook?.up && poly15m.rawBook?.down) {
        const slug = String(poly15m.market?.slug ?? "");
        const endMs = poly15m.market?.endDate ? new Date(poly15m.market.endDate).getTime() : null;
        const timeLeftMin = endMs ? (endMs - Date.now()) / 60_000 : null;
        try { cap15m.record({ slug, timeLeftMin, rawBook: poly15m.rawBook }); } catch {}
      }
    } catch (err) {
      console.error("[capture] poll error:", err?.message ?? err);
    }
    await sleep(pollInterval);
  }

  console.error("[capture] graceful shutdown");
}

main();
