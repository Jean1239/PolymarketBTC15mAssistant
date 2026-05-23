/**
 * Smoke test: createRealTradeLogger must emit config_hash as the last column.
 *
 * Run: node scripts/smokeTestRealTradeLog.js
 * Expected output: "OK real trade log config_hash"
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRealTradeLogger } from "../src/trading/realTradeLog.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-"));
const csv = path.join(tmp, "real_trades.csv");

const log = createRealTradeLogger(csv, { configHash: "abc123" });

// recordEntry matches the actual API in realTradeLog.js
log.recordEntry({
  side: "UP",
  marketSlug: "btc-up-or-down-15m-2026-05-22T00:00:00Z",
  entryPrice: 0.505,
  invested: 5,
  shares: 9.9,
  timestamp: new Date("2026-05-22T10:00:00Z").getTime(),
  ptbAtEntry: 67000,
  btcAtEntry: 67050,
  marketUpAtEntry: 0.505,
  marketDownAtEntry: 0.495,
  txHash: "0xabc",
});

// recordExit matches the actual API in realTradeLog.js
log.recordExit({
  exitPrice: 1.0,
  pnl: 4.5,
  roi: 90,
  exitReason: "SETTLED_WIN",
  timestamp: new Date("2026-05-22T10:15:00Z").getTime(),
  txHash: null,
});

const content = fs.readFileSync(csv, "utf8").trim().split("\n");
assert.ok(content[0].endsWith(",config_hash"), `header should end with ,config_hash — got: ${content[0]}`);
assert.ok(content[1].endsWith(",abc123"), `data row should end with ,abc123 — got: ${content[1]}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("OK real trade log config_hash");
