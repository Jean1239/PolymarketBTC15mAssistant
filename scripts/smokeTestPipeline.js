import assert from "node:assert/strict";
import fs from "node:fs";
import { runPipeline5m } from "../src/backtest/pipeline5m.js";
import { CONFIG } from "../src/config5m.js";

const FIXTURE = "./test/fixtures/pipeline5m-golden.jsonl";
const TOL = 1e-9; // tolerância de float

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

function closeEnough(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= TOL;
  return a === b;
}

const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").filter(Boolean);
assert.ok(lines.length > 0, "fixture não vazio");

let checked = 0;
for (const line of lines) {
  const { ctx, result } = JSON.parse(line);
  const got = runPipeline5m(ctx, pipelineConfig);

  assert.equal(got.rec.action, result.rec.action, `rec.action tick ${checked}`);
  assert.equal(got.rec.side ?? null, result.rec.side ?? null, `rec.side tick ${checked}`);
  assert.equal(got.rec.reason ?? null, result.rec.reason ?? null, `rec.reason tick ${checked}`);
  assert.ok(closeEnough(got.modelUp, result.modelUp), `modelUp tick ${checked}`);
  assert.ok(closeEnough(got.modelDown, result.modelDown), `modelDown tick ${checked}`);
  assert.ok(closeEnough(got.edgeUp, result.edgeUp), `edgeUp tick ${checked}`);
  assert.ok(closeEnough(got.edgeDown, result.edgeDown), `edgeDown tick ${checked}`);
  checked++;
}

console.log(`OK golden pipeline5m — ${checked} ticks reproduzidos`);
