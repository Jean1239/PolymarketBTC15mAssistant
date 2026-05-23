import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Forçar LOG_ROOT temporário antes de importar paths
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paths-"));
process.env.LOG_ROOT = tmp;

const p = await import("../src/paths.js");

// Subdirs criados no load
for (const dir of ["CAPTURE_DIR", "SIM_DIR", "REAL_DIR", "META_DIR", "ARCHIVE_DIR"]) {
  assert.ok(fs.existsSync(p[dir]), `${dir} criado: ${p[dir]}`);
}

// Cada path nomeado cai no subdir correto
assert.equal(path.dirname(p.signals5m),       p.SIM_DIR);
assert.equal(path.dirname(p.dryrun5m),        p.SIM_DIR);
assert.equal(path.dirname(p.dryrun5mTrades),  p.SIM_DIR);
assert.equal(path.dirname(p.signals15m),      p.SIM_DIR);
assert.equal(path.dirname(p.dryrun15m),       p.SIM_DIR);
assert.equal(path.dirname(p.dryrun15mTrades), p.SIM_DIR);
assert.equal(path.dirname(p.ticks5m),         p.REAL_DIR);
assert.equal(path.dirname(p.ticks15m),        p.REAL_DIR);
assert.equal(path.dirname(p.real5mTrades),    p.REAL_DIR);
assert.equal(path.dirname(p.real15mTrades),   p.REAL_DIR);
assert.equal(path.dirname(p.tradeOrdersLog),  p.REAL_DIR);
assert.equal(path.dirname(p.tradeErrorsLog),  p.REAL_DIR);
assert.equal(path.dirname(p.orderbook5m),     p.CAPTURE_DIR);
assert.equal(path.dirname(p.orderbook15m),    p.CAPTURE_DIR);
assert.equal(path.dirname(p.pipelineTrace),   p.CAPTURE_DIR);
assert.equal(path.dirname(p.strategyVersions5m),  p.META_DIR);
assert.equal(path.dirname(p.strategyVersions15m), p.META_DIR);

// LOG_ROOT respeitado
assert.equal(p.LOG_ROOT, tmp);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("OK paths");
