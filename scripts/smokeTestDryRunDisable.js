import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDryRunSimulator5m } from "../src/dryRun.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dryrun-dis-"));
const tickCsv = path.join(tmp, "ticks_5m.csv");
const tradesCsv = path.join(tmp, "ticks_5m_trades.csv");

const sim = createDryRunSimulator5m(tickCsv, {}, { disableTradesJournal: true });

// A single tick that does NOT enter a position — proves the trade CSV never gets
// created. Verifies the file-creation invariant without needing to simulate a
// full buy/sell cycle (that would require complex setup).
await sim.tick({
  slug: "mkt-1", priceToBeat: 100000, btcPrice: 100100,
  rec: { action: "NO_TRADE", side: null, phase: "EARLY", reason: "test" },
  modelUp: 0.5, modelDown: 0.5, marketUp: 0.5, marketDown: 0.5,
  timeLeftMin: 4, dataValues: new Array(20).fill(""),
});
sim.flushNow();

assert.equal(fs.existsSync(tradesCsv), false,
  `trades CSV must not exist when disableTradesJournal=true: ${tradesCsv}`);

const stats = sim.getStats();
assert.equal(stats.totalTrades, 0, "no trades recorded in NO_TRADE tick");

// Step 4: Strengthen to exercise _logTrade is a no-op via slug change (settle path)

const sim2 = createDryRunSimulator5m(tickCsv + ".2.csv", {
  // Use permissive entry bounds so the ENTER tick actually opens a position
  entryMinMarketPrice: 0.49,
  entryMaxMarketPrice: 0.55,
  blockedHoursUtc: [],
  btcVsPtbMinAbsUsd: 0,
}, { disableTradesJournal: true });
const tradesCsv2 = tickCsv + ".2_trades.csv";

// Enter a position
await sim2.tick({
  slug: "mkt-1", priceToBeat: 100000, btcPrice: 100100,
  rec: { action: "ENTER", side: "UP", phase: "EARLY", reason: "test" },
  modelUp: 0.7, modelDown: 0.3, marketUp: 0.5, marketDown: 0.5,
  timeLeftMin: 4, dataValues: new Array(20).fill(""),
});
// Slug change → settles position → would call _logTrade
await sim2.tick({
  slug: "mkt-2", priceToBeat: 100000, btcPrice: 100100,
  rec: { action: "NO_TRADE", side: null, phase: "EARLY", reason: "test" },
  modelUp: 0.5, modelDown: 0.5, marketUp: 0.5, marketDown: 0.5,
  timeLeftMin: 4, dataValues: new Array(20).fill(""),
});
sim2.flushNow();

assert.equal(fs.existsSync(tradesCsv2), false,
  `trades CSV must STILL not exist after a settle-driven exit: ${tradesCsv2}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("OK dryRun disableTradesJournal");
